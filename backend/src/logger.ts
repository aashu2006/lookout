import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { config } from "./config.js";

/** Process-wide base logger. Use getLogger() in code that may run inside a
 * request or a job, so the correlated child is picked up automatically. */
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

/**
 * Runs `fn` with `child` as the ambient logger. Everything awaited underneath —
 * route handlers, service calls, Prisma event handlers — sees it via getLogger()
 * without threading a logger through every signature.
 */
export function runWithLogger<T>(child: pino.Logger, fn: () => T): T {
  return loggerStore.run(child, fn);
}

/** The request- or job-scoped logger if there is one, else the base logger. */
export function getLogger(): pino.Logger {
  return loggerStore.getStore() ?? logger;
}
