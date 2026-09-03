import { Prisma, type Check, type Url } from "@prisma/client";
import { prisma } from "../../db.js";
import { AppError } from "../../errors.js";
import { CHECK_JOB_NAME, checkQueue } from "../../queue/checkQueue.js";
import { scheduleUrl, unscheduleUrl } from "../../queue/scheduler.js";
import type { AuthUser } from "../../types/express.js";
import { normalizeUrl } from "./normalizeUrl.js";
import type { CreateUrlInput, ListUrlsQuery, PatchUrlInput } from "./urls.schemas.js";

export interface SkippedUrl {
  url: string;
  reason: string;
}

export interface UrlWithLastCheck extends Url {
  lastCheck: Check | null;
}

function isAdmin(user: AuthUser): boolean {
  return user.role === "ADMIN";
}

/** Starts the recurring schedule for newly created URLs, plus one immediate
 * manual job each so the user sees a first result now rather than after a
 * full interval. */
async function onUrlsCreated(urls: Url[]): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  await Promise.all(urls.map((url) => scheduleUrl(url)));
  await checkQueue.addBulk(
    urls.map((url) => ({
      name: CHECK_JOB_NAME,
      data: { urlId: url.id, trigger: "manual" as const },
    })),
  );
}

export async function createUrl(userId: string, input: CreateUrlInput): Promise<Url> {
  let normalized: string;
  try {
    normalized = normalizeUrl(input.url);
  } catch (err) {
    throw new AppError(400, "invalid_url", err instanceof Error ? err.message : "invalid URL");
  }

  try {
    const url = await prisma.url.create({
      data: { userId, url: normalized, intervalSeconds: input.intervalSeconds },
    });
    await onUrlsCreated([url]);
    return url;
  } catch (err) {
    // Unique constraint on (userId, url) — caught rather than pre-checked so a
    // concurrent create can't slip between a lookup and the insert.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, "duplicate_url", "You are already monitoring this URL");
    }
    throw err;
  }
}

export async function bulkCreateUrls(
  userId: string,
  rawUrls: string[],
): Promise<{ created: Url[]; skipped: SkippedUrl[] }> {
  const skipped: SkippedUrl[] = [];
  const seen = new Set<string>();
  const candidates: { raw: string; normalized: string }[] = [];

  // A bad URL only ever skips its own entry — it never fails the request.
  for (const raw of rawUrls) {
    let normalized: string;
    try {
      normalized = normalizeUrl(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid URL";
      skipped.push({ url: raw, reason: `invalid: ${reason}` });
      continue;
    }

    if (seen.has(normalized)) {
      skipped.push({ url: raw, reason: "duplicate" });
      continue;
    }
    seen.add(normalized);
    candidates.push({ raw, normalized });
  }

  if (candidates.length === 0) {
    return { created: [], skipped };
  }

  const existing = await prisma.url.findMany({
    where: { userId, url: { in: candidates.map((c) => c.normalized) } },
    select: { url: true },
  });
  const existingUrls = new Set(existing.map((row) => row.url));

  const toInsert = candidates.filter((candidate) => {
    if (existingUrls.has(candidate.normalized)) {
      skipped.push({ url: candidate.raw, reason: "duplicate" });
      return false;
    }
    return true;
  });

  if (toInsert.length === 0) {
    return { created: [], skipped };
  }

  // One transaction; skipDuplicates is the safety net for a concurrent import
  // racing us between the existence check above and this insert. createManyAndReturn
  // is createMany with a RETURNING clause, so we get the created rows back.
  const created = await prisma.$transaction(async (tx) =>
    tx.url.createManyAndReturn({
      data: toInsert.map((candidate) => ({ userId, url: candidate.normalized })),
      skipDuplicates: true,
    }),
  );

  const createdUrls = new Set(created.map((row) => row.url));
  for (const candidate of toInsert) {
    if (!createdUrls.has(candidate.normalized)) {
      skipped.push({ url: candidate.raw, reason: "duplicate" });
    }
  }

  await onUrlsCreated(created);

  return { created, skipped };
}

export async function listUrls(
  user: AuthUser,
  query: ListUrlsQuery,
): Promise<{ items: UrlWithLastCheck[]; page: number; pageSize: number; total: number }> {
  const { page, pageSize, status, all } = query;

  const where: Prisma.UrlWhereInput = {};
  // `all=true` only widens scope for admins; for everyone else it is ignored.
  if (!(all && isAdmin(user))) {
    where.userId = user.id;
  }
  if (status) {
    where.isActive = status === "active";
  }

  const [total, rows] = await Promise.all([
    prisma.url.count({ where }),
    prisma.url.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // Latest check per URL without N+1: under Prisma's default load strategy
      // this is one extra batched query (`... WHERE url_id IN (<page ids>)`) for
      // the whole page, not one per row. Verified against the query log — it is
      // not a LATERAL join; that would need the `relationJoins` preview feature
      // plus relationLoadStrategy: "join", which we have deliberately not enabled.
      include: { checks: { orderBy: { checkedAt: "desc" }, take: 1 } },
    }),
  ]);

  const items = rows.map(({ checks, ...url }) => ({ ...url, lastCheck: checks[0] ?? null }));

  return { items, page, pageSize, total };
}

/** Returns null both when the URL does not exist and when a non-admin does not
 * own it, so callers can 404 without leaking whether someone else's URL exists. */
export async function getUrlById(user: AuthUser, id: string): Promise<Url | null> {
  const url = await prisma.url.findUnique({ where: { id } });
  if (!url) {
    return null;
  }
  if (!isAdmin(user) && url.userId !== user.id) {
    return null;
  }
  return url;
}

export async function updateUrl(user: AuthUser, id: string, patch: PatchUrlInput): Promise<Url> {
  const existing = await getUrlById(user, id);
  if (!existing) {
    throw new AppError(404, "not_found", "URL not found");
  }

  const updated = await prisma.url.update({ where: { id }, data: patch });

  if (updated.isActive) {
    const reactivated = patch.isActive === true && !existing.isActive;
    const intervalChanged = updated.intervalSeconds !== existing.intervalSeconds;
    if (reactivated || intervalChanged) {
      // upsert, so re-pointing an existing scheduler at a new interval is safe.
      await scheduleUrl(updated);
    }
  } else if (existing.isActive) {
    await unscheduleUrl(updated.id);
  }

  return updated;
}

export async function deleteUrl(user: AuthUser, id: string): Promise<void> {
  const existing = await getUrlById(user, id);
  if (!existing) {
    throw new AppError(404, "not_found", "URL not found");
  }
  // Drop the schedule first: a scheduler that fires against a deleted row would
  // just burn its retries on a 404.
  await unscheduleUrl(id);
  // Checks and hourly stats cascade via the schema's onDelete: Cascade.
  await prisma.url.delete({ where: { id } });
}

export async function listChecksForUrl(
  user: AuthUser,
  urlId: string,
  limit: number,
): Promise<Check[]> {
  const url = await getUrlById(user, urlId);
  if (!url) {
    throw new AppError(404, "not_found", "URL not found");
  }
  return prisma.check.findMany({
    where: { urlId },
    orderBy: { checkedAt: "desc" },
    take: limit,
  });
}
