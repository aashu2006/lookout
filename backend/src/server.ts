import { config } from "./config.js";
import { logger } from "./logger.js";

// First log line. Only config and logger are loaded so far, so seeing this
// means the process started and the env parsed fine.
logger.info(
  { port: config.port, nodeEnv: config.nodeEnv, logLevel: config.logLevel },
  "starting",
);

// app.js is imported dynamically so if loading it hangs, you see "starting"
// with no "listening" instead of no logs at all.
const { app } = await import("./app.js").catch((err: unknown) => {
  logger.fatal({ err }, "failed to load the application");
  process.exit(1);
});

// No host, so Node listens on :: and accepts both IPv4 and IPv6.
// This runs before any Redis or Prisma work, so /health still answers when
// they're down.
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "listening");
});

// A failed bind (port taken etc.) comes through here, not as a throw.
server.on("error", (err) => {
  logger.fatal({ err, port: config.port }, "server failed to listen");
  process.exit(1);
});

// EMBED_WORKER runs the worker in this process (Render free tier). It starts
// after listen() and isn't awaited. If it can't start we exit, so the host
// restarts us instead of running an api that checks nothing.
let closeWorker: (() => Promise<void>) | undefined;

if (config.embedWorker) {
  void import("./worker.js")
    .then((worker) => {
      closeWorker = worker.closeWorker;
      logger.info("embedded worker started");
    })
    .catch((err: unknown) => {
      logger.fatal({ err }, "embedded worker failed to start");
      process.exit(1);
    });
}

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
    // Requests are done, now let running jobs finish and close connections.
    void (closeWorker?.() ?? Promise.resolve())
      .catch((closeErr: unknown) => logger.error({ err: closeErr }, "error closing worker"))
      .finally(() => {
        logger.info("shutdown complete");
        process.exit(0);
      });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
