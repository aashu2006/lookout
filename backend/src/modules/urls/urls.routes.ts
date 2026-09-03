import { Router } from "express";
import { AppError } from "../../errors.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth } from "../auth/auth.middleware.js";
import {
  bulkCreateUrlsSchema,
  checksQuerySchema,
  createUrlSchema,
  listUrlsQuerySchema,
  patchUrlSchema,
  type ChecksQuery,
  type CreateUrlInput,
  type ListUrlsQuery,
  type PatchUrlInput,
} from "./urls.schemas.js";
import {
  bulkCreateUrls,
  createUrl,
  deleteUrl,
  getUrlById,
  listChecksForUrl,
  listUrls,
  updateUrl,
} from "./urls.service.js";

export const urlsRouter = Router();

urlsRouter.use(requireAuth);

urlsRouter.post(
  "/",
  validate(createUrlSchema),
  asyncHandler(async (req, res) => {
    const url = await createUrl(req.user!.id, req.body as CreateUrlInput);
    res.status(201).json({ url });
  }),
);

urlsRouter.post(
  "/bulk",
  validate(bulkCreateUrlsSchema),
  asyncHandler(async (req, res) => {
    const result = await bulkCreateUrls(req.user!.id, req.body as string[]);
    res.status(200).json(result);
  }),
);

urlsRouter.get(
  "/",
  validate(listUrlsQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const result = await listUrls(req.user!, res.locals.query as ListUrlsQuery);
    res.status(200).json(result);
  }),
);

urlsRouter.get(
  "/:id/checks",
  validate(checksQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { limit } = res.locals.query as ChecksQuery;
    const items = await listChecksForUrl(req.user!, req.params.id, limit);
    res.status(200).json({ items });
  }),
);

urlsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const url = await getUrlById(req.user!, req.params.id);
    if (!url) {
      throw new AppError(404, "not_found", "URL not found");
    }
    res.status(200).json({ url });
  }),
);

urlsRouter.patch(
  "/:id",
  validate(patchUrlSchema),
  asyncHandler(async (req, res) => {
    const url = await updateUrl(req.user!, req.params.id, req.body as PatchUrlInput);
    res.status(200).json({ url });
  }),
);

urlsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteUrl(req.user!, req.params.id);
    res.status(204).send();
  }),
);
