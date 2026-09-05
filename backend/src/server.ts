import { config } from "./config.js";
import { logger } from "./logger.js";

// This must be the first thing the process prints. Only config and logger are
// imported statically, and both are pure, so reaching this line proves the
// process started and the environment parsed.
logger.info(
  { port: config.port, nodeEnv: config.nodeEnv, logLevel: config.logLevel },
  "starting",
);

// ./app.js is loaded dynamically on purpose. Static imports are all evaluated
// before the module body runs, so a static `import { app } from "./app.js"`
// would put the whole route/Prisma/queue graph ahead of the "starting" line
// above: anything slow or stuck in there would produce total silence, with no
// way to tell a hung import from a process that never launched. Loading it here
// means a hang is bracketed by "starting" and the absence of "listening".
const { app } = await import("./app.js").catch((err: unknown) => {
  logger.fatal({ err }, "failed to load the application");
  process.exit(1);
});

// No host argument on purpose: Node then binds the unspecified address (::),
// which accepts both IPv6 and IPv4-mapped connections. Passing "0.0.0.0" would
// be narrower, not wider — it would drop IPv6, which some platforms (Railway)
// use for private networking. PORT comes from the environment, which is how
// hosted platforms tell the process where to listen.
//
// listen() is called before any Redis, Prisma or queue work. Those connect in
// the background, so /health answers (with db/redis "error") instead of the
// port staying silent while a datastore is unreachable.
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "listening");
});

// A failed bind — port already taken, address unavailable — is emitted here
// rather than thrown. Without a listener it would be an uncaught exception with
// no context about which port was being claimed.
server.on("error", (err) => {
  logger.fatal({ err, port: config.port }, "server failed to listen");
  process.exit(1);
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
