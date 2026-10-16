import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import "./bigintJson.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { AppError } from "./errors.js";
import { logger, runWithLogger } from "./logger.js";
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
app.use(
  pinoHttp({
    logger,
    // Reuse an incoming x-request-id or make a new one, and send it back.
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    customLogLevel: (req, res, err) => {
      // The healthcheck hits /health every few seconds, keep it out of info logs.
      if (req.url === "/health") {
        return "debug";
      }
      if (err || res.statusCode >= 500) {
        return "error";
      }
      if (res.statusCode >= 400) {
        return "warn";
      }
      return "info";
    },
  }),
);

// Everything downstream runs inside the request's logger context, so
// getLogger() in any service returns a child already carrying reqId.
app.use((req: Request, _res: Response, next: NextFunction) => {
  runWithLogger(req.log.child({ reqId: req.id }), next);
});

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

// /health has to answer even if Postgres hangs, so the db ping gets a limit.
// 5s leaves room for Prisma's first connect.
const HEALTH_DB_TIMEOUT_MS = 5000;

app.get("/health", async (req: Request, res: Response) => {
  let db: "ok" | "error" = "ok";
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("db ping timed out")), HEALTH_DB_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    db = "error";
    req.log.error({ err }, "health check: db unreachable");
  } finally {
    clearTimeout(timer);
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
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "Something went wrong" });
});
