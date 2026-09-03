/**
 * Parses and normalizes a URL string for storage/dedup purposes.
 * Throws a plain Error with a short, user-facing reason on any validation failure —
 * callers decide how to surface it (wrap in AppError for a single create, or record
 * as a per-item "invalid: <reason>" skip in bulk import).
 */
export function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("protocol must be http or https");
  }

  if (!parsed.hostname) {
    throw new Error("hostname is required");
  }

  if (parsed.username || parsed.password) {
    throw new Error("credentials are not allowed in the URL");
  }

  parsed.protocol = protocol;
  parsed.hostname = parsed.hostname.toLowerCase();

  const serialized = parsed.toString();
  const isBareOrigin = parsed.pathname === "/" && !parsed.search && !parsed.hash;
  return isBareOrigin ? serialized.replace(/\/$/, "") : serialized;
}
