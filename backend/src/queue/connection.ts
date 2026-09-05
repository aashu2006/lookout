import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * BullMQ requires maxRetriesPerRequest: null — its blocking commands (BRPOPLPUSH,
 * XREAD) must never be aborted part-way through a wait.
 */
export function createRedisConnection(name = "shared"): Redis {
  // `new Redis(...)` dials in the background and returns straight away. Nothing
  // here waits for a connection, which is what lets the API listen and serve
  // /health while Redis is still unreachable.
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    // Only override ioredis's default lookup family when REDIS_FAMILY is set.
    // Needed on IPv6-only private networks (Railway): family 0 lets the
    // resolver accept the AAAA record that *.railway.internal returns.
    ...(config.redisFamily === undefined ? {} : { family: config.redisFamily }),
  });

  // ioredis retries forever and emits 'error' on every attempt, so logging all
  // of them at error level would bury everything else. Log the first failure of
  // an outage loudly, the rest at debug, and reset once it reconnects. That way
  // production logs show each transition without repeating thousands of times.
  let outageReported = false;

  connection.on("ready", () => {
    outageReported = false;
    logger.info({ redis: name, family: config.redisFamily ?? "default" }, "redis connected");
  });

  // Without an 'error' listener Node treats it as an unhandled error event and
  // kills the process: a Redis outage must not take the API down with it.
  connection.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (outageReported) {
      logger.debug({ redis: name, code, err }, "redis error");
      return;
    }
    outageReported = true;
    logger.error({ redis: name, code, err }, "redis error");
  });

  connection.on("end", () => logger.warn({ redis: name }, "redis connection closed"));

  return connection;
}

/** Shared connection used by the Queue and by health pings. */
export const redis = createRedisConnection("shared");

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
