import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
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
  // eslint-disable-next-line no-console
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
  logLevel: env.LOG_LEVEL,
  logPretty: env.LOG_PRETTY,
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
