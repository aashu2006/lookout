/**
 * Seeds the demo dataset: two users, 20 real public URLs, and seven days of
 * synthetic history at the same 5-minute cadence the worker will use, then the
 * hourly rollup for every hour in that range.
 *
 *   npm run seed            # refuses if the demo user already exists
 *   npm run seed -- --force # deletes the demo users and starts over
 *
 * The URLs are real and stable on purpose. A live deployment keeps checking them
 * after seeding, so the synthetic history has to agree with what the checker
 * will actually observe — a host seeded as healthy must really be healthy, and
 * the four seeded-as-broken ones fail live for the same reason they fail in the
 * history (404, expired certificate, NXDOMAIN, 503).
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
/** Matches the interval every seeded URL is created with, so the generated
 * history has exactly the shape the worker would have produced. */
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
  /** Overrides the URL's latency shape. Only a timeout has a fixed cost (the
   * whole budget); every other failure is timed from the URL's own shape,
   * which is how the checker records them. */
  fixedResponseMs?: number;
}

interface SeedUrl {
  url: string;
  baseMs: number;
  jitter: number;
  /** Share of checks that fail. The broken hosts sit near 1 so their uptime
   * matches what the live checker reports for them. */
  failureRate: number;
  failure: Failure;
}

/** Error messages mirror exactly what checker.ts writes, so a seeded row and a
 * live row are indistinguishable in the UI. */
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
  // Reliably healthy public hosts. Latencies are set near what the checker
  // actually measured for each of them, so seeded rows sit in the same range as
  // the live ones that follow.
  //
  // npmjs.com and stackoverflow.com were dropped from this list: both answer a
  // plain GET from a non-browser user-agent with 403, so seeding them as
  // healthy would have contradicted every live check.
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

  // Reliably broken, each for a different reason, so the dashboard shows the
  // error taxonomy rather than one repeated failure mode. All four fail live
  // for the same reason they fail in the seeded history.
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
    // Replaces httpstat.us, which answered 502 after 9.9s when probed — close
    // enough to the timeout to be a coin flip. This endpoint stays DOWN either
    // way: if httpbin itself is unavailable the live error type differs, but
    // the status and uptime still agree with the history.
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
  // One point per URL per interval across the window, rather than uniformly
  // random timestamps, so the charts show the even cadence a real 5-minute
  // schedule produces.
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
          // The checker times every attempt, including ones that fail before a
          // response, so failures carry a duration too.
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

  // Seeded rows go straight into the database, so nothing has created BullMQ
  // schedulers for them. Reconciling here means a running worker starts checking
  // the new URLs on its own, and schedulers left over from a previous seed are
  // dropped, with no restart needed.
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
  // Importing the scheduler pulls in checkQueue, which opens Redis connections
  // (including a QueueEvents blocking read) that keep the event loop alive. Close
  // what we can, then exit explicitly: this is a one-shot script, and waiting on
  // a blocking stream reader to unwind is not worth the hang.
  await Promise.allSettled([queueEvents.close(), checkQueue.close(), prisma.$disconnect()]);
  await redis.quit().catch(() => undefined);
  process.exit(process.exitCode ?? 0);
}
