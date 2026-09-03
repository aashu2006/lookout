import express, { type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

export const app = express();

app.use(express.json());
app.use(pinoHttp({ logger }));

app.get("/health", async (req: Request, res: Response) => {
  let db: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    db = "error";
    req.log.error({ err }, "health check: db unreachable");
  }

  res.status(db === "ok" ? 200 : 503).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    db,
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Central error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
  const message = err instanceof Error ? err.message : "Internal Server Error";

  req.log.error({ err }, "request failed");

  res.status(status).json({ error: message });
});
