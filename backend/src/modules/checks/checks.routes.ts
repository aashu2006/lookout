import { Router } from "express";
import { AppError } from "../../errors.js";
import { getLogger } from "../../logger.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { CHECK_JOB_NAME, checkQueue, queueEvents } from "../../queue/checkQueue.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { getUrlById } from "../urls/urls.service.js";
import { getActiveUrlIds } from "./checks.service.js";

/** How long the synchronous manual check waits before handing back a job id. */
const MANUAL_CHECK_TIMEOUT_MS = 15000;

export const checksRouter = Router();

checksRouter.use(requireAuth);

checksRouter.post(
  "/:id/check",
  asyncHandler(async (req, res) => {
    // Reuses the urls service resolver so ownership/admin rules live in one place;
    // a URL owned by someone else 404s rather than 403s, as elsewhere.
    const url = await getUrlById(req.user!, req.params.id);
    if (!url) {
      throw new AppError(404, "not_found", "URL not found");
    }

    // priority 1 (highest) so a person waiting on a response jumps the queue
    // ahead of the scheduled backlog.
    const job = await checkQueue.add(
      CHECK_JOB_NAME,
      { urlId: url.id, trigger: "manual", reqId: String(req.id) },
      { priority: 1 },
    );
    getLogger().info({ jobId: job.id, urlId: url.id, trigger: "manual" }, "check job enqueued");

    try {
      const check = await job.waitUntilFinished(queueEvents, MANUAL_CHECK_TIMEOUT_MS);
      res.status(200).json({ check });
    } catch (err) {
      // waitUntilFinished rejects both when we give up waiting and when the job
      // itself failed; only the former is a "still queued" answer.
      const state = await job.getState();
      if (state === "failed") {
        throw new AppError(502, "check_failed", "The check job failed to run");
      }
      res.status(202).json({ jobId: job.id, message: "queued" });
    }
  }),
);

checksRouter.post(
  "/check-all",
  asyncHandler(async (req, res) => {
    // ?all=true checks every user's URLs, same as the list. Admins only.
    const user = req.user!;
    const wantsAll = req.query.all === "true" || req.query.all === "1";
    const urlIds = await getActiveUrlIds(user.id, { all: wantsAll && user.role === "ADMIN" });

    if (urlIds.length > 0) {
      await checkQueue.addBulk(
        urlIds.map((urlId) => ({
          name: CHECK_JOB_NAME,
          data: { urlId, trigger: "manual" as const, reqId: String(req.id) },
        })),
      );
      getLogger().info({ count: urlIds.length, trigger: "manual" }, "check jobs enqueued");
    }

    // Fire and forget: results land in the check history as the worker drains them.
    res.status(202).json({ enqueued: urlIds.length });
  }),
);
