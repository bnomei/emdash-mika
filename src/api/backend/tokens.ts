/**
 * Capability tokens: minting, hashing, and validating the single-use/reusable ephemeral tokens
 * that gate download, order invoice, checkout status/cancel, magic link, and account export
 * access for callers without an authenticated session (email-delivered links, agent flows).
 */
import { formatSubjectRef } from "../subject-ref";
import type { MikaRequestContext } from "../context";
import type { OrderLine } from "../../types/aggregates";
import type { CheckoutDocument, OrderDocument } from "../../types/documents";
import type { ISODateTime, MikaId } from "../../types/primitives";
import type { AccountDTO } from "../types";
import { addMilliseconds, stringChild } from "./shared";
import { authRequired, forbidden, tokenResult } from "./errors";
import type { MikaApiFailure } from "./errors";
import {
  checkoutBelongsToContext,
  orderAccessRevokedForAccountDelete,
  orderBelongsToIdentity,
  resolveAccountIdentity,
} from "./identity";
import type { MikaBackendDependencies, MikaBackendRepositories } from "./ports";

export async function orderInvoiceAccessError(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
  token: string | undefined,
): Promise<MikaApiFailure | null> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (identity && orderBelongsToIdentity(order, identity)) return null;

  if (token) return validateOrderInvoiceToken(input, ctx.now, token, order);

  return identity
    ? forbidden("Order invoice is not available for this identity.")
    : authRequired("Order invoice requires an authenticated customer identity or invoice token.");
}

export async function createOrderLineDownloadToken(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
  line: OrderLine,
  downloadRef: string,
): Promise<{ token: string; expiresAt: ISODateTime }> {
  const pointerKey = await downloadTokenPointerKey(input, order.id, line.id, downloadRef);
  const reused = await reusableDownloadToken(input, pointerKey, ctx.now);
  if (reused) return reused;

  const token = input.createId("download_token");
  const expiresAt = addMilliseconds(ctx.now, input.config?.download?.tokenTtlMs ?? 15 * 60_000);
  const subjectHash = orderDownloadSubjectHash(order);
  await input.repositories.ephemeral.put({
    key: await hashDownloadToken(input, token),
    kind: "token",
    ...(subjectHash ? { subjectHash } : {}),
    status: "pending",
    count: 0,
    expiresAt,
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data: {
      purpose: "download",
      tokenId: token,
      downloadRef,
      orderId: order.id,
      orderLineId: line.id,
      ...(line.entitlementId ? { entitlementId: line.entitlementId } : {}),
      title: line.item.titleSnapshot,
      redirectUrl: downloadRef,
    },
  });
  // account.get can be called far more often than a download link is actually clicked (every
  // page view/refresh, vs. once per redemption); without this pointer, each view would mint and
  // persist a brand-new ephemeral token record even though the previous one is still valid.
  await input.repositories.ephemeral.put({
    key: pointerKey,
    kind: "cache_marker",
    ...(subjectHash ? { subjectHash } : {}),
    status: "active",
    count: 0,
    expiresAt,
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data: { tokenId: token },
  });

  return { token, expiresAt };
}

async function downloadTokenPointerKey(
  input: MikaBackendDependencies,
  orderId: MikaId,
  orderLineId: MikaId,
  downloadRef: string,
): Promise<string> {
  return input.hash(`download-token-pointer:${orderId}:${orderLineId}:${downloadRef}`);
}

/** Reuses a still-valid, not-yet-consumed download token minted for the same line, if any. */
async function reusableDownloadToken(
  input: MikaBackendDependencies,
  pointerKey: string,
  now: ISODateTime,
): Promise<{ token: string; expiresAt: ISODateTime } | null> {
  const pointer = await input.repositories.ephemeral.get(pointerKey);
  if (!pointer || pointer.kind !== "cache_marker" || pointer.expiresAt <= now) return null;

  const tokenId = stringChild(pointer.data ?? {}, "tokenId");
  if (!tokenId) return null;

  // The pointer's TTL mirrors the token's at mint time, but consumption (or revocation) can
  // invalidate the token earlier — confirm it's still live before handing it out again.
  const tokenRecord = await input.repositories.ephemeral.get(
    await hashDownloadToken(input, tokenId),
  );
  if (!tokenRecord || tokenRecord.status !== "pending" || tokenRecord.expiresAt <= now) return null;

  return { token: tokenId, expiresAt: pointer.expiresAt };
}

