/**
 * ACP crypto helpers: HMAC signatures, canonical payloads, and session id generation.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { MIKA_ACP_DEFAULT_SESSION_PREFIX, MIKA_ACP_SIGNATURE_TOLERANCE_MS } from "./constants";

export async function hmacBase64(secret: string, payload: string): Promise<string> {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

/**
 * Base64url-encoded HMAC for incoming request signature verification. The published ACP spec's
 * Signature header for the checkout session API is documented as a base64url-encoded detached
 * signature (see the spec's request-signing header table), distinct from the outgoing webhook
 * signature ({@link signMikaAcpWebhook}), which is not documented to use the same encoding.
 */
export async function hmacBase64Url(secret: string, payload: string): Promise<string> {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Canonical string signed for request verification. The published ACP spec documents the
 * Signature header as covering the request body plus a separate Timestamp header, without
 * specifying the exact body-serialization scheme (canonical JSON vs. raw bytes) in the parts of
 * the spec reviewed. Mika deliberately extends the signed payload with the HTTP method and
 * path+query — binding the signature to the exact request being authorized closes a
 * cross-endpoint replay gap a body-and-timestamp-only scheme leaves open (a signature valid for
 * one path/method could otherwise be replayed against another). This is intentional hardening
 * beyond the spec's documented minimum, not an oversight; a merchant integrating with a
 * strictly spec-minimal ACP client should verify that client signs the same fields before
 * enabling `signatureSecret` in production.
 */
export function acpCanonicalSignaturePayload(
  request: Request,
  rawBody: string,
  timestamp: string,
): string {
  const url = new URL(request.url);

  return [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    sha256Hex(rawBody),
    timestamp,
  ].join("\n");
}

export function acpSignatureTimestampIsFresh(timestamp: string, now: Date): boolean {
  const parsed = parseAcpSignatureTimestamp(timestamp);
  if (!parsed) return false;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return false;

  return Math.abs(nowMs - parsed.getTime()) <= MIKA_ACP_SIGNATURE_TOLERANCE_MS;
}

export function parseAcpSignatureTimestamp(timestamp: string): Date | undefined {
  const value = timestamp.trim();
  if (!value) return undefined;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? value.length >= 13
      ? numeric
      : numeric * 1000
    : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const parsed = new Date(ms);

  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256Buffer(left), sha256Buffer(right));
}

export function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function createDefaultAcpSessionId(): string {
  return `${MIKA_ACP_DEFAULT_SESSION_PREFIX}_${cryptoSafeId()}`;
}

export function cryptoSafeId(): string {
  return randomBytes(16).toString("hex");
}
