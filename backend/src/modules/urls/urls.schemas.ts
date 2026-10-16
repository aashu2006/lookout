import { z } from "zod";

const intervalSeconds = z
  .number()
  .int("intervalSeconds must be an integer")
  .min(60, "intervalSeconds must be at least 60")
  .max(86400, "intervalSeconds must be at most 86400");

// Actual URL syntax validation lives in normalizeUrl() so single-create and bulk
// import share one source of truth; here we only require a non-empty string.
export const createUrlSchema = z.object({
  url: z.string().min(1, "url is required"),
  intervalSeconds: intervalSeconds.default(300),
});

export const patchUrlSchema = z.object({
  intervalSeconds: intervalSeconds.optional(),
  isActive: z.boolean().optional(),
});

// Accepts either { urls: [...] } or a bare JSON array of strings, normalizing
// both to a plain string[] for the handler.
export const bulkCreateUrlsSchema = z
  .union([
    z.object({ urls: z.array(z.string()).max(100, "at most 100 URLs per request") }),
    z.array(z.string()).max(100, "at most 100 URLs per request"),
  ])
  .transform((input) => (Array.isArray(input) ? input : input.urls));

export const listUrlsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["active", "inactive"]).optional(),
  // Only honoured for ADMIN users; ignored for everyone else (enforced in the service).
  // Not z.coerce.boolean(), because Boolean("false") is true.
  all: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
});

export const checksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export type CreateUrlInput = z.infer<typeof createUrlSchema>;
export type PatchUrlInput = z.infer<typeof patchUrlSchema>;
export type ListUrlsQuery = z.infer<typeof listUrlsQuerySchema>;
export type ChecksQuery = z.infer<typeof checksQuerySchema>;
