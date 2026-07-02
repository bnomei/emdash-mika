import { mirrorRecordFields } from "../record-mirror";
import type { AccountDeleteEmailRedactionRepositoryInput } from "./account-delete-helpers";
import type { EmailDocument } from "../../../types/documents";
import type { ISODateTime, JsonObject } from "../../../types/primitives";

export function emailIsDueForLease(email: EmailDocument, now: ISODateTime, force = false): boolean {
  if (email.status === "sent" || email.status === "skipped") return false;
  const leaseExpiresAt = email.record.leaseExpiresAt;
  if (leaseExpiresAt && leaseExpiresAt > now) return false;
  if (force) return true;
  if (email.record.attemptCount >= email.record.maxAttempts) return false;

  return !email.nextAttemptAt || email.nextAttemptAt <= now;
}

export function emailIsExhaustedLeaseLoss(email: EmailDocument, now: ISODateTime): boolean {
  if (email.status !== "queued") return false;
  const leaseExpiresAt = email.record.leaseExpiresAt;
  if (!leaseExpiresAt || leaseExpiresAt > now) return false;
  if (email.record.attemptCount < email.record.maxAttempts) return false;

  return !email.record.lastError;
}

export function emailHasActiveLease(
  email: EmailDocument,
  input: { readonly leaseKey: string; readonly now: ISODateTime },
): boolean {
  const leaseKey = email.record.leaseKey;
  const leaseExpiresAt = email.record.leaseExpiresAt;

  return leaseKey === input.leaseKey && leaseExpiresAt !== undefined && leaseExpiresAt > input.now;
}

export function emailDocumentWithRecord(
  email: EmailDocument,
  now: ISODateTime,
  patch: Partial<EmailDocument["record"]>,
): EmailDocument {
  return mirrorRecordFields(email, now, patch, [
    "status",
    "nextAttemptAt",
    "orderId",
    "tokenId",
    "kind",
  ]);
}

export function emailSentMetadata(email: EmailDocument, now: ISODateTime): JsonObject | undefined {
  const metadata = email.record.metadata;
  if (email.kind !== "magic_link" || !metadata) return metadata;
  if (metadata["link"] === undefined && metadata["url"] === undefined) return metadata;

  const { link: _link, url: _url, ...redacted } = metadata;
  return {
    ...redacted,
    linkRedactedAt: now,
  };
}

export function emailMatchesAccountDeleteIdentity(
  email: EmailDocument,
  identity: AccountDeleteEmailRedactionRepositoryInput,
): boolean {
  const record = email.record;

  return Boolean(
    (identity.customerId && record.customerId === identity.customerId) ||
    (identity.userId && record.metadata?.["userId"] === identity.userId) ||
    (identity.emailHash && record.metadata?.["emailHash"] === identity.emailHash),
  );
}
