import { Queue, QueueEvents } from "bullmq";
import { logger } from "../logger.js";
import { createRedisConnection, redis } from "./connection.js";

export const CHECK_QUEUE_NAME = "checks";
export const CHECK_JOB_NAME = "check";

export interface CheckJobData {
  urlId: string;
  trigger: "scheduled" | "manual";
  /** Correlation id of the request that enqueued this job, when there was one.
   * Scheduled jobs have no originating request and leave it undefined. */
  reqId?: string;
}

export const checkQueue = new Queue<CheckJobData>(CHECK_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    // Keep only a recent window of finished jobs so Redis memory stays bounded.
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/**
 * Shared QueueEvents, used by the manual-check endpoint to await a specific job.
 * It needs its own connection: QueueEvents holds a blocking XREAD open, which
 * would monopolise a connection shared with the Queue.
 */
export const queueEvents = new QueueEvents(CHECK_QUEUE_NAME, {
  connection: createRedisConnection("queue-events"),
});

// Both constructors return immediately and connect in the background, so
// importing this module never blocks startup. They are also EventEmitters that
// emit 'error' in their own right, separate from the ioredis connection under
// them: an unlistened 'error' would be an uncaught exception. Debug level
// because these repeat for the length of an outage, which connection.ts already
// reports once at error level.
checkQueue.on("error", (err) => logger.debug({ err }, "check queue error"));
queueEvents.on("error", (err) => logger.debug({ err }, "queue events error"));
