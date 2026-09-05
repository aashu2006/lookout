import type { ErrorType } from "@prisma/client";

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const NETWORK_CODES = new Set(["ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]);
/** Certificate failures OpenSSL names without the word CERT. */
const TLS_CODES = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

function isTlsCode(code: string): boolean {
  return (
    // Anything mentioning a certificate is a TLS problem, wherever the word sits
    // in the code: CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT,
    // SELF_SIGNED_CERT_IN_CHAIN, ERR_TLS_CERT_ALTNAME_INVALID and any future
    // OpenSSL code we have not seen yet.
    code.includes("CERT") ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    TLS_CODES.has(code)
  );
}

/** Maps a thrown fetch error to a stored ErrorType. Pure and dependency-free so
 * it can be unit tested with hand-built error objects. */
export function classifyError(err: unknown): { errorType: ErrorType; message: string } {
  const error = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  } | null;
  const message = error?.message ?? String(err);

  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return { errorType: "TIMEOUT", message: message || "request timed out" };
  }

  // undici surfaces socket-level failures as a TypeError wrapping the real cause.
  const code = error?.cause?.code;
  if (typeof code === "string") {
    if (DNS_CODES.has(code)) {
      return { errorType: "DNS_FAIL", message: `${code}: ${message}` };
    }
    if (code === "ECONNREFUSED") {
      return { errorType: "CONN_REFUSED", message: `${code}: ${message}` };
    }
    if (NETWORK_CODES.has(code)) {
      return { errorType: "UNKNOWN", message: `${code}: ${message}` };
    }
    if (isTlsCode(code)) {
      return { errorType: "TLS_ERROR", message: `${code}: ${message}` };
    }
  }

  if (err instanceof TypeError && message.includes("Invalid URL")) {
    return { errorType: "INVALID_URL", message };
  }

  // The fetch standard keeps a blocked-ports list (1, 7, 9, 21, 25, ...). undici
  // rejects those before opening a socket, with a bare `Error: bad port` carrying
  // no code — so e.g. http://host:1 can never surface as ECONNREFUSED, however
  // closed the port is. Treat it as an unusable URL rather than an unknown fault.
  if (error?.cause?.message === "bad port") {
    return { errorType: "INVALID_URL", message: "bad port: blocked by the fetch specification" };
  }

  return { errorType: "UNKNOWN", message };
}
