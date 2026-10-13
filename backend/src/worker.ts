// Separate process from the API (src/server.ts). The API only ever *enqueues*
// jobs — it never constructs a Worker — so HTTP latency is never affected by a
// slow site, and checks keep running even while the API is redeploying. Run it
// with `npm run worker` (dev) or `npm run start:worker` (built).
//
// The one exception is EMBED_WORKER=true, where server.ts imports this module
// into the api process. That gives up the isolation above and exists only for
// hosts with a single free container and no background workers.
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
    // A DOWN result is a SUCCESSFUL job. The check ran, we learned the site is
    // down, and the row is recorded — that is the job doing its job. Only
    // infrastructure faults (Postgres unreachable, the url row gone) throw and
    // therefore retry with backoff.
    //
    // Treating DOWN as a job failure would be actively wrong: BullMQ would retry
    // it 3x per interval, hammering a site that is already struggling, and each
    // attempt would write another DOWN row, inflating the outage in the history
    // and in any uptime percentage computed from it.

    // reqId comes from the request that enqueued this job (manual checks), so a
    // single trace spans the API process and this one. Scheduled jobs have none.
    // urlId is deliberately not bound here: checks.service already logs it, and
    // binding it too emitted the key twice in the same JSON line.
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
  // Serial: these are whole-table statements, and overlapping runs would only
  // contend for the same rows.
  { connection: maintenanceConnection, concurrency: 1 },
);

maintenanceWorker.on("ready", () => {
  logger.info({ queue: MAINTENANCE_QUEUE_NAME }, "maintenance worker ready");
});

maintenanceWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "maintenance job failed");
});

maintenanceWorker.on("error", (err) => logger.error({ err }, "maintenance worker error"));

/** Same reconcile-on-boot pattern as the URL schedulers: this list is the source
 * of truth, and anything else left in Redis is removed. */
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
// Fill in any hours missed while this process was down, so the dashboard is
// current immediately rather than after the first scheduled rollup.
await rollupRecent();

/** Closes everything this module opened, without exiting. Exported so the api
 * can run it as part of its own shutdown when the worker is embedded. */
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

// Embedded, the api owns the signals: it stops accepting requests first and
// then calls closeWorker(). Two sets of handlers would race to process.exit().
if (!config.embedWorker) {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
