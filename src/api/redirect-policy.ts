/**
 * Same-origin return-path sanitizer for checkout, magic links, and post-auth redirects.
 * Rejects open redirects, protocol-relative URLs, and dot-segment traversal.
 */
export interface MikaSafeReturnPathOptions {
  /** Request origin used to validate absolute return URLs; must match exactly. */
  readonly origin?: string | URL;
  /** Site-relative fallback when the candidate is missing or unsafe; sanitized to a path. */
  readonly fallback?: string;
}

const DEFAULT_SAFE_RETURN_PATH = "/";
const FALLBACK_ORIGIN = "http://mika.local";

/**
 * Returns a safe site-relative path on the request origin, or the configured fallback.
 * Absolute URLs must match the resolved origin exactly.
 */
export function mikaSafeReturnPath(
  candidate: string | URL | null | undefined,
  options: MikaSafeReturnPathOptions = {},
): string {
  const fallback = safeFallbackPath(options.fallback);
  if (candidate === null || candidate === undefined) return fallback;

  const value = typeof candidate === "string" ? candidate.trim() : candidate.toString();
  if (!value || value.startsWith("//") || value.includes("\\")) return fallback;
  if (hasDotPathSegment(value)) return fallback;

  const base = safeBaseUrl(options.origin);
  const isAbsolute = /^[a-z][a-z\d+\-.]*:/i.test(value);
  if (!isAbsolute && !value.startsWith("/")) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return fallback;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
  if (parsed.origin !== base.origin) return fallback;

  const safePath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (safePath.startsWith("//")) return fallback;

  return safePath;
}

function safeFallbackPath(fallback: string | undefined): string {
  if (!fallback) return DEFAULT_SAFE_RETURN_PATH;
  if (fallback.startsWith("//") || fallback.includes("\\") || hasDotPathSegment(fallback)) {
    return DEFAULT_SAFE_RETURN_PATH;
  }
  if (!fallback.startsWith("/")) return DEFAULT_SAFE_RETURN_PATH;

  try {
    const parsed = new URL(fallback, FALLBACK_ORIGIN);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_SAFE_RETURN_PATH;
  }
}

function safeBaseUrl(origin: string | URL | undefined): URL {
  if (!origin) return new URL(FALLBACK_ORIGIN);

  try {
    const parsed = origin instanceof URL ? origin : new URL(origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
  } catch {
    // Fall through to the package-local origin.
  }

  return new URL(FALLBACK_ORIGIN);
}

function hasDotPathSegment(value: string): boolean {
  const path = /^https?:\/\//i.test(value)
    ? rawAbsolutePath(value)
    : (value.split(/[?#]/, 1)[0] ?? "");

  return /(?:^|\/)(?:\.|%2e)(?:\.|%2e)?(?=\/|$)/i.test(path);
}

function rawAbsolutePath(value: string): string {
  const withoutScheme = value.replace(/^[a-z][a-z\d+\-.]*:\/\/[^/?#]*/i, "");
  return withoutScheme.split(/[?#]/, 1)[0] ?? "";
}
