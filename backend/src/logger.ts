import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { config } from "./config.js";

/** Base logger. Inside a request or job, use getLogger() instead so the log
 * lines carry reqId. */
export const logger = pino({
  level: config.logLevel,
  transport: config.logPretty
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

const loggerStore = new AsyncLocalStorage<pino.Logger>();

/** Runs `fn` with `child` as the current logger, so anything it calls can get
 * it from getLogger() without passing it around. */
export function runWithLogger<T>(child: pino.Logger, fn: () => T): T {
  return loggerStore.run(child, fn);
}

/** The request- or job-scoped logger if there is one, else the base logger. */
export function getLogger(): pino.Logger {
  return loggerStore.getStore() ?? logger;
}
