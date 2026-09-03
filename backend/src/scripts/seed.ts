/**
 * Seeds a demo dataset big enough to show the rollup and indexes doing real work:
 * two users, 50 URLs and 100k checks over the last 7 days, then the hourly
 * rollup for every hour in that range.
 *
 *   npm run seed            # refuses if the demo user already exists
 *   npm run seed -- --force # deletes the demo users and starts over
 */
import { Prisma, type Url } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { rollupHour, startOfHour } from "../modules/stats/rollup.js";

const DEMO_EMAIL = "demo@lookout.dev";
const DEMO_PASSWORD = "demo1234";
const ADMIN_EMAIL = "admin@lookout.dev";
const ADMIN_PASSWORD = "admin1234";

const URL_COUNT = 50;
const CHECK_COUNT = 100_000;
const DAYS = 7;
const INSERT_BATCH = 5000;
const BCRYPT_COST = 12;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A realistic mix: fast CDNs, slower app endpoints, a few chronically flaky
 * ones, and some that never resolve — so the dashboard has variety. */
const URL_SHAPES = [
  // Mean failure rate across the mix is ~4%.
  { host: "cdn", baseMs: 45, jitter: 25, failureRate: 0.004 },
  { host: "www", baseMs: 120, jitter: 60, failureRate: 0.012 },
  { host: "api", baseMs: 240, jitter: 140, failureRate: 0.03 },
  { host: "search", baseMs: 380, jitter: 220, failureRate: 0.055 },
  { host: "legacy", baseMs: 700, jitter: 400, failureRate: 0.1 },
];

const ERROR_TYPES: Prisma.CheckCreateManyInput["errorType"][] = [
  "HTTP_ERROR",
  "TIMEOUT",
  "CONN_REFUSED",
  "DNS_FAIL",
  "TLS_ERROR",
];

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Log-normal-ish: mostly near the base latency with an occasional long tail,
 * which is what makes p95 meaningfully higher than the average. */
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
      "demo data already present — re-run with --force to delete and recreate",
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
  const urlData = Array.from({ length: URL_COUNT }, (_, index) => {
    const shape = URL_SHAPES[index % URL_SHAPES.length];
    return {
      userId: demo.id,
      url: `https://${shape.host}-${String(index + 1).padStart(2, "0")}.lookout-demo.dev`,
      intervalSeconds: [60, 300, 900, 1800][index % 4],
      // A handful are paused, as they would be in real use.
      isActive: index % 11 !== 0,
    };
  });
  const urls: Url[] = await prisma.url.createManyAndReturn({ data: urlData });
  logger.info({ ms: Date.now() - t, count: urls.length }, "created urls");

  // --- checks ---
  t = Date.now();
  const now = Date.now();
  const windowStart = now - DAYS * DAY_MS;
  let inserted = 0;

  for (let offset = 0; offset < CHECK_COUNT; offset += INSERT_BATCH) {
    const size = Math.min(INSERT_BATCH, CHECK_COUNT - offset);
    const batch: Prisma.CheckCreateManyInput[] = new Array(size);

    for (let i = 0; i < size; i += 1) {
      const index = (offset + i) % urls.length;
      const url = urls[index];
      const shape = URL_SHAPES[index % URL_SHAPES.length];
      const checkedAt = new Date(randomBetween(windowStart, now));
      const failed = Math.random() < shape.failureRate;

      if (failed) {
        const errorType = ERROR_TYPES[Math.floor(Math.random() * ERROR_TYPES.length)];
        const isHttpError = errorType === "HTTP_ERROR";
        batch[i] = {
          urlId: url.id,
          status: "DOWN",
          statusCode: isHttpError ? [404, 500, 502, 503][Math.floor(Math.random() * 4)] : null,
          // A timeout still burns the full budget; other faults fail fast.
          responseMs: errorType === "TIMEOUT" ? 10000 : isHttpError ? latencyFor(shape.baseMs, shape.jitter) : null,
          errorType,
          errorMessage: isHttpError ? "HTTP error response" : `${errorType}: fetch failed`,
          checkedAt,
        };
      } else {
        batch[i] = {
          urlId: url.id,
          status: "UP",
          statusCode: 200,
          responseMs: latencyFor(shape.baseMs, shape.jitter),
          errorType: null,
          errorMessage: null,
          checkedAt,
        };
      }
    }

    await prisma.check.createMany({ data: batch });
    inserted += size;
    if (inserted % 25000 === 0) {
      logger.info({ inserted, ms: Date.now() - t }, "inserting checks");
    }
  }
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

  const failures = await prisma.check.count({ where: { status: "DOWN" } });
  logger.info(
    {
      totalMs: Date.now() - startedAt,
      checksMs,
      rollupMs,
      urls: urls.length,
      checks: inserted,
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
  await prisma.$disconnect();
}
