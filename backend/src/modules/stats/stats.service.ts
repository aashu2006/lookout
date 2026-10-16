import { Prisma, type Url } from "@prisma/client";
import { prisma } from "../../db.js";
import { fillSeries, slotSizeMs, type SeriesPoint } from "./series.js";

export type StatsWindow = "24h" | "7d" | "30d";

export interface UrlStats {
  window: StatsWindow;
  totalChecks: number;
  failures: number;
  uptimePct: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  series: SeriesPoint[];
}

export interface DashboardSummary {
  totalUrls: number;
  activeUrls: number;
  up: number;
  down: number;
  pending: number;
  uptimePct24h: number | null;
  failures24h: number;
  avgMs24h: number | null;
}

interface AggregateRow {
  totalChecks: number;
  failures: number;
  avgMs: number | null;
  p95Ms: number | null;
}

const WINDOW_MS: Record<StatsWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function uptimePctOf(totalChecks: number, failures: number): number | null {
  if (totalChecks === 0) {
    return null;
  }
  return round2(((totalChecks - failures) / totalChecks) * 100);
}

/** Slot size each window's query returns, before fillSeries widens it. */
const BASE_SLOT_MS: Record<StatsWindow, number> = {
  "24h": 15 * 60 * 1000,
  "7d": 60 * 60 * 1000,
  "30d": 60 * 60 * 1000,
};

export async function getUrlStats(
  url: Pick<Url, "id" | "intervalSeconds" | "createdAt">,
  window: StatsWindow,
): Promise<UrlStats> {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_MS[window]);

  const [aggregate, points] =
    window === "24h"
      ? await Promise.all([aggregateFromChecks(url.id, since), seriesFromChecks(url.id, since)])
      : await Promise.all([aggregateFromRollup(url.id, since), seriesFromRollup(url.id, since)]);

  return {
    window,
    totalChecks: aggregate.totalChecks,
    failures: aggregate.failures,
    uptimePct: uptimePctOf(aggregate.totalChecks, aggregate.failures),
    avgMs: aggregate.avgMs === null ? null : round2(aggregate.avgMs),
    p95Ms: aggregate.p95Ms,
    series: withGaps(points, url, window, since, now),
  };
}

function withGaps(
  points: SeriesPoint[],
  url: Pick<Url, "intervalSeconds" | "createdAt">,
  window: StatsWindow,
  since: Date,
  now: Date,
): SeriesPoint[] {
  if (points.length === 0) {
    return [];
  }
  const slotMs = slotSizeMs(BASE_SLOT_MS[window], url.intervalSeconds);
  // Start at the first slot fully inside the window, otherwise the edge slot
  // looks empty when its check landed just before `since`.
  const windowStart = Math.ceil(since.getTime() / slotMs) * slotMs;
  // And don't draw empty days from before the URL existed. Seeded URLs have
  // history older than createdAt, so the first point counts too.
  const firstSeen = Math.min(url.createdAt.getTime(), points[0].t.getTime());
  const firstSlot = Math.floor(firstSeen / slotMs) * slotMs;

  const filled = fillSeries(points, new Date(Math.max(windowStart, firstSlot)), now, slotMs);
  return filled.some((point) => point.totalChecks > 0) ? filled : [];
}

/** 24h reads raw checks: the window is small and 15-minute buckets are finer
 * than the hourly rollup can express. */
async function seriesFromChecks(urlId: string, since: Date): Promise<SeriesPoint[]> {
  return prisma.$queryRaw<SeriesPoint[]>`
    SELECT
      date_trunc('hour', checked_at)
        + floor(extract(minute FROM checked_at) / 15) * interval '15 minutes' AS "t",
      count(*)::int AS "totalChecks",
      count(*) FILTER (WHERE status = 'DOWN')::int AS "failures",
      avg(response_ms)::double precision AS "avgMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms::double precision)::int AS "p95Ms"
    FROM checks
    WHERE url_id = ${urlId} AND checked_at >= ${since}
    GROUP BY 1
    ORDER BY 1
  `;
}

async function aggregateFromChecks(urlId: string, since: Date): Promise<AggregateRow> {
  const [row] = await prisma.$queryRaw<AggregateRow[]>`
    SELECT
      count(*)::int AS "totalChecks",
      count(*) FILTER (WHERE status = 'DOWN')::int AS "failures",
      avg(response_ms)::double precision AS "avgMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms::double precision)::int AS "p95Ms"
    FROM checks
    WHERE url_id = ${urlId} AND checked_at >= ${since}
  `;
  return row ?? { totalChecks: 0, failures: 0, avgMs: null, p95Ms: null };
}

/** 7d and 30d read the hourly rollup instead of raw checks, so they stay fast
 * as history grows. */
