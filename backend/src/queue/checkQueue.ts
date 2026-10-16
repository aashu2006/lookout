import { Queue, QueueEvents } from "bullmq";
import { logger } from "../logger.js";
import { createRedisConnection, redis } from "./connection.js";

export const CHECK_QUEUE_NAME = "checks";
export const CHECK_JOB_NAME = "check";

export interface CheckJobData {
  urlId: string;
  trigger: "scheduled" | "manual";
  /** Id of the request that queued this job. Scheduled jobs don't have one. */
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

/** Used by the manual check endpoint to wait on a job. Gets its own connection
 * because it keeps a blocking read open. */
export const queueEvents = new QueueEvents(CHECK_QUEUE_NAME, {
  connection: createRedisConnection("queue-events"),
});

// Without these an 'error' event would crash the process. Debug level because
// connection.ts already logs the outage once at error.
checkQueue.on("error", (err) => logger.debug({ err }, "check queue error"));
queueEvents.on("error", (err) => logger.debug({ err }, "queue events error"));
