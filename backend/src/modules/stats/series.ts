export interface SeriesPoint {
  t: Date;
  totalChecks: number;
  failures: number;
  avgMs: number | null;
  p95Ms: number | null;
}

const MINUTE_MS = 60 * 1000;

/** Slot sizes the charts can use. Each one is a multiple of the ones before it,
 * so smaller slots always fit cleanly inside bigger ones. */
const SLOT_SIZES_MS = [15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * MINUTE_MS);

/** Smallest slot that's at least `baseMs` and fits one check interval, so a URL
 * checked every hour doesn't show a fake gap in every 15 minute slot. */
export function slotSizeMs(baseMs: number, intervalSeconds: number): number {
  const wanted = Math.max(baseMs, intervalSeconds * 1000);
  return SLOT_SIZES_MS.find((size) => size >= wanted) ?? SLOT_SIZES_MS[SLOT_SIZES_MS.length - 1];
}

/**
 * Groups points into `slotMs` slots from `from` to `until`, and adds empty slots
 * where nothing was checked. That way the chart shows gaps (paused, worker down)
 * instead of squeezing them out. Averages are weighted by check count and p95 is
 * the worst slot, same as the rollup does.
 */
export function fillSeries(
  points: SeriesPoint[],
  from: Date,
  until: Date,
  slotMs: number,
): SeriesPoint[] {
  const bySlot = new Map<number, SeriesPoint[]>();
  for (const point of points) {
    const key = Math.floor(point.t.getTime() / slotMs) * slotMs;
    const slot = bySlot.get(key);
    if (slot) {
      slot.push(point);
    } else {
      bySlot.set(key, [point]);
    }
  }

  const first = Math.floor(from.getTime() / slotMs) * slotMs;
  const last = Math.floor(until.getTime() / slotMs) * slotMs;

  const filled: SeriesPoint[] = [];
  for (let key = first; key <= last; key += slotMs) {
    filled.push(mergeSlot(new Date(key), bySlot.get(key) ?? []));
  }
  return filled;
}

function mergeSlot(t: Date, points: SeriesPoint[]): SeriesPoint {
  let totalChecks = 0;
  let failures = 0;
  let timedChecks = 0;
  let weightedMs = 0;
  let p95Ms: number | null = null;

  for (const point of points) {
    totalChecks += point.totalChecks;
    failures += point.failures;
    if (point.avgMs !== null) {
      timedChecks += point.totalChecks;
      weightedMs += point.avgMs * point.totalChecks;
    }
    if (point.p95Ms !== null) {
      p95Ms = Math.max(p95Ms ?? 0, point.p95Ms);
    }
  }

  return {
    t,
    totalChecks,
    failures,
    avgMs: timedChecks === 0 ? null : weightedMs / timedChecks,
    p95Ms,
  };
}
