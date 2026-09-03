import { Router } from "express";
import { AppError } from "../../errors.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { getUrlById } from "../urls/urls.service.js";
import { getActiveUrlIdsForUser, runCheckForUrl, runChecksForUrls } from "./checks.service.js";

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

    const check = await runCheckForUrl(url.id);
    res.status(200).json({ check });
  }),
);

checksRouter.post(
  "/check-all",
  asyncHandler(async (req, res) => {
    const urlIds = await getActiveUrlIdsForUser(req.user!.id);

    const startedAt = performance.now();
    const results = await runChecksForUrls(urlIds);
    const durationMs = Math.round(performance.now() - startedAt);

    let up = 0;
    let down = 0;
    for (const result of results) {
      // A rejected settle means the check itself failed to run (e.g. the row
      // vanished mid-run); count it as down so total always equals up + down.
      if (result.status === "fulfilled" && result.value.status === "UP") {
        up += 1;
      } else {
        down += 1;
      }
    }

    res.status(200).json({ total: urlIds.length, up, down, durationMs });
  }),
);
