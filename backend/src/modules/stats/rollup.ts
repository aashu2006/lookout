import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { logger } from "../../logger.js";

const HOUR_MS = 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 10000;

/** Epoch-ms division truncates to a UTC hour boundary, matching the UTC hours
 * that Postgres date_trunc('hour', ...) produces for our timestamp columns. */
export function startOfHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Recomputes url_stats_hourly for every URL with checks in the given hour, in a
 * single INSERT ... SELECT. Aggregating in Postgres keeps the check rows in the
 * database instead of streaming them into Node, and one upsert statement means
 * no per-URL round trips.
 */
export async function rollupHour(hourStart: Date): Promise<number> {
  const hourEnd = new Date(hourStart.getTime() + HOUR_MS);

  const rows = await prisma.$executeRaw`
    INSERT INTO url_stats_hourly (url_id, hour, total_checks, failures, avg_ms, p95_ms)
    SELECT
      url_id,
      date_trunc('hour', checked_at) AS hour,
      count(*)::int,
      count(*) FILTER (WHERE status = 'DOWN')::int,
      avg(response_ms)::double precision,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms::double precision)::int
    FROM checks
    WHERE checked_at >= ${hourStart} AND checked_at < ${hourEnd}
    GROUP BY url_id, date_trunc('hour', checked_at)
    ON CONFLICT (url_id, hour) DO UPDATE SET
      total_checks = EXCLUDED.total_checks,
      failures = EXCLUDED.failures,
      avg_ms = EXCLUDED.avg_ms,
      p95_ms = EXCLUDED.p95_ms
  `;

  return rows;
}

/**
 * Rolls up the previous full hour and the current partial one, so the dashboard
 * is never more than one rollup interval stale. Re-running is safe: the upsert
 * overwrites the partial hour with a more complete figure each pass.
 */
export async function rollupRecent(): Promise<{ previousHour: number; currentHour: number }> {
  const currentHour = startOfHour(new Date());
  const previousHour = new Date(currentHour.getTime() - HOUR_MS);

  const previous = await rollupHour(previousHour);
  const current = await rollupHour(currentHour);

  const counts = { previousHour: previous, currentHour: current };
  logger.info({ ...counts, hour: currentHour.toISOString() }, "rolled up hourly stats");
  return counts;
}

/**
 * Deletes checks past the retention window in batches, so a long-neglected table
 * never turns into one enormous delete holding locks and bloating WAL.
 */
export async function pruneOldChecks(): Promise<number> {
  const cutoff = new Date(Date.now() - config.checkRetentionDays * 24 * HOUR_MS);

  let removed = 0;
  for (;;) {
    const batch = await prisma.$executeRaw`
      DELETE FROM checks
      WHERE id IN (
        SELECT id FROM checks WHERE checked_at < ${cutoff} ORDER BY checked_at LIMIT ${PRUNE_BATCH_SIZE}
      )
    `;
    removed += batch;
    if (batch === 0) {
      break;
    }
  }

  logger.info(
    { removed, cutoff: cutoff.toISOString(), retentionDays: config.checkRetentionDays },
    "pruned old checks",
  );
  return removed;
}
