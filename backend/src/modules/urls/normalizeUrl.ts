/** Cleans up a URL so duplicates match. Throws an Error with a short,
 * user-facing reason if it's not valid. */
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
