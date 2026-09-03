import { Prisma, PrismaClient } from "@prisma/client";
import { getLogger } from "./logger.js";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "query" },
    { emit: "event", level: "error" },
  ],
});

prisma.$on("query", (event: Prisma.QueryEvent) => {
  getLogger().debug(
    { query: event.query, params: event.params, durationMs: event.duration },
    "prisma query",
  );
});

prisma.$on("error", (event: Prisma.LogEvent) => {
  getLogger().error({ message: event.message, target: event.target }, "prisma error");
});
