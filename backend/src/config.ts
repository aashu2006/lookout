import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  // DNS family for Redis. Leave unset normally, set 0 on IPv6-only networks.
  // Not z.coerce.number(), because Number("") is 0 and an empty value would set it.
  REDIS_FAMILY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : undefined))
    .refine(
      (value) => value === undefined || Number.isInteger(value),
      "REDIS_FAMILY must be an integer (0, 4 or 6)",
    ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // Not z.coerce.boolean(), because Boolean("false") is true.
  LOG_PRETTY: z
    .string()
    .default("false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())),
  // Runs the worker inside the api process, for hosts with one container (Render).
  EMBED_WORKER: z
    .string()
    .default("false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  ADMIN_EMAILS: z.string().optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  CHECK_CONCURRENCY: z.coerce.number().int().positive().default(10),
  CHECK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

const adminEmails = new Set(
  (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
);

export const config = {
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  redisFamily: env.REDIS_FAMILY,
  logLevel: env.LOG_LEVEL,
  logPretty: env.LOG_PRETTY,
  embedWorker: env.EMBED_WORKER,
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === "development",
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  adminEmails,
  corsOrigin: env.CORS_ORIGIN,
  checkTimeoutMs: env.CHECK_TIMEOUT_MS,
  checkConcurrency: env.CHECK_CONCURRENCY,
  checkRetentionDays: env.CHECK_RETENTION_DAYS,
} as const;

export type Config = typeof config;
