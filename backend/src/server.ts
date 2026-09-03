import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
