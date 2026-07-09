/**
 * ACP session store: in-memory implementation and record TTL / CAS helpers.
 */
import { omitUndefined } from "../internal/object";
import type { ISODateTime } from "../types/primitives";
import type {
  MikaAcpCheckoutSessionStatus,
  MikaAcpSessionRecord,
  MikaAcpSessionStore,
} from "../api/acp-session";
import {
  MIKA_ACP_COMPLETE_WRITE_RETRIES,
  MIKA_ACP_DEFAULT_SESSION_TTL_MS,
  MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS,
} from "./constants";
import type { CreateMikaAcpCheckoutHandlersOptions } from "./types";
import { addMilliseconds, acpError, nowIso } from "./mappers";

export function nextAcpVersion(current: number | undefined): number {
  return (current ?? 0) + 1;
}

/** In-memory `MikaAcpSessionStore` for development and tests. */
export function createMemoryMikaAcpSessionStore(): MikaAcpSessionStore {
  const sessions = new Map<string, MikaAcpSessionRecord>();
  const idempotencyKeys = new Map<
    string,
    {
      readonly id: string;
      readonly pending: boolean;
      readonly expiresAt?: ISODateTime;
      readonly fencingToken: string;
    }
  >();
  // Monotonically increasing, not required to be unguessable — every (re)claim of a key gets a
  // fresh token, so a stale claim holder's bind/release can be told apart from the current one.
  let nextFencingToken = 0;

  return {
    async get(id) {
      return sessions.get(id);
    },
    async put(record) {
      sessions.set(record.id, record);
    },
    async putIfUnchanged(record, expectedVersion) {
      const current = sessions.get(record.id);
      if (current && current.version !== undefined && current.version !== expectedVersion) {
        return false;
      }
      sessions.set(record.id, record);

      return true;
    },
    async claimIdempotencyKey(key, id, lease) {
      const existing = idempotencyKeys.get(key);
      const existingExpired =
        existing?.pending === true &&
        existing.expiresAt !== undefined &&
        lease !== undefined &&
        new Date(existing.expiresAt).getTime() <= new Date(lease.now).getTime();
      if (existing && !existingExpired) {
        if (existing.id !== id) return { status: "conflict", id: existing.id };
        const record = sessions.get(existing.id);

        return record && !existing.pending
          ? { status: "replayed", record }
          : { status: "in_progress", id: existing.id };
      }

      nextFencingToken += 1;
      const fencingToken = String(nextFencingToken);
      idempotencyKeys.set(
        key,
        omitUndefined({ id, pending: true, expiresAt: lease?.expiresAt, fencingToken }),
      );

      return { status: "claimed", fencingToken };
    },
    async bindIdempotencyKey(key, id, fencingToken) {
      const binding = idempotencyKeys.get(key);
      if (binding?.fencingToken !== fencingToken) return;

      idempotencyKeys.set(key, { ...binding, id, pending: false });
    },
    async releaseIdempotencyKey(key, id, fencingToken) {
      const binding = idempotencyKeys.get(key);
      if (binding?.id === id && binding.pending && binding.fencingToken === fencingToken) {
        idempotencyKeys.delete(key);
      }
    },
    async cleanupExpired(input) {
      const limit = input.limit ?? 50;
      const terminalRetentionMs =
        input.terminalRetentionMs ?? MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS;
      const records = [...sessions.values()].sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt),
      );
      let scanned = 0;
      let expired = 0;
      let purged = 0;
      const purgedIds = new Set<string>();

      for (const record of records) {
        if (scanned >= limit) break;
        scanned += 1;

        if (record.purgeAt && new Date(record.purgeAt).getTime() <= new Date(input.now).getTime()) {
          sessions.delete(record.id);
          purgedIds.add(record.id);
          purged += 1;
          continue;
        }

        if (acpRecordIsExpired(record, input.now) && !record.expiredAt) {
          sessions.set(record.id, {
            ...record,
            status: "not_ready_for_payment",
            expiredAt: input.now,
            purgeAt: addMilliseconds(input.now, terminalRetentionMs),
            updatedAt: input.now,
            version: nextAcpVersion(record.version),
          });
          expired += 1;
        }
      }

      for (const [key, binding] of idempotencyKeys) {
        if (purgedIds.has(binding.id)) idempotencyKeys.delete(key);
      }

      return {
        scanned,
        expired,
        purged,
        hasMore: records.length > scanned,
      };
    },
  };
}

