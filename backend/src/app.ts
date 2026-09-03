import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { checksRouter } from "./modules/checks/checks.routes.js";
import { urlsRouter } from "./modules/urls/urls.routes.js";

// Check.id is a Postgres bigint, which Prisma hands back as a JS BigInt, and
// JSON.stringify throws on BigInt values. Serialize them as strings — Number()
// would silently lose precision past 2^53. Applied once, globally, before routes.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};

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
app.use("/api/urls", urlsRouter);

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
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }

  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "Something went wrong" });
});
