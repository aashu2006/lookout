import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";

export type StatsWindow = "24h" | "7d" | "30d";

export interface SeriesPoint {
  t: Date;
  totalChecks: number;
  failures: number;
  avgMs: number | null;
  p95Ms: number | null;
}

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

export async function getUrlStats(urlId: string, window: StatsWindow): Promise<UrlStats> {
  const since = new Date(Date.now() - WINDOW_MS[window]);

  const [aggregate, series] =
    window === "24h"
      ? await Promise.all([aggregateFromChecks(urlId, since), seriesFromChecks(urlId, since)])
      : await Promise.all([aggregateFromRollup(urlId, since), seriesFromRollup(urlId, since)]);

  return {
    window,
    totalChecks: aggregate.totalChecks,
    failures: aggregate.failures,
    uptimePct: uptimePctOf(aggregate.totalChecks, aggregate.failures),
    avgMs: aggregate.avgMs === null ? null : round2(aggregate.avgMs),
    p95Ms: aggregate.p95Ms,
    series,
  };
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

/**
 * 7d and 30d read url_stats_hourly rather than raw checks — this is exactly what
 * the rollup table is for. A 30d window on a 60s-interval URL is ~43k check rows
 * to scan and sort per request; the rollup answers it from ~720 pre-aggregated
 * ones, and the cost stays flat as check volume grows.
 */
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
      -- Weighted by checks per hour so long/short hours count proportionally.
      -- Slightly approximate: avg_ms covers only checks that returned a timing,
      -- while total_checks also counts failures with a null response_ms.
      (sum(avg_ms * total_checks) / nullif(sum(total_checks), 0))::double precision AS "avgMs",
      -- A true p95 cannot be recovered from per-hour p95s without the underlying
      -- samples; the worst hourly p95 is the honest conservative summary.
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
    // Latest check per URL: one LATERAL lookup per URL, each an index seek into
    // checks_url_id_checked_at_idx that stops at the first row (LIMIT 1).
    //
    // This replaces a DISTINCT ON (url_id) ... ORDER BY url_id, checked_at DESC.
    // DISTINCT ON does use that index, but only to read it *in order* — it walks
    // every entry for the scoped URLs and discards all but the first of each
    // group, so its cost grows with total check volume. Measured on 60 URLs /
    // 120k checks: DISTINCT ON 50.4ms scanning 120,009 index rows (121k buffer
    // hits) vs LATERAL 0.51ms doing 60 seeks (240 buffer hits). The gap widens
    // as history accumulates, and dashboard load is the hottest read we have.
    //
    // The LEFT JOIN also makes "never checked" explicit as a NULL status,
    // instead of inferring pending from a row-count difference.
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
      WHERE ${scope}
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
