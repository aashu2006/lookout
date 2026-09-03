import { Queue, QueueEvents } from "bullmq";
import { createRedisConnection, redis } from "./connection.js";

export const CHECK_QUEUE_NAME = "checks";
export const CHECK_JOB_NAME = "check";

export interface CheckJobData {
  urlId: string;
  trigger: "scheduled" | "manual";
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
  connection: createRedisConnection(),
});