export function orderDownloadSubjectHash(order: OrderDocument): string | undefined {
  const customerId = order.customerId ?? order.aggregate.customer.customerId;
  if (customerId) return formatSubjectRef({ kind: "customer", id: customerId });
  const userId = order.aggregate.customer.userId;
  if (userId) return formatSubjectRef({ kind: "user", id: userId });
  const emailHash = order.emailHash ?? order.aggregate.customer.emailHash;
  return emailHash ? formatSubjectRef({ kind: "email", id: emailHash }) : undefined;
}

export function accountExportArtifactRef(account: AccountDTO, exportedAt: ISODateTime): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(
    JSON.stringify({ exportedAt, account }),
  )}`;
}

export async function hashAccountExportDownloadToken(
  input: MikaBackendDependencies,
  token: string,
): Promise<string> {
  return input.hash(`account-export-download-token:${token}`);
}

export async function hashDownloadToken(
  input: MikaBackendDependencies,
  token: string,
): Promise<string> {
  return input.hash(`download-token:${token}`);
}

async function hashCheckoutStatusToken(
  input: MikaBackendDependencies,
  token: string,
): Promise<string> {
  return input.hash(`checkout-status-token:${token}`);
}

async function hashOrderInvoiceToken(
  input: MikaBackendDependencies,
  token: string,
): Promise<string> {
  return input.hash(`order-invoice-token:${token}`);
}

export async function createOrderInvoiceToken(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<string> {
  const token = input.createId("order_invoice_token");
  const customerId = order.customerId ?? order.aggregate.customer.customerId;
  const subjectHash = orderDownloadSubjectHash(order);
  await input.repositories.ephemeral.put({
    key: await hashOrderInvoiceToken(input, token),
    kind: "token",
    ...(subjectHash ? { subjectHash } : {}),
    status: "active",
    count: 0,
    expiresAt: addMilliseconds(ctx.now, input.config?.order?.invoiceTokenTtlMs ?? 15 * 60_000),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data: {
      purpose: "order_invoice",
      orderId: order.id,
      ...(customerId ? { customerId } : {}),
      ...(subjectHash ? { subjectHash } : {}),
    },
  });

  return token;
}

async function validateCheckoutStatusToken(
  input: MikaBackendDependencies,
  now: ISODateTime,
  token: string,
  document: CheckoutDocument,
): Promise<MikaApiFailure | null> {
  const record = await input.repositories.ephemeral.get(
    await hashCheckoutStatusToken(input, token.trim()),
  );

  return reusableCapabilityTokenError(record, {
    now,
    purpose: "checkout_status",
    label: "Checkout status token",
    target: {
      checkoutId: document.id,
      ...(document.customerId ? { customerId: document.customerId } : {}),
      ...(document.sessionId ? { sessionId: document.sessionId } : {}),
    },
  });
}

async function validateOrderInvoiceToken(
  input: MikaBackendDependencies,
  now: ISODateTime,
  token: string,
  order: OrderDocument,
): Promise<MikaApiFailure | null> {
  if (orderAccessRevokedForAccountDelete(order)) {
    return tokenResult("DOWNLOAD_REVOKED", "Order invoice access has been revoked.");
  }
  const record = await input.repositories.ephemeral.get(
    await hashOrderInvoiceToken(input, token.trim()),
  );
  const customerId = order.customerId ?? order.aggregate.customer.customerId;
  const subjectHash = orderDownloadSubjectHash(order);

  return reusableCapabilityTokenError(record, {
    now,
    purpose: "order_invoice",
    label: "Order invoice token",
    target: {
      orderId: order.id,
      ...(customerId ? { customerId } : {}),
      ...(subjectHash ? { subjectHash } : {}),
    },
  });
}

/** Purpose discriminator stored on a reusable capability token's ephemeral record. */
type CapabilityTokenPurpose = "checkout_status" | "order_invoice";

function reusableCapabilityTokenError(
  record: Awaited<ReturnType<MikaBackendRepositories["ephemeral"]["get"]>>,
  options: {
    readonly now: ISODateTime;
    readonly purpose: CapabilityTokenPurpose;
    readonly label: string;
    readonly target: Record<string, string | undefined>;
  },
): MikaApiFailure | null {
  const data = record?.data ?? {};
  if (
    !record ||
    record.kind !== "token" ||
    record.status !== "active" ||
    stringChild(data, "purpose") !== options.purpose
  ) {
    return tokenResult("TOKEN_INVALID", `${options.label} is invalid.`);
  }

  for (const [key, value] of Object.entries(options.target)) {
    if (value && stringChild(data, key) !== value) {
      return tokenResult("TOKEN_INVALID", `${options.label} is invalid.`);
    }
  }

  if (record.expiresAt <= options.now) {
    return tokenResult("TOKEN_EXPIRED", `${options.label} has expired.`);
  }

  return null;
}

export function accountExportDownloadTokenError(
  record: Awaited<ReturnType<MikaBackendRepositories["ephemeral"]["get"]>>,
  exportId: MikaId,
  now: ISODateTime,
): MikaApiFailure | null {
  if (
    !record ||
    record.kind !== "token" ||
    stringChild(record.data ?? {}, "purpose") !== "account_export_download" ||
    stringChild(record.data ?? {}, "exportId") !== exportId
  ) {
    return tokenResult("TOKEN_INVALID", "Account export download token is invalid.");
  }
  if (record.status === "revoked") {
    return tokenResult("DOWNLOAD_REVOKED", "Account export download token has been revoked.");
  }
  if (record.status !== "pending") {
    return tokenResult("TOKEN_USED", "Account export download token has already been used.");
  }
  if (record.expiresAt <= now) {
    return tokenResult("TOKEN_EXPIRED", "Account export download token has expired.");
  }

  return null;
}

export function downloadTokenError(
  record: Awaited<ReturnType<MikaBackendRepositories["ephemeral"]["get"]>>,
  now: ISODateTime,
): MikaApiFailure | null {
  if (
    !record ||
    record.kind !== "token" ||
    stringChild(record.data ?? {}, "purpose") !== "download"
  ) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }
  if (record.status === "revoked") {
    return tokenResult("DOWNLOAD_REVOKED", "Download token has been revoked.");
  }
  if (record.status !== "pending") {
    return tokenResult("TOKEN_USED", "Download token has already been used.");
  }
  if (record.expiresAt <= now) {
    return tokenResult("TOKEN_EXPIRED", "Download token has expired.");
  }

  return null;
}

export async function hashMagicLinkToken(
  input: MikaBackendDependencies,
  token: string,
): Promise<string> {
  return input.hash(`magic-link-token:${token}`);
}

export function magicLinkTokenError(
  record: Awaited<ReturnType<MikaBackendRepositories["ephemeral"]["get"]>>,
  now: ISODateTime,
): MikaApiFailure | null {
  if (!record || record.kind !== "token") {
    return tokenResult("TOKEN_INVALID", "Magic link token is invalid.");
  }
  if (record.status !== "pending") {
    return tokenResult("TOKEN_USED", "Magic link token has already been used.");
  }
  if (record.expiresAt <= now) {
    return tokenResult("TOKEN_EXPIRED", "Magic link token has expired.");
  }

  return null;
}

export async function putCheckoutStatusToken(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutDocument: CheckoutDocument,
  token: string,
): Promise<void> {
  const tokenHash = await hashCheckoutStatusToken(input, token);
  const subjectHash = checkoutAccessSubjectHash(checkoutDocument);
  await input.repositories.ephemeral.put({
    key: tokenHash,
    kind: "token",
    ...(subjectHash ? { subjectHash } : {}),
    status: "active",
    count: 0,
    expiresAt: requiredCheckoutExpiry(checkoutDocument),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data: {
      purpose: "checkout_status",
      checkoutId: checkoutDocument.id,
      provider: checkoutDocument.provider,
      ...(checkoutDocument.customerId ? { customerId: checkoutDocument.customerId } : {}),
      ...(checkoutDocument.sessionId ? { sessionId: checkoutDocument.sessionId } : {}),
    },
  });
}

function requiredCheckoutExpiry(document: CheckoutDocument): ISODateTime {
  if (!document.expiresAt) {
    throw new Error("Checkout status token requires checkout expiry.");
  }

  return document.expiresAt;
}

function checkoutAccessSubjectHash(document: CheckoutDocument): string | undefined {
  if (document.customerId) return formatSubjectRef({ kind: "customer", id: document.customerId });
  return document.sessionId
    ? formatSubjectRef({ kind: "session", id: document.sessionId })
    : undefined;
}

export async function checkoutCancelAccessError(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  document: CheckoutDocument,
  token: string | undefined,
): Promise<MikaApiFailure | null> {
  if (await checkoutBelongsToContext(input, document, ctx)) return null;
  if (token) return validateCheckoutStatusToken(input, ctx.now, token, document);

  return authRequired(
    "Checkout cancellation requires the matching session, customer identity, or checkout status token.",
  );
}

export async function checkoutStatusAccessError(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  document: CheckoutDocument,
  token: string | undefined,
): Promise<MikaApiFailure | null> {
  if (await checkoutBelongsToContext(input, document, ctx)) return null;
  if (token) return validateCheckoutStatusToken(input, ctx.now, token, document);

  return authRequired(
    "Checkout status requires the matching session, customer identity, or checkout status token.",
  );
}
