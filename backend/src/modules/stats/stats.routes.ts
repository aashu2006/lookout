import { Router } from "express";
import { AppError } from "../../errors.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import { checkQueue } from "../../queue/checkQueue.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { getUrlById } from "../urls/urls.service.js";
import { summaryQuerySchema, urlStatsQuerySchema, type SummaryQuery, type UrlStatsQuery } from "./stats.schemas.js";
import { getLastHourCheckMetrics, getSummary, getUrlStats } from "./stats.service.js";

const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

/** Mounted under /api/urls alongside the urls and checks routers. */
export const statsRouter = Router();

statsRouter.use(requireAuth);

statsRouter.get(
  "/:id/stats",
  validate(urlStatsQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const url = await getUrlById(req.user!, req.params.id);
    if (!url) {
      throw new AppError(404, "not_found", "URL not found");
    }

    const { window } = res.locals.query as UrlStatsQuery;
    res.status(200).json(await getUrlStats(url, window));
  }),
);

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get(
  "/summary",
  validate(summaryQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { all } = res.locals.query as SummaryQuery;
    const user = req.user!;
    res.status(200).json(await getSummary(user.id, { all: Boolean(all) && user.role === "ADMIN" }));
  }),
);

export const metricsRouter = Router();

metricsRouter.get(
  "/metrics",
  requireAuth,
  requireRole("ADMIN"),
  asyncHandler(async (_req, res) => {
    const [lastHour, jobCounts] = await Promise.all([
      getLastHourCheckMetrics(),
      checkQueue.getJobCounts(),
    ]);

    const memory = process.memoryUsage();
    const { perMinute, ...lastHourTotals } = lastHour;

    res.status(200).json({
      checks: { lastHour: lastHourTotals, perMinute },
      queue: {
        waiting: jobCounts.waiting ?? 0,
        active: jobCounts.active ?? 0,
        completed: jobCounts.completed ?? 0,
        failed: jobCounts.failed ?? 0,
        delayed: jobCounts.delayed ?? 0,
      },
      process: {
        uptimeSec: Math.round(process.uptime()),
        rssMb: toMb(memory.rss),
        heapUsedMb: toMb(memory.heapUsed),
      },
      timestamp: new Date().toISOString(),
    });
  }),
);
