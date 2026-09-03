import { describe, expect, it } from "vitest";
import { classifyError } from "./classifyError.js";

/** Builds the shape undici throws: a TypeError wrapping the real socket error. */
function fetchError(code: string, message = "fetch failed"): TypeError {
  const err = new TypeError(message);
  (err as TypeError & { cause: { code: string } }).cause = { code };
  return err;
}

describe("classifyError", () => {
  it("maps AbortError to TIMEOUT", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    expect(classifyError(err).errorType).toBe("TIMEOUT");
  });

  it("maps TimeoutError to TIMEOUT", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(classifyError(err).errorType).toBe("TIMEOUT");
  });

  it("takes the timeout branch before looking at cause.code", () => {
    const err = fetchError("ECONNREFUSED");
    err.name = "AbortError";
    expect(classifyError(err).errorType).toBe("TIMEOUT");
  });

  it.each(["ENOTFOUND", "EAI_AGAIN"])("maps %s to DNS_FAIL", (code) => {
    const result = classifyError(fetchError(code));
    expect(result.errorType).toBe("DNS_FAIL");
    expect(result.message).toContain(code);
  });

  it("maps ECONNREFUSED to CONN_REFUSED", () => {
    const result = classifyError(fetchError("ECONNREFUSED"));
    expect(result.errorType).toBe("CONN_REFUSED");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it.each(["ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"])(
    "maps %s to UNKNOWN but keeps the code in the message",
    (code) => {
      const result = classifyError(fetchError(code));
      expect(result.errorType).toBe("UNKNOWN");
      expect(result.message).toContain(code);
    },
  );

  it.each([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_SSL_WRONG_VERSION_NUMBER",
  ])("maps %s to TLS_ERROR", (code) => {
    expect(classifyError(fetchError(code)).errorType).toBe("TLS_ERROR");
  });

  it("maps a TypeError about an invalid URL to INVALID_URL", () => {
    expect(classifyError(new TypeError("Invalid URL")).errorType).toBe("INVALID_URL");
  });

  it("maps a fetch-spec blocked port to INVALID_URL", () => {
    const err = new TypeError("fetch failed");
    (err as TypeError & { cause: Error }).cause = new Error("bad port");
    const result = classifyError(err);
    expect(result.errorType).toBe("INVALID_URL");
    expect(result.message).toContain("bad port");
  });

  it("falls back to UNKNOWN for an unrecognised error", () => {
    const result = classifyError(new Error("something else went wrong"));
    expect(result.errorType).toBe("UNKNOWN");
    expect(result.message).toBe("something else went wrong");
  });

  it("falls back to UNKNOWN for an unrecognised cause code", () => {
    expect(classifyError(fetchError("EPIPE")).errorType).toBe("UNKNOWN");
  });

  it("handles non-Error values without throwing", () => {
    expect(classifyError("just a string").errorType).toBe("UNKNOWN");
    expect(classifyError(null).errorType).toBe("UNKNOWN");
  });
});
