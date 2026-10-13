import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  // Both are passed to Prisma and ioredis exactly as given, so a provider's
  // connection string (credentials, ?sslmode=..., internal hostname) works
  // unmodified.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  // DNS resolution family for the Redis connection. Unset uses ioredis's own
  // default (IPv4). Set to 0 on hosts whose private networking is IPv6-only —
  // Railway's *.railway.internal names publish AAAA records only, and the
  // IPv4-only default cannot resolve them.
  // Not z.coerce.number(): Number("") is 0, so an empty REDIS_FAMILY= line in a
  // .env would silently switch the family to 0 instead of leaving it unset.
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
  // Not z.coerce.boolean(): that is just Boolean(value), so the string "false"
  // comes out true and LOG_PRETTY=false would still load pino-pretty — which
  // does not exist in the production image.
  LOG_PRETTY: z
    .string()
    .default("false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())),
  // Runs the worker inside the api process instead of as its own service. For
  // hosts that give you a single free container (Render). Parsed like
  // LOG_PRETTY, for the same reason.
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