export function acpSessionTtlMs(options: CreateMikaAcpCheckoutHandlersOptions): number {
  return options.sessionTtlMs ?? MIKA_ACP_DEFAULT_SESSION_TTL_MS;
}

export function acpTerminalRetentionMs(options: CreateMikaAcpCheckoutHandlersOptions): number {
  return options.terminalRetentionMs ?? MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS;
}

export function acpRecordIsTerminal(record: MikaAcpSessionRecord): boolean {
  return record.status === "completed" || record.status === "canceled";
}

export function acpRecordIsExpired(record: MikaAcpSessionRecord, now: ISODateTime): boolean {
  if (acpRecordIsTerminal(record)) return false;
  if (record.expiredAt) return true;
  if (!record.expiresAt) return false;

  return new Date(record.expiresAt).getTime() <= new Date(now).getTime();
}

/**
 * Structural equality for plain JSON-shaped values (every MikaAcpSessionRecord field is one:
 * strings, arrays, and nested plain objects — no Dates, Maps, or class instances). Deliberately
 * not a `===`/reference check: a real (non-memory) MikaAcpSessionStore commonly deserializes a
 * fresh object graph on every `get()` (e.g. `JSON.parse` of a stored row), so two reads of
 * content-identical data are never the same reference even when nothing changed. Object key order
 * is ignored (compares by key set, not insertion order) since a storage round-trip has no
 * obligation to preserve it. An explicit `key: undefined` is treated as equivalent to `key` being
 * absent entirely (both read as `undefined` through bracket access) — matching how `JSON.stringify`
 * itself drops undefined-valued keys, so this stays a faithful "would these serialize the same"
 * comparison even before either side has actually round-tripped through JSON.
 */
export function acpDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => acpDeepEqual(item, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);

  return [...keys].every((key) => acpDeepEqual(leftRecord[key], rightRecord[key]));
}

/**
 * True when `current` is exactly `original` with nothing but expireAcpRecordIfNeeded's lazy
 * expiry sweep applied on top — the only fields that differ are the ones that sweep touches
 * (`status`, `expiredAt`, `purgeAt`, `updatedAt`, `version`), and `status` landed on a
 * non-terminal value. Every other field (`checkoutId`, `buyer`, `items`,
 * `fulfillmentAddress`/`fulfillmentOptionId`, etc.) must be unchanged — a genuine concurrent write
 * (e.g. handleAcpUpdate legitimately changing `buyer` or `items`) has no `checkoutId` and a
 * non-terminal `status` either, so checking those two fields alone would misclassify a real
 * conflict as "merely incidental" and silently retry past it, discarding the other write. Compares
 * object/array-typed fields structurally (see acpDeepEqual), not by reference, since a real store
 * that deserializes on every read would otherwise make every field "different" every time,
 * defeating the retry this function exists to allow.
 *
 * expireAcpRecordIfNeeded runs unconditionally at the top of every handler, including plain GETs
 * with no locking of their own, so an ordinary concurrent status poll can legitimately tick a
 * session's TTL and bump its version while a slow (not crashed) handleAcpComplete is still mid
 * checkout.start — losing that handler's final CAS check to a bystander write, not a real
 * conflict. Without distinguishing the two, a genuinely successful completion would be silently
 * discarded: its own caller would be told the session is "not_ready_for_payment" while a real
 * payment already went through, and nothing ever revisits that record afterward to set it right.
 */
