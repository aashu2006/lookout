import { z } from "zod";

export const urlStatsQuerySchema = z.object({
  window: z.enum(["24h", "7d", "30d"]).default("24h"),
});

export const summaryQuerySchema = z.object({
  // Only honoured for ADMIN users; ignored for everyone else (enforced in the route).
  all: z.coerce.boolean().optional(),
});

export type UrlStatsQuery = z.infer<typeof urlStatsQuerySchema>;
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