async function seriesFromRollup(urlId: string, since: Date): Promise<SeriesPoint[]> {
  return prisma.$queryRaw<SeriesPoint[]>`
    SELECT
      hour AS "t",
      total_checks AS "totalChecks",
      failures AS "failures",
      avg_ms AS "avgMs",
      p95_ms AS "p95Ms"
    FROM url_stats_hourly
    WHERE url_id = ${urlId} AND hour >= ${since}
    ORDER BY hour
  `;
}

async function aggregateFromRollup(urlId: string, since: Date): Promise<AggregateRow> {
  const [row] = await prisma.$queryRaw<AggregateRow[]>`
    SELECT
      coalesce(sum(total_checks), 0)::int AS "totalChecks",
      coalesce(sum(failures), 0)::int AS "failures",
      -- Weighted by checks per hour. Slightly off, since total_checks also counts
      -- failures that have no timing.
      (sum(avg_ms * total_checks) / nullif(sum(total_checks), 0))::double precision AS "avgMs",
      -- Can't get a real p95 back from hourly p95s, so use the worst hour.
      max(p95_ms)::int AS "p95Ms"
    FROM url_stats_hourly
    WHERE url_id = ${urlId} AND hour >= ${since}
  `;
  return row ?? { totalChecks: 0, failures: 0, avgMs: null, p95Ms: null };
}

export async function getSummary(
  userId: string,
  opts: { all: boolean },
): Promise<DashboardSummary> {
  const urlWhere = opts.all ? {} : { userId };
  // Admin-wide view drops the owner filter; everyone else is scoped to their own.
  const scope = opts.all ? Prisma.sql`TRUE` : Prisma.sql`u.user_id = ${userId}`;

  const [totalUrls, activeUrls, latest, aggregate] = await Promise.all([
    prisma.url.count({ where: urlWhere }),
    prisma.url.count({ where: { ...urlWhere, isActive: true } }),
    // Latest check per URL. LATERAL + LIMIT 1 is one index seek per URL, way
    // faster than DISTINCT ON, which reads every check for those URLs.
    // A URL with no checks yet comes back with a NULL status. Paused URLs are
    // left out so up/down/pending match what the table shows.
    prisma.$queryRaw<{ status: "UP" | "DOWN" | null }[]>`
      SELECT latest.status
      FROM urls u
      LEFT JOIN LATERAL (
        SELECT c.status
        FROM checks c
        WHERE c.url_id = u.id
        ORDER BY c.checked_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE ${scope} AND u.is_active
    `,
    prisma.$queryRaw<AggregateRow[]>`
      SELECT
        count(*)::int AS "totalChecks",
        count(*) FILTER (WHERE c.status = 'DOWN')::int AS "failures",
        avg(c.response_ms)::double precision AS "avgMs",
        NULL::int AS "p95Ms"
      FROM checks c
      JOIN urls u ON u.id = c.url_id
      WHERE ${scope} AND c.checked_at >= now() - interval '24 hours'
    `,
  ]);

  const up = latest.filter((row) => row.status === "UP").length;
  const down = latest.filter((row) => row.status === "DOWN").length;
  const pending = latest.filter((row) => row.status === null).length;
  const totals = aggregate[0] ?? { totalChecks: 0, failures: 0, avgMs: null, p95Ms: null };

  return {
    totalUrls,
    activeUrls,
    up,
    down,
    // A URL with no check row yet has never reported a state.
    pending,
    uptimePct24h: uptimePctOf(totals.totalChecks, totals.failures),
    failures24h: totals.failures,
    avgMs24h: totals.avgMs === null ? null : round2(totals.avgMs),
  };
}

/** Fleet-wide check metrics over the last hour, for the admin metrics endpoint. */
export async function getLastHourCheckMetrics(): Promise<{
  total: number;
  failures: number;
  failureRate: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  perMinute: number;
}> {
  const [row] = await prisma.$queryRaw<AggregateRow[]>`
    SELECT
      count(*)::int AS "totalChecks",
      count(*) FILTER (WHERE status = 'DOWN')::int AS "failures",
      avg(response_ms)::double precision AS "avgMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms::double precision)::int AS "p95Ms"
    FROM checks
    WHERE checked_at >= now() - interval '1 hour'
  `;

  const totals = row ?? { totalChecks: 0, failures: 0, avgMs: null, p95Ms: null };

  return {
    total: totals.totalChecks,
    failures: totals.failures,
    // Fraction of checks that came back DOWN, 0-1.
    failureRate: totals.totalChecks === 0 ? null : round2(totals.failures / totals.totalChecks),
    avgMs: totals.avgMs === null ? null : round2(totals.avgMs),
    p95Ms: totals.p95Ms,
    perMinute: round2(totals.totalChecks / 60),
  };
}