export function acpRecordIsOnlyIncidentallyExpired(
  original: MikaAcpSessionRecord,
  current: MikaAcpSessionRecord,
): boolean {
  return (
    current.status !== "completed" &&
    current.status !== "canceled" &&
    current.cartId === original.cartId &&
    current.checkoutId === original.checkoutId &&
    current.fulfillmentOptionId === original.fulfillmentOptionId &&
    current.currency === original.currency &&
    current.provider === original.provider &&
    current.paymentAuthorizationId === original.paymentAuthorizationId &&
    current.quoteInputHash === original.quoteInputHash &&
    current.expiresAt === original.expiresAt &&
    acpDeepEqual(current.buyer, original.buyer) &&
    acpDeepEqual(current.items, original.items) &&
    acpDeepEqual(current.fulfillmentAddress, original.fulfillmentAddress) &&
    acpDeepEqual(current.quoteSnapshot, original.quoteSnapshot)
  );
}

/**
 * Persists `buildCandidate(version)` via putIfUnchanged, retrying past a CAS loss that turns out
 * to be nothing more than expireAcpRecordIfNeeded's lazy expiry sweep (see
 * acpRecordIsOnlyIncidentallyExpired) rather than a genuine competing decision, up to
 * MIKA_ACP_COMPLETE_WRITE_RETRIES attempts. Shared by both of handleAcpComplete's writes (the
 * early compensating revert and the final completion) so a bystander expiry sweep can't cause
 * either one to silently discard this attempt's own legitimate write — only a real conflict does.
 * Returns the persisted record, or `undefined` if every attempt lost to a genuine conflict (or the
 * record vanished); callers should then re-fetch and report whatever's actually stored.
 */
export async function putAcpRecordRetryingIncidentalExpiry(
  options: CreateMikaAcpCheckoutHandlersOptions,
  checkoutSessionId: string,
  original: MikaAcpSessionRecord,
  buildCandidate: (version: number | undefined) => MikaAcpSessionRecord,
): Promise<MikaAcpSessionRecord | undefined> {
  let writeVersion = original.version;
  for (let attempt = 0; attempt < MIKA_ACP_COMPLETE_WRITE_RETRIES; attempt += 1) {
    const candidate = buildCandidate(writeVersion);
    if (await options.store.putIfUnchanged(candidate, writeVersion)) return candidate;
    const current = await options.store.get(checkoutSessionId);
    if (!current || !acpRecordIsOnlyIncidentallyExpired(original, current)) return undefined;
    writeVersion = current.version;
  }

  return undefined;
}

export async function expireAcpRecordIfNeeded(
  options: CreateMikaAcpCheckoutHandlersOptions,
  record: MikaAcpSessionRecord,
): Promise<MikaAcpSessionRecord> {
  const now = nowIso(options);
  if (!acpRecordIsExpired(record, now) || record.expiredAt) return record;

  const expired: MikaAcpSessionRecord = {
    ...record,
    status: "not_ready_for_payment",
    expiredAt: now,
    purgeAt: addMilliseconds(now, acpTerminalRetentionMs(options)),
    updatedAt: now,
    version: nextAcpVersion(record.version),
  };
  const written = await options.store.putIfUnchanged(expired, record.version);
  if (written) return expired;

  // Lost the race — someone else already wrote a newer version (e.g. a genuine completion that
  // landed first). Return whatever's actually persisted rather than the stale expiry this handler
  // computed, so callers never act on a version that was never really committed.
  return (await options.store.get(record.id)) ?? expired;
}

export function acpExpiredError(request: Request): Response {
  return acpError(
    request,
    409,
    "checkout_expired",
    "Checkout session has expired. Create a new ACP checkout session to continue.",
  );
}

export function acpTerminalError(
  request: Request,
  status: MikaAcpCheckoutSessionStatus,
  action: "updated" | "completed" | "canceled",
): Response {
  return acpError(
    request,
    409,
    "invalid_request",
    `Checkout session is ${status} and cannot be ${action}.`,
  );
}
