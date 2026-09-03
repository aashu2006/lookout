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

/** Performs a single HTTP health check. Pure in the sense that it touches no
 * database — it only does the request and reports what happened. */
export async function checkUrl(url: string, opts?: { timeoutMs?: number }): Promise<CheckResult> {
  const timeoutMs = opts?.timeoutMs ?? config.checkTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const checkedAt = new Date();
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      // GET rather than HEAD: plenty of servers reject or mishandle HEAD and
      // would report as down when they are fine.
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });

    // fetch settles as soon as the response headers arrive, so this measures
    // time-to-first-byte rather than full download time. That is what we want:
    // it reflects server responsiveness instead of page weight or our own
    // bandwidth, and it keeps timings comparable across a 2 KB status page and
    // a 5 MB one. The body is then discarded without reading it.
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
