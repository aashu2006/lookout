import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** BullMQ needs maxRetriesPerRequest: null so its blocking commands never get
 * cut off mid-wait. */
export function createRedisConnection(name = "shared"): Redis {
  // Connects in the background, so the api can start even if Redis is down.
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    ...(config.redisFamily === undefined ? {} : { family: config.redisFamily }),
  });

  // ioredis retries forever and errors on every attempt. Log the first error
  // loudly, the rest at debug, and reset once it reconnects.
  let outageReported = false;

  connection.on("ready", () => {
    outageReported = false;
    logger.info({ redis: name, family: config.redisFamily ?? "default" }, "redis connected");
  });

  // Without an error listener Node would crash the process on a Redis outage.
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
  // With maxRetriesPerRequest: null a ping waits forever while Redis is down,
  // so race it against a timer.
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
