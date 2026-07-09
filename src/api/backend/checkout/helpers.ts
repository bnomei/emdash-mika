/**
 * Shared checkout helpers: metadata keys, status mapping, expiry, URLs, and document results.
 */
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  type MikaProviderLineItem,
} from "../../../provider";
import { omitUndefined } from "../../../internal/object";
import type { CheckoutLine } from "../../../types/aggregates";
import type { CheckoutDocument } from "../../../types/documents";
import { createISODateTime, createOrderId } from "../../../types/primitives";
import type {
  CheckoutProviderStatus,
  CheckoutStatus,
  ISODateTime,
  JsonObject,
  JsonValue,
  MikaId,
  ProviderName,
} from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import type {
  CheckoutCustomerInput,
  CheckoutSessionDTO,
  MikaApiResult,
  StartCheckoutInput,
} from "../../types";
import { checkoutFailedReplay, type MikaApiFailure } from "../errors";
import { checkoutStatusIsTerminal } from "../../lifecycle";
import type { MikaBackendDependencies } from "../ports";
import {
  metadataMikaId,
  metadataString,
  safeRequestReturnPath,
  stableJsonStringify,
} from "../shared";

export const CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "checkoutIdempotencyInputHash";
export const CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY = "checkoutCustomerEmail";
export const CHECKOUT_CUSTOMER_NAME_METADATA_KEY = "checkoutCustomerName";
export const CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY = "checkoutCustomerCompany";
export const CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY = "checkoutCustomerVatId";
// Internal checkout keys: stripped from provider metadata and omitted from persisted custom fields.
export const CHECKOUT_INTERNAL_METADATA_KEYS = new Set<string>([
  "checkoutIdempotencyKey",
  CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY,
  "checkoutProviderStatus",
  "checkoutRedirectUrl",
  "checkoutPersistenceFailed",
  "checkoutOrderId",
  CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY,
  CHECKOUT_CUSTOMER_NAME_METADATA_KEY,
  CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY,
  CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY,
]);
// Delegated-payment proof keys: never persisted on checkout documents (token, authorization hash).
export const DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS = new Set<string>([
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
]);
export const CHECKOUT_PERSISTED_METADATA_OMIT_KEYS = new Set<string>([
  ...CHECKOUT_INTERNAL_METADATA_KEYS,
  ...DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
]);

export function checkoutMetadata(input: {
  readonly customFields?: JsonObject;
  readonly customer?: CheckoutCustomerInput;
  readonly idempotencyInputHash?: string;
  readonly idempotencyKey?: string;
  readonly providerSession: {
    readonly status: CheckoutSessionDTO["status"];
    readonly redirectUrl?: string;
  };
}): JsonObject {
  return {
    ...checkoutPersistedCustomMetadata(input.customFields),
    ...checkoutCustomerToMetadata(input.customer),
    checkoutProviderStatus: input.providerSession.status,
    ...(input.idempotencyKey ? { checkoutIdempotencyKey: input.idempotencyKey } : {}),
    ...(input.idempotencyInputHash
      ? { [CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY]: input.idempotencyInputHash }
      : {}),
    ...(input.providerSession.redirectUrl
      ? { checkoutRedirectUrl: input.providerSession.redirectUrl }
      : {}),
  };
}

export function checkoutCustomerToMetadata(
  customer: CheckoutCustomerInput | undefined,
): JsonObject {
  return {
    ...(customer?.email?.trim()
      ? { [CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY]: customer.email.trim() }
      : {}),
    ...(customer?.name?.trim()
      ? { [CHECKOUT_CUSTOMER_NAME_METADATA_KEY]: customer.name.trim() }
      : {}),
    ...(customer?.company?.trim()
      ? { [CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY]: customer.company.trim() }
      : {}),
    ...(customer?.vatId?.trim()
      ? { [CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY]: customer.vatId.trim() }
      : {}),
  };
}

export function checkoutCustomerFromMetadata(
  metadata: JsonObject | undefined,
): CheckoutCustomerInput {
  const email = metadataString(metadata, CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY);
  const name = metadataString(metadata, CHECKOUT_CUSTOMER_NAME_METADATA_KEY);
  const company = metadataString(metadata, CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY);
  const vatId = metadataString(metadata, CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY);

  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(company ? { company } : {}),
    ...(vatId ? { vatId } : {}),
  };
}

export function checkoutCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return filterJsonObject(customFields, CHECKOUT_INTERNAL_METADATA_KEYS);
}

