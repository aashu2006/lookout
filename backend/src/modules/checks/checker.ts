import type { ErrorType } from "@prisma/client";
import { config } from "../../config.js";
import { classifyError } from "./classifyError.js";

export interface CheckResult {
  status: "UP" | "DOWN";
  statusCode: number | null;
  responseMs: number;
  errorType: ErrorType | null;
  errorMessage: string | null;
  checkedAt: Date;
}

const USER_AGENT = "lookout-monitor/0.1";
const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Does one HTTP check and reports what happened. Doesn't touch the db. */
export async function checkUrl(url: string, opts?: { timeoutMs?: number }): Promise<CheckResult> {
  const timeoutMs = opts?.timeoutMs ?? config.checkTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const checkedAt = new Date();
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      // GET, not HEAD. Lots of servers handle HEAD badly and would look down.
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });

    // fetch resolves once headers arrive, so this is time to first byte, not
    // download time. The body is thrown away unread.
    const responseMs = Math.round(performance.now() - startedAt);
    await response.body?.cancel();

    const isUp = response.status >= 200 && response.status <= 299;

    return {
      status: isUp ? "UP" : "DOWN",
      statusCode: response.status,
      responseMs,
      errorType: isUp ? null : "HTTP_ERROR",
      errorMessage: isUp ? null : `HTTP ${response.status} ${response.statusText}`.trim(),
      checkedAt,
    };
  } catch (err) {
    const responseMs = Math.round(performance.now() - startedAt);
    const { errorType, message } = classifyError(err);

    return {
      status: "DOWN",
      statusCode: null,
      responseMs,
      errorType,
      errorMessage: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
