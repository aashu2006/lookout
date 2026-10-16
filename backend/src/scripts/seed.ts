/**
 * Seeds demo data: two users, 20 real URLs, and 7 days of fake history at the
 * same 5 minute interval the worker uses, plus the hourly rollups.
 *
 *   npm run seed            # stops if the demo user already exists
 *   npm run seed -- --force # deletes the demo users and starts over
 *
 * The URLs are real, so live checks after seeding match the history. Healthy
 * ones really are healthy, and the four broken ones really fail.
 */
import type { ErrorType, Prisma, Url } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { rollupHour, startOfHour } from "../modules/stats/rollup.js";
import { checkQueue, queueEvents } from "../queue/checkQueue.js";
import { redis } from "../queue/connection.js";
import { reconcileSchedules } from "../queue/scheduler.js";

const DEMO_EMAIL = "demo@lookout.dev";
const DEMO_PASSWORD = "demo1234";
const ADMIN_EMAIL = "admin@lookout.dev";
const ADMIN_PASSWORD = "admin1234";

const DAYS = 7;
/** Every seeded URL gets this interval, and the history uses it too. */
const CHECK_INTERVAL_SECONDS = 300;
const INSERT_BATCH = 5000;
const BCRYPT_COST = 12;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const POINTS_PER_URL = (DAYS * 24 * 60 * 60) / CHECK_INTERVAL_SECONDS;

interface Failure {
  errorType: ErrorType;
  statusCode: number | null;
  errorMessage: string;
  /** Only timeouts have a fixed duration (the whole timeout). */
  fixedResponseMs?: number;
}

interface SeedUrl {
  url: string;
  baseMs: number;
  jitter: number;
  /** Share of checks that fail. Broken hosts are at 1. */
  failureRate: number;
  failure: Failure;
}

/** Same messages checker.ts writes, so seeded and live rows look the same. */
const TRANSIENT: Failure = {
  errorType: "TIMEOUT",
  statusCode: null,
  errorMessage: "The operation was aborted due to timeout",
  fixedResponseMs: 10000,
};

const SERVER_ERROR: Failure = {
  errorType: "HTTP_ERROR",
  statusCode: 503,
  errorMessage: "HTTP 503",
};

const SEED_URLS: SeedUrl[] = [
  // Healthy hosts, with latencies close to what the checker actually sees.
  // npmjs.com and stackoverflow.com aren't here because they 403 non-browser requests.
  { url: "https://www.google.com", baseMs: 190, jitter: 60, failureRate: 0.002, failure: TRANSIENT },
  { url: "https://www.github.com", baseMs: 380, jitter: 150, failureRate: 0.004, failure: SERVER_ERROR },
  { url: "https://en.wikipedia.org", baseMs: 200, jitter: 70, failureRate: 0.003, failure: TRANSIENT },
  { url: "https://www.cloudflare.com", baseMs: 260, jitter: 100, failureRate: 0.002, failure: TRANSIENT },
  { url: "https://go.dev", baseMs: 430, jitter: 180, failureRate: 0.005, failure: SERVER_ERROR },
  { url: "https://developer.mozilla.org", baseMs: 230, jitter: 90, failureRate: 0.004, failure: TRANSIENT },
  { url: "https://letsencrypt.org", baseMs: 240, jitter: 90, failureRate: 0.004, failure: SERVER_ERROR },
  { url: "https://www.python.org", baseMs: 230, jitter: 90, failureRate: 0.006, failure: TRANSIENT },
  { url: "https://nodejs.org", baseMs: 290, jitter: 120, failureRate: 0.005, failure: TRANSIENT },
  { url: "https://www.docker.com", baseMs: 270, jitter: 110, failureRate: 0.008, failure: SERVER_ERROR },
  { url: "https://kubernetes.io", baseMs: 260, jitter: 100, failureRate: 0.004, failure: TRANSIENT },
  { url: "https://vercel.com", baseMs: 270, jitter: 110, failureRate: 0.003, failure: SERVER_ERROR },
  { url: "https://railway.app", baseMs: 470, jitter: 200, failureRate: 0.006, failure: TRANSIENT },
  { url: "https://www.postgresql.org", baseMs: 700, jitter: 350, failureRate: 0.008, failure: TRANSIENT },
  { url: "https://redis.io", baseMs: 430, jitter: 180, failureRate: 0.005, failure: SERVER_ERROR },
  { url: "https://www.rust-lang.org", baseMs: 410, jitter: 170, failureRate: 0.004, failure: TRANSIENT },

  // Broken on purpose, each in a different way, so the dashboard shows a few
  // different error types.
  {
    url: "https://en.wikipedia.org/saecs/Saweascasce",
    baseMs: 320,
    jitter: 120,
    failureRate: 1,
    failure: { errorType: "HTTP_ERROR", statusCode: 404, errorMessage: "HTTP 404" },
  },
  {
    url: "https://expired.badssl.com",
    baseMs: 900,
    jitter: 250,
    failureRate: 1,
    failure: {
      errorType: "TLS_ERROR",
      statusCode: null,
      errorMessage: "CERT_HAS_EXPIRED: fetch failed",
    },
  },
  {
    url: "https://this-domain-does-not-exist-lookout.invalid",
    baseMs: 200,
    jitter: 120,
    failureRate: 1,
    failure: {
      errorType: "DNS_FAIL",
      statusCode: null,
      errorMessage: "ENOTFOUND: fetch failed",
    },
  },
  {
    url: "https://httpbin.org/status/503",
    baseMs: 900,
    jitter: 400,
    failureRate: 1,
    failure: { errorType: "HTTP_ERROR", statusCode: 503, errorMessage: "HTTP 503" },
  },
];

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Mostly near the base latency with the odd slow one, so p95 ends up higher
 * than the average. */
