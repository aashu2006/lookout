// The worker. Runs as its own process so a slow site never slows down the api.
// Start it with `npm run worker` (dev) or `npm run start:worker` (built).
// With EMBED_WORKER=true, server.ts loads it into the api process instead.
import { Queue, Worker } from "bullmq";
import "./bigintJson.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { logger, runWithLogger } from "./logger.js";
import { runCheckForUrl } from "./modules/checks/checks.service.js";
import { pruneOldChecks, rollupRecent } from "./modules/stats/rollup.js";
import { CHECK_QUEUE_NAME, queueEvents, type CheckJobData } from "./queue/checkQueue.js";
import { createRedisConnection, redis } from "./queue/connection.js";
import { reconcileSchedules } from "./queue/scheduler.js";

const connection = createRedisConnection("worker");

const worker = new Worker<CheckJobData>(
  CHECK_QUEUE_NAME,
  async (job) => {
    // A DOWN site still counts as a successful job. Only real faults (db down,
    // url deleted) throw and retry. Otherwise we'd hit a struggling site 3 times
    // and write 3 DOWN rows for one outage.

    // reqId ties a manual check back to the request that queued it. urlId is
    // left out because checks.service already logs it.
    const jobLogger = logger.child({
      reqId: job.data.reqId,
      jobId: job.id,
      trigger: job.data.trigger,
    });
    return runWithLogger(jobLogger, () => runCheckForUrl(job.data.urlId));
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

// --- Maintenance queue: periodic rollup and retention, worker-side only. ---

const MAINTENANCE_QUEUE_NAME = "maintenance";
const ROLLUP_JOB = "rollup";
const PRUNE_JOB = "prune";

const MAINTENANCE_SCHEDULES = [
  { id: ROLLUP_JOB, every: 5 * 60 * 1000 },
  { id: PRUNE_JOB, every: 24 * 60 * 60 * 1000 },
];

const maintenanceConnection = createRedisConnection("maintenance");

const maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE_NAME,
  async (job) => {
    switch (job.name) {
      case ROLLUP_JOB:
        return runWithLogger(logger.child({ jobId: job.id, job: job.name }), rollupRecent);
      case PRUNE_JOB:
        return runWithLogger(logger.child({ jobId: job.id, job: job.name }), pruneOldChecks);
      default:
        throw new Error(`unknown maintenance job: ${job.name}`);
    }
  },
  // One at a time, these hit the whole table.
  { connection: maintenanceConnection, concurrency: 1 },
);

maintenanceWorker.on("ready", () => {
  logger.info({ queue: MAINTENANCE_QUEUE_NAME }, "maintenance worker ready");
});

maintenanceWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "maintenance job failed");
});

maintenanceWorker.on("error", (err) => logger.error({ err }, "maintenance worker error"));

/** Same idea as the URL schedulers: this list wins, anything else in Redis
 * gets removed. */
async function reconcileMaintenanceSchedules(): Promise<void> {
  for (const schedule of MAINTENANCE_SCHEDULES) {
    await maintenanceQueue.upsertJobScheduler(
      schedule.id,
      { every: schedule.every },
      { name: schedule.id },
    );
  }

  const expected = new Set(MAINTENANCE_SCHEDULES.map((schedule) => schedule.id));
  const existing = await maintenanceQueue.getJobSchedulers(0, -1);

  let removed = 0;
  for (const scheduler of existing) {
    if (!expected.has(scheduler.key)) {
      await maintenanceQueue.removeJobScheduler(scheduler.key);
      removed += 1;
    }
  }

  logger.info(
    { scheduled: MAINTENANCE_SCHEDULES.length, removed },
    "reconciled maintenance schedulers",
  );
}

// Bring Redis in line with the database before processing anything.
await reconcileSchedules();
await reconcileMaintenanceSchedules();
// Catch up on any hours missed while the worker was down.
await rollupRecent();

/** Closes everything this module opened. The api calls it on shutdown when
 * the worker is embedded. */
export async function closeWorker(): Promise<void> {
  // close() waits for in-flight jobs to finish before releasing the lock.
  await worker.close();
  await maintenanceWorker.close();
  await maintenanceQueue.close();
  await queueEvents.close();
  await connection.quit();
  await maintenanceConnection.quit();
  await redis.quit();
  await prisma.$disconnect();
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");

  try {
    await closeWorker();
    logger.info("worker shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during worker shutdown");
    process.exit(1);
  }
}

// When embedded, the api handles signals and calls closeWorker() itself.
if (!config.embedWorker) {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
