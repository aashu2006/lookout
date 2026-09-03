// Separate process from the API (src/server.ts). The API only ever *enqueues*
// jobs — it never constructs a Worker — so HTTP latency is never affected by a
// slow site, and checks keep running even while the API is redeploying. Run it
// with `npm run worker` (dev) or `npm run start:worker` (built).
import { Worker } from "bullmq";
import "./bigintJson.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { runCheckForUrl } from "./modules/checks/checks.service.js";
import { CHECK_QUEUE_NAME, queueEvents, type CheckJobData } from "./queue/checkQueue.js";
import { createRedisConnection, redis } from "./queue/connection.js";
import { reconcileSchedules } from "./queue/scheduler.js";

const connection = createRedisConnection();

const worker = new Worker<CheckJobData>(
  CHECK_QUEUE_NAME,
  async (job) => {
    // A DOWN result is a SUCCESSFUL job. The check ran, we learned the site is
    // down, and the row is recorded — that is the job doing its job. Only
    // infrastructure faults (Postgres unreachable, the url row gone) throw and
    // therefore retry with backoff.
    //
    // Treating DOWN as a job failure would be actively wrong: BullMQ would retry
    // it 3x per interval, hammering a site that is already struggling, and each
    // attempt would write another DOWN row, inflating the outage in the history
    // and in any uptime percentage computed from it.
    return runCheckForUrl(job.data.urlId);
  },
  { connection, concurrency: config.checkConcurrency },
);

worker.on("ready", () => {
  logger.info(
    { queue: CHECK_QUEUE_NAME, concurrency: config.checkConcurrency },
    "worker ready",
  );
});

worker.on("completed", (job) => {
  logger.info(
    {
      jobId: job.id,
      urlId: job.data.urlId,
      trigger: job.data.trigger,
      attemptsMade: job.attemptsMade,
      durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
    },
    "job completed",
  );
});

worker.on("failed", (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      urlId: job?.data.urlId,
      trigger: job?.data.trigger,
      attemptsMade: job?.attemptsMade,
      durationMs: job?.finishedOn && job?.processedOn ? job.finishedOn - job.processedOn : null,
      err,
    },
    "job failed",
  );
});

worker.on("error", (err) => logger.error({ err }, "worker error"));

// Bring Redis in line with the database before processing anything.
await reconcileSchedules();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");

  try {
    // close() waits for in-flight jobs to finish before releasing the lock.
    await worker.close();
    await queueEvents.close();
    await connection.quit();
    await redis.quit();
    await prisma.$disconnect();
    logger.info("worker shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during worker shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