function latencyFor(baseMs: number, jitter: number): number {
  const tail = Math.random() < 0.05 ? randomBetween(2, 6) : 1;
  return Math.max(1, Math.round((baseMs + randomBetween(-jitter, jitter)) * tail));
}

async function resetDemoData(): Promise<void> {
  // Users cascade to urls, which cascade to checks and hourly stats.
  await prisma.user.deleteMany({ where: { email: { in: [DEMO_EMAIL, ADMIN_EMAIL] } } });
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const startedAt = Date.now();

  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing && !force) {
    logger.error(
      { email: DEMO_EMAIL },
      "demo data already exists, re-run with --force to recreate it",
    );
    process.exitCode = 1;
    return;
  }
  if (existing) {
    const t = Date.now();
    await resetDemoData();
    logger.info({ ms: Date.now() - t }, "cleared previous demo data");
  }

  // --- users ---
  let t = Date.now();
  const [demoHash, adminHash] = await Promise.all([
    bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST),
    bcrypt.hash(ADMIN_PASSWORD, BCRYPT_COST),
  ]);
  const demo = await prisma.user.create({
    data: { email: DEMO_EMAIL, passwordHash: demoHash, role: "USER" },
  });
  await prisma.user.create({
    data: { email: ADMIN_EMAIL, passwordHash: adminHash, role: "ADMIN" },
  });
  logger.info({ ms: Date.now() - t }, "created users");

  // --- urls ---
  t = Date.now();
  const urls: Url[] = await prisma.url.createManyAndReturn({
    data: SEED_URLS.map((seed) => ({
      userId: demo.id,
      url: seed.url,
      intervalSeconds: CHECK_INTERVAL_SECONDS,
      isActive: true,
    })),
  });
  logger.info({ ms: Date.now() - t, count: urls.length }, "created urls");

  // --- checks ---
  // One check per interval instead of random times, so the charts look like a
  // real schedule.
  t = Date.now();
  const now = Date.now();
  const windowStart = now - DAYS * DAY_MS;
  const shapeByUrl = new Map(SEED_URLS.map((seed) => [seed.url, seed]));

  let batch: Prisma.CheckCreateManyInput[] = [];
  let inserted = 0;

  const flush = async () => {
    if (batch.length === 0) {
      return;
    }
    await prisma.check.createMany({ data: batch });
    inserted += batch.length;
    batch = [];
  };

  for (const url of urls) {
    const shape = shapeByUrl.get(url.url)!;

    for (let point = 0; point < POINTS_PER_URL; point += 1) {
      // A few seconds of jitter, as real scheduling has.
      const checkedAt = new Date(
        windowStart + point * CHECK_INTERVAL_SECONDS * 1000 + randomBetween(0, 4000),
      );

      if (Math.random() < shape.failureRate) {
        const { errorType, statusCode, errorMessage, fixedResponseMs } = shape.failure;
        batch.push({
          urlId: url.id,
          status: "DOWN",
          statusCode,
          // Failures get a duration too, same as the real checker.
          responseMs: fixedResponseMs ?? latencyFor(shape.baseMs, shape.jitter),
          errorType,
          errorMessage,
          checkedAt,
        });
      } else {
        batch.push({
          urlId: url.id,
          status: "UP",
          statusCode: 200,
          responseMs: latencyFor(shape.baseMs, shape.jitter),
          errorType: null,
          errorMessage: null,
          checkedAt,
        });
      }

      if (batch.length >= INSERT_BATCH) {
        await flush();
      }
    }
  }
  await flush();

  const checksMs = Date.now() - t;
  logger.info({ ms: checksMs, count: inserted }, "created checks");

  // --- rollup for every hour in the window ---
  t = Date.now();
  const firstHour = startOfHour(new Date(windowStart));
  const lastHour = startOfHour(new Date(now));
  let hours = 0;
  let rolledRows = 0;
  for (let hour = firstHour.getTime(); hour <= lastHour.getTime(); hour += HOUR_MS) {
    rolledRows += await rollupHour(new Date(hour));
    hours += 1;
  }
  const rollupMs = Date.now() - t;
  logger.info({ ms: rollupMs, hours, rows: rolledRows }, "rolled up hourly stats");

  // The URLs went straight into the db, so sync the schedulers here. A running
  // worker then picks them up without a restart.
  t = Date.now();
  const schedules = await reconcileSchedules();
  logger.info({ ms: Date.now() - t, ...schedules }, "reconciled schedulers");

  const failures = await prisma.check.count({ where: { status: "DOWN" } });
  logger.info(
    {
      totalMs: Date.now() - startedAt,
      checksMs,
      rollupMs,
      urls: urls.length,
      checks: inserted,
      intervalSeconds: CHECK_INTERVAL_SECONDS,
      failureRatePct: Math.round((failures / inserted) * 10000) / 100,
      demo: `${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
      admin: `${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`,
    },
    "seed complete",
  );
}

try {
  await main();
} catch (err) {
  logger.error({ err }, "seed failed");
  process.exitCode = 1;
} finally {
  // The queue imports leave Redis connections open, so close what we can and
  // exit instead of hanging.
  await Promise.allSettled([queueEvents.close(), checkQueue.close(), prisma.$disconnect()]);
  await redis.quit().catch(() => undefined);
  process.exit(process.exitCode ?? 0);
}
