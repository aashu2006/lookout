import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// No host argument on purpose: Node then binds the unspecified address (::),
// which accepts both IPv6 and IPv4-mapped connections. Passing "0.0.0.0" would
// be narrower, not wider — it would drop IPv6, which some platforms (Railway)
// use for private networking. PORT comes from the environment, which is how
// hosted platforms tell the process where to listen.
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