export function checkoutPersistedCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return filterJsonObject(customFields, CHECKOUT_PERSISTED_METADATA_OMIT_KEYS);
}

export function filterJsonObject(
  value: JsonObject | undefined,
  omittedKeys: ReadonlySet<string>,
): JsonObject {
  const filtered: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value ?? {})) {
    if (!omittedKeys.has(key)) {
      filtered[key] = child;
    }
  }

  return filtered;
}

export async function checkoutIdempotencyInputHash(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<string> {
  return input.hash(
    stableJsonStringify({
      context: {
        customerId: ctx.customerId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
      },
      input: checkoutInput,
    }),
  );
}

export function checkoutStoredIdempotencyInputHash(document: CheckoutDocument): string | undefined {
  return (
    document.checkoutIdempotencyInputHash ??
    metadataString(document.aggregate.metadata, CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY)
  );
}

export function checkoutDocumentResult(
  document: CheckoutDocument,
): MikaApiResult<CheckoutSessionDTO> {
  if (document.status === "failed") {
    return checkoutFailedReplay(document.id);
  }

  return checkoutDocumentSuccessResult(document);
}

/**
 * Persists a not-yet-settled checkout via the session port's optimistic CAS when available, so a
 * concurrent completion (payment webhook) is never clobbered. A host session port that does not
 * implement putCheckoutIfStatus falls back to a blind put (the prior behavior).
 */
export async function putCheckoutIfNotSettled(
  input: MikaBackendDependencies,
  checkout: CheckoutDocument,
  allowedFromStatuses: readonly CheckoutStatus[],
): Promise<CheckoutDocument | null> {
  const session = input.repositories.session;
  if (session.putCheckoutIfStatus) {
    return session.putCheckoutIfStatus(checkout, allowedFromStatuses);
  }

  await session.put(checkout);
  return checkout;
}

export function checkoutDocumentSuccessResult(
  document: CheckoutDocument,
): MikaApiResult<CheckoutSessionDTO> {
  const rawRedirectUrl =
    document.redirectUrl ?? metadataString(document.aggregate.metadata, "checkoutRedirectUrl");
  const status =
    document.providerStatus ??
    metadataString(document.aggregate.metadata, "checkoutProviderStatus") ??
    checkoutSessionStatus(document.status);
  const sessionStatus = checkoutSessionStatus(status);
  const redirectUrl = checkoutStatusAllowsRedirect(document.status, sessionStatus)
    ? rawRedirectUrl
    : undefined;
  const orderId =
    document.orderId ??
    (() => {
      const raw = metadataMikaId(document.aggregate.metadata, "checkoutOrderId");
      return raw ? createOrderId(raw) : undefined;
    })();

  return {
    ok: true,
    status: 200,
    data: omitUndefined({
      id: document.id,
      status: sessionStatus,
      mode: document.aggregate.mode,
      provider: document.provider,
      redirectUrl,
      expiresAt: document.expiresAt,
      paymentPending: status === "pending" ? true : undefined,
      orderId,
    }),
    ...(redirectUrl ? { effects: [{ type: "redirect" as const, url: redirectUrl }] } : {}),
  };
}

export function checkoutStatusAllowsRedirect(
  documentStatus: CheckoutStatus,
  sessionStatus: CheckoutSessionDTO["status"],
): boolean {
  // Terminal-but-not-completed (cancelled/expired/failed) never redirects; a completed checkout
  // still can, so it falls through to the session-status check.
  if (checkoutStatusIsTerminal(documentStatus) && documentStatus !== "completed") {
    return false;
  }

  return (
    sessionStatus === "created" ||
    sessionStatus === "redirected" ||
    sessionStatus === "pending" ||
    sessionStatus === "completed"
  );
}

export function checkoutBindingError(document: CheckoutDocument): MikaApiFailure | null {
  if (
    document.provider === document.aggregate.binding.provider &&
    document.providerCheckoutId === document.aggregate.binding.providerCheckoutId
  ) {
    return null;
  }

  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_BINDING_MISMATCH",
      message: `Checkout '${document.id}' binding does not match stored provider state.`,
    },
  };
}

export function checkoutIsExpired(
  input: MikaBackendDependencies,
  document: CheckoutDocument,
): boolean {
  if (document.status === "expired") return true;
  if (!checkoutStatusCanExpire(document.status)) return false;
  if (!document.expiresAt) return false;

  return new Date(document.expiresAt).getTime() <= input.now().getTime();
}

