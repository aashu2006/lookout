import type { Check } from "@prisma/client";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { AppError } from "../../errors.js";
import { logger } from "../../logger.js";
import { checkUrl, type CheckResult } from "./checker.js";

export async function recordCheck(urlId: string, result: CheckResult): Promise<Check> {
  return prisma.check.create({
    data: {
      urlId,
      status: result.status,
      statusCode: result.statusCode,
      responseMs: result.responseMs,
      errorType: result.errorType,
      errorMessage: result.errorMessage,
      checkedAt: result.checkedAt,
    },
  });
}

export async function runCheckForUrl(urlId: string): Promise<Check> {
  const url = await prisma.url.findUnique({ where: { id: urlId } });
  if (!url) {
    throw new AppError(404, "not_found", "URL not found");
  }

  const result = await checkUrl(url.url);
  const check = await recordCheck(url.id, result);

  const fields = {
    urlId: url.id,
    url: url.url,
    status: result.status,
    statusCode: result.statusCode,
    responseMs: result.responseMs,
    errorType: result.errorType,
  };
  if (result.status === "UP") {
    logger.info(fields, "check completed");
  } else {
    logger.warn(fields, "check failed");
  }

  return check;
}

export async function runChecksForUrls(urlIds: string[]): Promise<PromiseSettledResult<Check>[]> {
  // Minimal semaphore instead of a p-limit dependency: at most
  // config.checkConcurrency requests are in flight, the rest queue for a slot.
  let active = 0;
  const waiting: (() => void)[] = [];

  async function withSlot(task: () => Promise<Check>): Promise<Check> {
    if (active >= config.checkConcurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      // Hand the freed slot to the next queued task, if any.
      waiting.shift()?.();
    }
  }

  return Promise.allSettled(urlIds.map((id) => withSlot(() => runCheckForUrl(id))));
}

export async function getActiveUrlIdsForUser(userId: string): Promise<string[]> {
  const urls = await prisma.url.findMany({
    where: { userId, isActive: true },
    select: { id: true },
  });
  return urls.map((url) => url.id);
}
