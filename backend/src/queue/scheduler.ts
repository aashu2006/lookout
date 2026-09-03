import type { Url } from "@prisma/client";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { CHECK_JOB_NAME, checkQueue } from "./checkQueue.js";

/** One scheduler per URL, keyed so it can be found again without extra state. */
export function schedulerIdFor(urlId: string): string {
  return `url:${urlId}`;
}

/** Idempotent: upsert re-points an existing scheduler at the new interval
 * rather than stacking a second one. */
export async function scheduleUrl(url: Pick<Url, "id" | "intervalSeconds">): Promise<void> {
  await checkQueue.upsertJobScheduler(
    schedulerIdFor(url.id),
    { every: url.intervalSeconds * 1000 },
    { name: CHECK_JOB_NAME, data: { urlId: url.id, trigger: "scheduled" } },
  );
}

export async function unscheduleUrl(urlId: string): Promise<void> {
  await checkQueue.removeJobScheduler(schedulerIdFor(urlId));
}

/**
 * Makes Redis match the database: every active URL gets a scheduler, and any
 * scheduler without a matching active URL is dropped. The DB is the source of
 * truth, so a crash mid-write, a manual DB edit, or a flushed Redis all heal on
 * the next boot.
 */
export async function reconcileSchedules(): Promise<{ scheduled: number; removed: number }> {
  const active = await prisma.url.findMany({
    where: { isActive: true },
    select: { id: true, intervalSeconds: true },
  });

  for (const url of active) {
    await scheduleUrl(url);
  }

  const expected = new Set(active.map((url) => schedulerIdFor(url.id)));
  const existing = await checkQueue.getJobSchedulers(0, -1);

  let removed = 0;
  for (const scheduler of existing) {
    if (!expected.has(scheduler.key)) {
      await checkQueue.removeJobScheduler(scheduler.key);
      removed += 1;
    }
  }

  const counts = { scheduled: active.length, removed };
  logger.info(counts, "reconciled job schedulers");
  return counts;
}