export function checkoutStatusCanExpire(status: CheckoutStatus): boolean {
  return status === "created" || status === "redirected";
}

export function checkoutStatusExpired(document: CheckoutDocument): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_EXPIRED",
      message: `Checkout '${document.id}' has expired.`,
    },
  };
}

export function checkoutFailedMetadata(metadata: JsonObject | undefined): JsonObject {
  return {
    ...Object.fromEntries(
      Object.entries(metadata ?? {}).filter(
        ([key]) => key !== "checkoutRedirectUrl" && key !== "checkoutProviderStatus",
      ),
    ),
    checkoutPersistenceFailed: true,
    checkoutProviderStatus: "failed",
  };
}

export function checkoutLineToProviderLine(
  provider: ProviderName,
  line: CheckoutLine,
): MikaProviderLineItem {
  const providerRef = line.item.providerRefs?.find((ref) => ref.provider === provider);

  return omitUndefined({
    sellableId: line.item.sellableId,
    priceId: line.item.priceId,
    contentRef: line.item.content,
    sku: line.item.sku,
    title: line.item.titleSnapshot,
    variantKey: line.item.variantKey,
    variantOptions: line.item.variantOptions,
    providerProductId: providerRef?.productId,
    providerPriceId: providerRef?.priceId,
    quantity: line.quantity,
    unitAmount: line.item.unitAmount,
    currency: line.item.currency,
    mode: line.item.mode,
    fulfillmentKind: line.item.fulfillmentKind,
    entitlementKey: line.item.entitlementKey,
    interval: line.item.interval,
    intervalCount: line.item.intervalCount,
    metadata: line.metadata ?? line.item.metadata,
  });
}

export function checkoutSuccessUrl(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  checkoutId: MikaId,
  statusToken: string,
): string {
  const url = new URL(checkoutSuccessTarget(input, ctx, checkoutInput), ctx.url);
  url.searchParams.set("checkoutId", checkoutId);
  url.searchParams.set("token", statusToken);

  return url.toString();
}

export function checkoutCancelUrl(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  checkoutId: MikaId,
  statusToken: string,
): string {
  const url = new URL(checkoutCancelTarget(input, ctx, checkoutInput), ctx.url);
  url.searchParams.set("checkoutId", checkoutId);
  url.searchParams.set("token", statusToken);

  return url.toString();
}

export function checkoutSuccessTarget(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return checkoutInput.successPath === undefined
    ? (input.config?.checkout?.successUrl ?? "/checkout/success")
    : safeRequestReturnPath(ctx, checkoutInput.successPath, "/checkout/success");
}

export function checkoutCancelTarget(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return checkoutInput.cancelPath === undefined
    ? (input.config?.checkout?.cancelUrl ?? "/checkout/cancel")
    : safeRequestReturnPath(ctx, checkoutInput.cancelPath, "/checkout/cancel");
}

export function checkoutExpiresAt(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
): ISODateTime {
  const ttlMs = input.config?.checkout?.ttlMs ?? 15 * 60_000;

  return createISODateTime(new Date(new Date(ctx.now).getTime() + ttlMs).toISOString());
}

export function checkoutDocumentStatus(status: CheckoutSessionDTO["status"]): CheckoutStatus {
  // Exhaustive over CheckoutProviderStatus (enforced by noImplicitReturns): a new transport-only
  // status fails the build instead of silently mis-mapping.
  switch (status) {
    case "pending":
      return "created";
    case "binding_mismatch":
      return "failed";
    case "created":
    case "redirected":
    case "completed":
    case "cancelled":
    case "expired":
    case "failed":
      return status;
  }
}

export const CHECKOUT_PROVIDER_STATUSES = [
  "created",
  "redirected",
  "completed",
  "cancelled",
  "expired",
  "failed",
  "pending",
  "binding_mismatch",
] as const satisfies readonly CheckoutProviderStatus[];

export type AssertAllCheckoutProviderStatuses =
  Exclude<CheckoutProviderStatus, (typeof CHECKOUT_PROVIDER_STATUSES)[number]> extends never
    ? true
    : never;
export const _assertAllCheckoutProviderStatuses: AssertAllCheckoutProviderStatuses = true;
void _assertAllCheckoutProviderStatuses;

export function isCheckoutProviderStatus(value: string): value is CheckoutProviderStatus {
  return (CHECKOUT_PROVIDER_STATUSES as readonly string[]).includes(value);
}

export function checkoutSessionStatus(status: string): CheckoutSessionDTO["status"] {
  return isCheckoutProviderStatus(status) ? status : "failed";
}
