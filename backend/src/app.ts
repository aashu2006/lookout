import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import "./bigintJson.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { checksRouter } from "./modules/checks/checks.routes.js";
import {
  dashboardRouter,
  metricsRouter,
  statsRouter,
} from "./modules/stats/stats.routes.js";
import { urlsRouter } from "./modules/urls/urls.routes.js";
import { pingRedis } from "./queue/connection.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: false }));
app.use(express.json());
app.use(pinoHttp({ logger }));

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many requests, please try again later" },
});

app.use("/api/auth", authRateLimiter, authRouter);
// Both share the /api/urls prefix: checksRouter owns POST /:id/check and
// POST /check-all, which don't collide with any urlsRouter route.
app.use("/api/urls", checksRouter);
app.use("/api/urls", statsRouter);
app.use("/api/urls", urlsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api", metricsRouter);

app.get("/health", async (req: Request, res: Response) => {
  let db: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    db = "error";
    req.log.error({ err }, "health check: db unreachable");
  }

  const redis: "ok" | "error" = (await pingRedis()) ? "ok" : "error";
  if (redis === "error") {
    req.log.error("health check: redis unreachable");
  }

  const healthy = db === "ok" && redis === "ok";

  res.status(healthy ? 200 : 503).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    db,
    redis,
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Central error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "Something went wrong" });
});
