import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * BullMQ requires maxRetriesPerRequest: null — its blocking commands (BRPOPLPUSH,
 * XREAD) must never be aborted part-way through a wait.
 */
export function createRedisConnection(): Redis {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  // ioredis emits 'error' on every failed reconnect attempt; without a listener
  // Node would treat it as an unhandled error event and kill the process, so a
  // Redis outage must not take the API down with it. Debug level: it repeats on
  // every retry while Redis is unreachable.
  connection.on("error", (err) => logger.debug({ err }, "redis connection error"));
  return connection;
}

/** Shared connection used by the Queue and by health pings. */
export const redis = createRedisConnection();

export async function pingRedis(timeoutMs = 1000): Promise<boolean> {
  // With maxRetriesPerRequest: null a command issued while Redis is down waits
  // in the offline queue indefinitely rather than rejecting — /health would hang
  // instead of reporting. Race the ping against a short timer.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("redis ping timed out")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
