import { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "query" },
    { emit: "event", level: "error" },
  ],
});

prisma.$on("query", (event: Prisma.QueryEvent) => {
  logger.debug(
    { query: event.query, params: event.params, durationMs: event.duration },
    "prisma query",
  );
});

prisma.$on("error", (event: Prisma.LogEvent) => {
  logger.error({ message: event.message, target: event.target }, "prisma error");
});
