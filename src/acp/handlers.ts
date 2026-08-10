/**
 * ACP checkout HTTP handlers, request validation schemas, and order webhook helpers.
 */
import { z } from "astro/zod";

import {
  createMikaRequestContext,
  type MikaRequestContext,
  type MikaSessionAccess,
} from "../api/context";
import type {
  CartDTO,
  CheckoutCustomerInput,
  CheckoutPreviewDTO,
  CheckoutSessionDTO,
  MikaApiResult,
} from "../api/types";
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
} from "../provider";
import { omitUndefined } from "../internal/object";
import {
  createCartId,
  createCheckoutSessionId,
  createPriceId,
  createProviderName,
  createSellableId,
  type PriceId,
  type SellableId,
} from "../types/primitives";
import type {
  MikaAcpAddress,
  MikaAcpBuyer,
  MikaAcpCheckoutSessionStatus,
  MikaAcpItem,
  MikaAcpSessionRecord,
  MikaAcpSessionStore,
} from "../api/acp-session";
import {
  MIKA_ACP_API_VERSION,
  MIKA_ACP_DEFAULT_IDEMPOTENCY_CLAIM_TTL_MS,
  MIKA_ACP_DEFAULT_SESSION_PREFIX,
} from "./constants";
import type {
  CreateMikaAcpCheckoutHandlersOptions,
  MikaAcpCheckoutCompleteRequest,
  MikaAcpCheckoutCreateRequest,
  MikaAcpCheckoutHandlers,
  MikaAcpCheckoutSession,
  MikaAcpCheckoutUpdateRequest,
  MikaAcpOrderWebhookEvent,
  MikaAcpPaymentData,
} from "./types";
import {
  createDefaultAcpSessionId,
  cryptoSafeId,
  hmacBase64,
  hmacBase64Url,
  acpCanonicalSignaturePayload,
  acpSignatureTimestampIsFresh,
  safeStringEqual,
} from "./crypto";
import {
  acpAbsoluteUri,
  acpCheckoutLink,
  acpCheckoutSessionFromState,
  acpCheckoutSessionFromSnapshot,
  acpError,
  acpErrorFromResult,
  acpJson,
  acpSessionSnapshotFromQuote,
  acpStatusFromCart,
  acpUnhandledFailure,
  addMilliseconds,
  buyerToCustomer,
  emptyQuote,
  nowIso,
  providerToAcp,
  resultMessage,
} from "./mappers";
import {
  acpExpiredError,
  acpRecordIsExpired,
  acpSessionTtlMs,
  acpTerminalError,
  acpTerminalRetentionMs,
  expireAcpRecordIfNeeded,
  nextAcpVersion,
  putAcpRecordRetryingIncidentalExpiry,
} from "./session-store";

export function acpOptional<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return schema.optional();
}

export function acpExactObject<T extends object>(schema: z.ZodTypeAny): z.ZodType<T> {
  return schema.transform((value) => omitUndefined(value as T)) as unknown as z.ZodType<T>;
}

export const acpBuyerSchema = acpExactObject<MikaAcpBuyer>(
  z
    .object({
      first_name: z.string(),
      last_name: z.string(),
      email: z.string().email(),
      phone_number: acpOptional(z.string()),
    })
    .strict(),
);

export const acpItemSchema = z
  .object({
    id: z.string().min(1),
    quantity: z.number().positive(),
  })
  .strict() satisfies z.ZodType<MikaAcpItem>;

export const acpAddressSchema = acpExactObject<MikaAcpAddress>(
  z
    .object({
      name: z.string(),
      line_one: z.string(),
      line_two: acpOptional(z.string()),
      city: z.string(),
      state: z.string(),
      country: z.string(),
      postal_code: z.string(),
    })
    .strict(),
);

export const acpPaymentDataSchema = acpExactObject<MikaAcpPaymentData>(
  z
    .object({
      token: z.string().min(1),
      provider: z.literal("stripe"),
      billing_address: acpOptional(acpAddressSchema),
    })
    .strict(),
);

export const acpCheckoutCreateRequestSchema = acpExactObject<MikaAcpCheckoutCreateRequest>(
  z
    .object({
      buyer: acpOptional(acpBuyerSchema),
      items: z.array(acpItemSchema).min(1, "items must be a non-empty array."),
      fulfillment_address: acpOptional(acpAddressSchema),
    })
    .strict(),
);

export const acpCheckoutUpdateRequestSchema = acpExactObject<MikaAcpCheckoutUpdateRequest>(
  z
    .object({
      buyer: acpOptional(acpBuyerSchema),
      items: acpOptional(z.array(acpItemSchema)),
      fulfillment_address: acpOptional(acpAddressSchema),
      fulfillment_option_id: acpOptional(z.string()),
    })
    .strict(),
);

export const acpCheckoutCompleteRequestSchema = acpExactObject<MikaAcpCheckoutCompleteRequest>(
  z
    .object({
      buyer: acpOptional(acpBuyerSchema),
      payment_data: acpPaymentDataSchema,
    })
    .strict(),
);

/** Creates authenticated ACP checkout HTTP handlers backed by MikaApi cart and checkout ops. */
export function createMikaAcpCheckoutHandlers(
  options: CreateMikaAcpCheckoutHandlersOptions,
): MikaAcpCheckoutHandlers {
  if (!options.apiKey && !options.signatureSecret) {
    throw new Error(
      "createMikaAcpCheckoutHandlers requires an apiKey or signatureSecret; refusing to expose ACP checkout sessions without authentication.",
    );
  }
  if (typeof options.orderUrl !== "function") {
    throw new Error(
      "createMikaAcpCheckoutHandlers requires orderUrl so completed sessions conform to ACP.",
    );
  }
  for (const link of options.seller.links) acpCheckoutLink(link);
  assertAcpAtomicIdempotencyStore(options.store);

  return {
    create: async (request) =>
      safelyHandleAcpRequest(options, "create", request, () => handleAcpCreate(options, request)),
    update: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "update", request, () =>
        handleAcpUpdate(options, request, checkoutSessionId),
      ),
    complete: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "complete", request, () =>
        handleAcpComplete(options, request, checkoutSessionId),
      ),
    get: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "get", request, () =>
        handleAcpGet(options, request, checkoutSessionId),
      ),
    cancel: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "cancel", request, () =>
        handleAcpCancel(options, request, checkoutSessionId),
      ),
  };
}

/** Reports a swallowed ACP failure to the host observer; never throws. */
function observeAcpError(
  options: Pick<CreateMikaAcpCheckoutHandlersOptions, "onError">,
  scope: string,
  error: unknown,
): void {
  try {
    options.onError?.({ scope, error });
  } catch {
    // Observer bugs must not break the protocol response.
  }
}

// Maps unexpected throws to a generic ACP 500 without leaking stack details.
async function safelyHandleAcpRequest(
  options: CreateMikaAcpCheckoutHandlersOptions,
  scope: string,
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    observeAcpError(options, `acp.${scope}.unhandled`, error);

    return acpUnhandledFailure(request);
  }
}

function assertAcpAtomicIdempotencyStore(store: MikaAcpSessionStore): void {
  if (
    typeof store.claimIdempotencyKey !== "function" ||
    typeof store.bindIdempotencyKey !== "function" ||
    typeof store.releaseIdempotencyKey !== "function" ||
    typeof store.putIfUnchanged !== "function"
  ) {
    throw new Error(
      "createMikaAcpCheckoutHandlers requires an ACP session store with atomic claimIdempotencyKey, bindIdempotencyKey, releaseIdempotencyKey, and putIfUnchanged methods.",
    );
  }
}

/** Factory for ACP `order_created` / `order_updated` webhook event payloads. */
export function createMikaAcpOrderWebhookEvent(input: {
  readonly checkoutSessionId: string;
  readonly permalinkUrl: string;
  readonly status?: MikaAcpOrderWebhookEvent["data"]["status"];
  readonly type?: MikaAcpOrderWebhookEvent["type"];
  readonly refunds?: MikaAcpOrderWebhookEvent["data"]["refunds"];
}): MikaAcpOrderWebhookEvent {
  return {
    type: input.type ?? "order_updated",
    data: {
      type: "order",
      checkout_session_id: input.checkoutSessionId,
      permalink_url: input.permalinkUrl,
      status: input.status ?? "confirmed",
      refunds: input.refunds ?? [],
    },
  };
}

/** Signs an ACP order webhook body with the merchant HMAC header expected by receivers. */
export async function signMikaAcpWebhook(input: {
  readonly payload: string;
  readonly secret: string;
  readonly merchantName: string;
}): Promise<Headers> {
  const signature = await hmacBase64(input.secret, input.payload);
  const headers = new Headers();
  headers.set(`${input.merchantName}-Signature`, signature);
  headers.set("Content-Type", "application/json");

  return headers;
}

export async function handleAcpCreate(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  const body = await readAcpBody(request, acpCheckoutCreateRequestSchema);
  if (!body.ok) return acpError(request, 400, "invalid_request", body.message, body.path);

  const now = nowIso(options);
  // id = ACP URL session; sessionId = isolated Mika cart/checkout session.
  const session: MikaAcpSessionRecord = omitUndefined({
    id: options.createSessionId?.() ?? createDefaultAcpSessionId(),
    sessionId: `${MIKA_ACP_DEFAULT_SESSION_PREFIX}:${cryptoSafeId()}`,
    status: "not_ready_for_payment",
    buyer: body.data.buyer,
    items: body.data.items,
    fulfillmentAddress: body.data.fulfillment_address,
    provider: options.provider ?? createProviderName("stripe"),
    expiresAt: addMilliseconds(now, acpSessionTtlMs(options)),
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  const idempotency = await beginAcpIdempotency(options, request, session.id, 201, true);
  if (!idempotency.ok) return idempotency.response;

  try {
    const reconciled = await reconcileAcpCart(options, request, session, body.data.items);
    if (!reconciled.ok) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return reconciled.response;
    }
    await options.store.put(reconciled.record);
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, reconciled.record), 201);
  } catch (error) {
    observeAcpError(options, "acp.create.unhandled", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
}

export async function handleAcpUpdate(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);
  if (acpRecordIsExpired(record, nowIso(options))) return acpExpiredError(request);
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  try {
    const terminalStatus = await acpTerminalStatus(options, record);
    if (terminalStatus) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpTerminalError(request, terminalStatus, "updated");
    }

    const body = await readAcpBody(request, acpCheckoutUpdateRequestSchema);
    if (!body.ok) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(request, 400, "invalid_request", body.message, body.path);
    }

    // Item mutations are blocked once checkout.start has bound a checkoutId.
    if (record.checkoutId && body.data.items) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(
        request,
        409,
        "invalid_request",
        "Cart items cannot be changed after checkout has started.",
      );
    }

    const next: MikaAcpSessionRecord = omitUndefined({
      ...record,
      buyer: body.data.buyer ?? record.buyer,
      items: body.data.items ?? record.items,
      fulfillmentAddress: body.data.fulfillment_address ?? record.fulfillmentAddress,
      fulfillmentOptionId: body.data.fulfillment_option_id ?? record.fulfillmentOptionId,
      expiresAt: addMilliseconds(nowIso(options), acpSessionTtlMs(options)),
      updatedAt: nowIso(options),
      version: nextAcpVersion(record.version),
    });
    const reconciled = body.data.items
      ? await reconcileAcpCart(options, request, next, body.data.items)
      : { ok: true as const, record: next };
    if (!reconciled.ok) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return reconciled.response;
    }
    const written = await options.store.putIfUnchanged(reconciled.record, record.version);
    if (!written) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session was modified concurrently; refetch and retry the update.",
      );
    }
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, reconciled.record), 200);
  } catch (error) {
    observeAcpError(options, "acp.update.unhandled", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
}

export async function handleAcpComplete(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);
  if (acpRecordIsExpired(record, nowIso(options))) return acpExpiredError(request);
  // Captured now, before any further mutation below, as the CAS baseline for this handler's own
  // writes — see the putIfUnchanged calls at the end of this function.
  const expectedVersion = record.version;
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  // Second idempotency lease serializes concurrent completion on the same session.
  let completion: MikaAcpIdempotencyBegin;
  try {
    completion = await beginAcpIdempotency(
      options,
      request,
      checkoutSessionId,
      409,
      false,
      `acp_complete_lock:${checkoutSessionId}`,
    );
  } catch (error) {
    observeAcpError(options, "acp.complete.claimCompletionLock", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
  if (!completion.ok) {
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return completion.response;
  }
  // Every exit funnels through `finally`: success paths flag the main lease for commit (so
  // Idempotency-Key replays return the committed record); all other exits release both leases.
  let commitMainLease = false;
  try {
    const terminalStatus = await acpTerminalStatus(options, record);
    if (terminalStatus === "completed") {
      commitMainLease = true;

      return acpJson(request, await recordToAcpSession(options, request, record), 200);
    }
    if (terminalStatus === "canceled") {
      return acpTerminalError(request, terminalStatus, "completed");
    }

    if (record.checkoutId) {
      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session already has a payment attempt in progress. Create a new ACP checkout session to retry payment.",
      );
    }

    const body = await readAcpBody(request, acpCheckoutCompleteRequestSchema);
    if (!body.ok) {
      return acpError(request, 400, "invalid_request", body.message, body.path);
    }
    providerToAcp(record.provider);

    const customer = buyerToCustomer(body.data.buyer ?? record.buyer);
    const preview = await previewAcpCheckout(options, request, record, customer);
    if (!preview.ok) {
      return acpErrorFromResult(request, preview);
    }
    if (!preview.data.inputHash || preview.data.status !== "requires_payment_authorization") {
      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session is not ready for payment.",
      );
    }

    // Resolve and validate the permalink before checkout.start can charge or persist provider
    // state. The validated value is stored on the ACP record so replays cannot drift.
    const orderUrl = acpAbsoluteUri(options.orderUrl({ sessionId: record.id }), "order URL");
    const proofId = `acp_payment_authorization_${cryptoSafeId()}`;
    const ctx = acpContext(options, request, record.sessionId);
    const checkout = await options.api.checkout.start(
      ctx,
      omitUndefined({
        cartId: record.cartId,
        provider: record.provider,
        customer,
        customFields: {
          [MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: body.data.payment_data.token,
          [MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY]: body.data.payment_data.provider,
          [MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY]: proofId,
          [MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY]: record.id,
          [MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY]: preview.data.inputHash,
        },
      }),
    );
    if (!checkout.ok) {
      return acpErrorFromResult(request, checkout);
    }
    if (acpCheckoutStartTerminalStatus(checkout.data.status)) {
      // Compensating write: reflect this attempt's own terminal failure. If it loses the CAS
      // race to a genuine competing decision, someone else already moved the session forward
      // concurrently (reverting to not_ready_for_payment over their write would be wrong) —
      // report what's actually persisted instead of this attempt's now-moot terminal-failure
      // verdict. A loss to nothing more than a bystander expiry sweep isn't a real conflict and
      // is retried past, same as the final completion write below — otherwise this attempt's own
      // legitimate buyer/etc. update would be silently lost to an unrelated concurrent GET.
      const buildReverted = (version: number | undefined): MikaAcpSessionRecord =>
        omitUndefined({
          ...record,
          buyer: body.data.buyer ?? record.buyer,
          status: "not_ready_for_payment",
          updatedAt: nowIso(options),
          version: nextAcpVersion(version),
        });
      const reverted = await putAcpRecordRetryingIncidentalExpiry(
        options,
        checkoutSessionId,
        record,
        buildReverted,
      );
      if (!reverted) {
        commitMainLease = true;
        const current =
          (await options.store.get(checkoutSessionId)) ?? buildReverted(expectedVersion);

        return acpJson(request, await recordToAcpSession(options, request, current), 200);
      }

      return acpError(
        request,
        409,
        "invalid_request",
        `Checkout session is ${checkout.data.status} and cannot be completed.`,
      );
    }
    if (!preview.data.quote) {
      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session is not ready for payment.",
      );
    }

    const now = nowIso(options);

    const completedBase: Omit<MikaAcpSessionRecord, "version"> = omitUndefined({
      ...record,
      buyer: body.data.buyer ?? record.buyer,
      checkoutId: createCheckoutSessionId(checkout.data.id),
      orderUrl,
      status: checkout.data.status === "completed" ? "completed" : "ready_for_payment",
      paymentAuthorizationId: proofId,
      quoteInputHash: preview.data.inputHash,
      quoteSnapshot: acpSessionSnapshotFromQuote(
        record,
        preview.data.quote,
        now,
        preview.data.inputHash,
      ),
      ...(checkout.data.status === "completed"
        ? { purgeAt: addMilliseconds(now, acpTerminalRetentionMs(options)) }
        : {}),
      updatedAt: now,
    });

    // checkout.start above already happened and cannot be undone from here, so the write below
    // must land somewhere sound. A CAS loss against a genuine competing decision (another
    // completion, cancellation, or checkout attempt) means this attempt truly lost and must defer
    // to what's persisted. A CAS loss against nothing more than expireAcpRecordIfNeeded's lazy
    // sweep ticking on a bystander request (e.g. a plain GET polling this session while this
    // handler was merely slow, not crashed) isn't a real conflict — retry past it a bounded number
    // of times rather than silently discarding a successful payment.
    const buildCompleted = (version: number | undefined): MikaAcpSessionRecord =>
      omitUndefined({
        ...completedBase,
        version: nextAcpVersion(version),
      });
    const persisted = await putAcpRecordRetryingIncidentalExpiry(
      options,
      checkoutSessionId,
      record,
      buildCompleted,
    );
    commitMainLease = true;
    if (!persisted) {
      // Lost to a genuine competing decision — report whatever is actually stored instead of this
      // attempt's own now-stale computation, same as an idempotency replay. The `?? buildCompleted`
      // fallback only matters if the record vanished between the failed write and this read (e.g.
      // a concurrent purge sweep) — far-fetched given purgeAt retention is minutes-to-days by
      // default, but falling back to this attempt's own view is still strictly better than a 500
      // for a payment that, per checkout.start above, already genuinely went through.
      const current =
        (await options.store.get(checkoutSessionId)) ?? buildCompleted(expectedVersion);

      return acpJson(request, await recordToAcpSession(options, request, current), 200);
    }

    return acpJson(request, await recordToAcpSession(options, request, persisted), 200);
  } catch (error) {
    observeAcpError(options, "acp.complete.unhandled", error);

    return acpUnhandledFailure(request);
  } finally {
    if (commitMainLease) {
      try {
        await commitAcpIdempotency(options, idempotency.lease);
      } catch (error) {
        // Bind failed after a committed session: release instead, so a replayed request rebuilds
        // the committed response from the stored record rather than staying in_progress.
        observeAcpError(options, "acp.complete.bindIdempotency", error);
        commitMainLease = false;
      }
    }
    if (!commitMainLease) await releaseAcpIdempotencyQuietly(options, idempotency.lease);
    await releaseAcpIdempotencyQuietly(options, completion.lease);
  }
}

// checkout.start can return terminal failure states that must block ACP complete with 409.
export function acpCheckoutStartTerminalStatus(status: CheckoutSessionDTO["status"]): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "binding_mismatch"
  );
}

export async function handleAcpGet(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, false);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);

  return acpJson(request, await recordToAcpSession(options, request, record), 200);
}

export async function handleAcpCancel(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);
  if (acpRecordIsExpired(record, nowIso(options))) return acpExpiredError(request);
  const expectedVersion = record.version;
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  try {
    const terminalStatus = await acpTerminalStatus(options, record);
    if (terminalStatus === "completed") {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpTerminalError(request, terminalStatus, "canceled");
    }
    if (terminalStatus === "canceled") {
      await commitAcpIdempotency(options, idempotency.lease);

      return acpJson(request, await recordToAcpSession(options, request, record), 200);
    }

    if (record.checkoutId) {
      const cancellation = await options.api.checkout.cancel(
        acpContext(options, request, record.sessionId),
        { checkoutId: record.checkoutId },
      );
      if (!cancellation.ok && cancellation.status !== 404) {
        await releaseAcpIdempotency(options, idempotency.lease);

        return acpErrorFromResult(request, cancellation);
      }
    }

    const canceled: MikaAcpSessionRecord = {
      ...record,
      status: "canceled",
      purgeAt: addMilliseconds(nowIso(options), acpTerminalRetentionMs(options)),
      updatedAt: nowIso(options),
      version: nextAcpVersion(expectedVersion),
    };
    const written = await options.store.putIfUnchanged(canceled, expectedVersion);
    await commitAcpIdempotency(options, idempotency.lease);
    if (!written) {
      // Lost the race — another concurrent request already wrote a newer version (e.g. its own
      // cancel, or a completion that landed first). Report whatever's actually persisted rather
      // than this handler's own stale computation, same as handleAcpComplete's CAS-loss path.
      const current = (await options.store.get(checkoutSessionId)) ?? canceled;

      return acpJson(request, await recordToAcpSession(options, request, current), 200);
    }

    return acpJson(request, await recordToAcpSession(options, request, canceled), 200);
  } catch (error) {
    observeAcpError(options, "acp.cancel.unhandled", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
}

export interface MikaAcpIdempotencyLease {
  readonly key: string;
  readonly id: string;
  readonly fencingToken: string;
}

export type MikaAcpIdempotencyBegin =
  | { readonly ok: true; readonly lease?: MikaAcpIdempotencyLease }
  | { readonly ok: false; readonly response: Response };

export async function beginAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
  replayStatus: number,
  replayExistingBinding = false,
  storeKeyOverride?: string,
): Promise<MikaAcpIdempotencyBegin> {
  const key = storeKeyOverride ?? acpIdempotencyStoreKey(request);
  if (!key) return { ok: true };

  const now = nowIso(options);
  const claim = await options.store.claimIdempotencyKey(key, checkoutSessionId, {
    now,
    expiresAt: addMilliseconds(
      now,
      options.idempotencyClaimTtlMs ?? MIKA_ACP_DEFAULT_IDEMPOTENCY_CLAIM_TTL_MS,
    ),
  });
  if (claim.status === "claimed") {
    return { ok: true, lease: { key, id: checkoutSessionId, fencingToken: claim.fencingToken } };
  }
  if (claim.status === "replayed") {
    return {
      ok: false,
      response: acpJson(
        request,
        await recordToAcpSession(options, request, claim.record),
        replayStatus,
      ),
    };
  }

  if (replayExistingBinding && claim.status === "conflict") {
    const bound = await options.store.get(claim.id);

    return {
      ok: false,
      response: bound
        ? acpJson(request, await recordToAcpSession(options, request, bound), replayStatus)
        : acpError(
            request,
            409,
            "request_not_idempotent",
            "Idempotency-Key replay is already in progress.",
          ),
    };
  }

  return {
    ok: false,
    response: acpError(
      request,
      409,
      "request_not_idempotent",
      claim.status === "conflict"
        ? "Idempotency-Key is already bound to another checkout session."
        : "Idempotency-Key replay is already in progress.",
    ),
  };
}

export async function commitAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  if (lease) await options.store.bindIdempotencyKey(lease.key, lease.id, lease.fencingToken);
}

export async function releaseAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  if (lease) await options.store.releaseIdempotencyKey(lease.key, lease.id, lease.fencingToken);
}

export async function releaseAcpIdempotencyQuietly(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  try {
    await releaseAcpIdempotency(options, lease);
  } catch (error) {
    // Best-effort cleanup after an ACP storage/API failure; callers still receive a protocol error.
    observeAcpError(options, "acp.idempotency.release", error);
  }
}

export function acpIdempotencyStoreKey(request: Request): string | undefined {
  const key = request.headers.get("Idempotency-Key");
  if (!key) return undefined;

  return `${request.method}:${new URL(request.url).pathname}:${key}`;
}

export async function acpTerminalStatus(
  options: CreateMikaAcpCheckoutHandlersOptions,
  record: MikaAcpSessionRecord,
): Promise<MikaAcpCheckoutSessionStatus | undefined> {
  if (record.status === "completed" || record.status === "canceled") return record.status;
  if (!record.checkoutId) return undefined;
  const checkout = await options.api.checkout.status(
    createMikaRequestContext(
      omitUndefined({
        sessionId: record.sessionId,
        session: createStaticSession(record.sessionId),
        now: options.now?.(),
      }),
    ),
    { checkoutId: record.checkoutId },
  );
  if (!checkout.ok) return undefined;
  if (checkout.data.status === "completed") return "completed";
  if (checkout.data.status === "cancelled") return "canceled";

  return undefined;
}

export async function reconcileAcpCart(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
  items: readonly MikaAcpItem[],
): Promise<
  | { readonly ok: true; readonly record: MikaAcpSessionRecord }
  | { readonly ok: false; readonly response: Response }
> {
  const ctx = acpContext(options, request, record.sessionId);
  const cartResult = await options.api.cart.get(ctx);
  if (!cartResult.ok) return { ok: false, response: acpErrorFromResult(request, cartResult) };

  const parsedItems: {
    readonly item: MikaAcpItem;
    readonly ids: ReturnType<typeof parseAcpItemId>;
    readonly index: number;
  }[] = [];
  for (const [index, item] of items.entries()) {
    try {
      parsedItems.push({ item, ids: parseAcpItemId(item.id), index });
    } catch (error) {
      return {
        ok: false,
        response: acpError(
          request,
          400,
          "invalid_request",
          error instanceof Error ? error.message : "ACP item id is invalid.",
          `$.items[${index}].id`,
        ),
      };
    }
  }

  const originalCart = cartResult.data;
  // Wipe-and-rebuild cart sync; restore originalCart on any add/remove failure.
  let cart = cartResult.data;
  for (const line of cart.items) {
    const removed = await options.api.cart.remove(ctx, { lineId: line.id });
    if (!removed.ok) {
      const rollbackMessage = await restoreAcpCart(options, ctx, originalCart);

      return {
        ok: false,
        response: acpErrorFromResult(
          request,
          removed,
          rollbackMessage
            ? `${resultMessage(removed)} Cart rollback failed: ${rollbackMessage}`
            : undefined,
        ),
      };
    }
    cart = removed.data;
  }

  for (const { item, ids, index } of parsedItems) {
    const added = await options.api.cart.add(
      ctx,
      omitUndefined({
        sellableId: ids.sellableId,
        priceId: ids.priceId,
        quantity: item.quantity,
      }),
    );
    if (!added.ok) {
      const rollbackMessage = await restoreAcpCart(options, ctx, originalCart);

      return {
        ok: false,
        response: acpErrorFromResult(
          request,
          added,
          rollbackMessage
            ? `${resultMessage(added)} Cart rollback failed: ${rollbackMessage}`
            : undefined,
          acpItemErrorPath(resultFieldName(added), index),
        ),
      };
    }
    cart = added.data;
  }

  return {
    ok: true,
    record: {
      ...record,
      cartId: createCartId(cart.id),
      currency: cart.currency,
      items,
      status: acpStatusFromCart(cart, record),
      updatedAt: nowIso(options),
    },
  };
}

function resultFieldName(
  result: Extract<MikaApiResult<unknown>, { readonly ok: false }>,
): string | undefined {
  return Object.keys(result.error.fieldErrors ?? {})[0];
}

function acpItemErrorPath(fieldName: string | undefined, index: number): string | undefined {
  if (!fieldName) return undefined;
  if (fieldName === "quantity") return `$.items[${index}].quantity`;
  if (fieldName === "sellableId" || fieldName === "priceId") return `$.items[${index}].id`;

  return `$.items[${index}]`;
}

export async function restoreAcpCart(
  options: CreateMikaAcpCheckoutHandlersOptions,
  ctx: MikaRequestContext,
  originalCart: CartDTO,
): Promise<string | undefined> {
  const currentResult = await options.api.cart.get(ctx);
  if (!currentResult.ok) return resultMessage(currentResult);

  let cart = currentResult.data;
  for (const line of cart.items) {
    const removed = await options.api.cart.remove(ctx, { lineId: line.id });
    if (!removed.ok) return resultMessage(removed);
    cart = removed.data;
  }

  for (const line of originalCart.items) {
    const restored = await options.api.cart.add(
      ctx,
      omitUndefined({
        sellableId: createSellableId(line.sellableId),
        priceId: line.priceId ? createPriceId(line.priceId) : undefined,
        quantity: line.quantity,
      }),
    );
    if (!restored.ok) return resultMessage(restored);
  }

  return undefined;
}

export async function recordToAcpSession(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
): Promise<MikaAcpCheckoutSession> {
  const ctx = acpContext(options, request, record.sessionId);
  const quote = await options.api.cart.quote(ctx, omitUndefined({ cartId: record.cartId }));
  const checkoutStatus = record.checkoutId
    ? await options.api.checkout.status(ctx, { checkoutId: record.checkoutId })
    : undefined;
  const checkout = checkoutStatus?.ok ? checkoutStatus.data : undefined;
  const status =
    checkout?.status === "completed" || record.status === "completed"
      ? "completed"
      : checkout?.status === "cancelled" || record.status === "canceled"
        ? "canceled"
        : undefined;
  if (status === "completed" && record.quoteSnapshot) {
    const orderUrl =
      record.orderUrl ?? acpAbsoluteUri(options.orderUrl({ sessionId: record.id }), "order URL");

    return acpCheckoutSessionFromSnapshot(
      omitUndefined({
        record,
        snapshot: record.quoteSnapshot,
        status,
        seller: options.seller,
        orderUrl,
        checkout,
      }),
    );
  }

  const orderUrl =
    status === "completed"
      ? (record.orderUrl ?? acpAbsoluteUri(options.orderUrl({ sessionId: record.id }), "order URL"))
      : undefined;

  return acpCheckoutSessionFromState(
    omitUndefined({
      record,
      quote: quote.ok ? quote.data : emptyQuote(record),
      checkout,
      seller: options.seller,
      orderUrl,
    }),
  );
}

export async function verifyAcpRequest(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  bodyRequired: boolean,
): Promise<Response | undefined> {
  if (options.apiKey) {
    const expected = `Bearer ${options.apiKey}`;
    if (!safeStringEqual(request.headers.get("Authorization") ?? "", expected)) {
      return acpError(request, 401, "unauthorized", "ACP authorization failed.");
    }
  }
  if (request.headers.get("API-Version") !== MIKA_ACP_API_VERSION) {
    return acpError(
      request,
      400,
      "invalid_request",
      `API-Version header must equal '${MIKA_ACP_API_VERSION}'.`,
    );
  }
  // Idempotency-Key is required for mutating requests; GET handlers pass bodyRequired=false.
  if (bodyRequired && !request.headers.get("Idempotency-Key")) {
    return acpError(request, 400, "request_not_idempotent", "Idempotency-Key header is required.");
  }
  if (!options.signatureSecret) return undefined;

  const signature = request.headers.get("Signature");
  if (!signature)
    return acpError(request, 401, "signature_invalid", "Signature header is required.");
  // The published ACP spec names this header "Timestamp" (RFC 3339), not "Signature-Timestamp".
  const timestamp = request.headers.get("Timestamp");
  if (!timestamp) {
    return acpError(request, 401, "signature_invalid", "Timestamp header is required.");
  }
  if (!acpSignatureTimestampIsFresh(timestamp, options.now?.() ?? new Date())) {
    return acpError(
      request,
      401,
      "signature_invalid",
      "ACP request signature timestamp is invalid.",
    );
  }
  const payload = await request.clone().text();
  const expected = await hmacBase64Url(
    options.signatureSecret,
    acpCanonicalSignaturePayload(request, payload, timestamp),
  );
  if (!safeStringEqual(signature, expected)) {
    return acpError(request, 401, "signature_invalid", "ACP request signature is invalid.");
  }

  return undefined;
}

export async function readAcpBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<
  | { readonly ok: true; readonly data: z.infer<TSchema> }
  | { readonly ok: false; readonly message: string; readonly path?: string }
> {
  let parsedJson: unknown;
  try {
    parsedJson = await request.json();
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path =
      issue && issue.path.length > 0
        ? `$${issue.path
            .map((segment) =>
              typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`,
            )
            .join("")}`
        : undefined;

    return {
      ok: false,
      message: issue
        ? path
          ? `Request body is invalid at '${path}': ${issue.message}`
          : `Request body is invalid: ${issue.message}`
        : "Request body is invalid.",
      ...(path ? { path } : {}),
    };
  }

  return { ok: true, data: parsed.data as z.infer<TSchema> };
}

export async function previewAcpCheckout(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
  customer: CheckoutCustomerInput | undefined,
): Promise<MikaApiResult<CheckoutPreviewDTO>> {
  return options.api.checkout.preview(
    acpContext(options, request, record.sessionId),
    omitUndefined({
      cartId: record.cartId,
      provider: record.provider,
      customer,
    }),
  );
}

export function acpContext(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  sessionId: string,
): MikaRequestContext {
  return createMikaRequestContext(
    omitUndefined({
      request,
      url: acpRequestUrl(options, request),
      sessionId,
      session: createStaticSession(sessionId),
      idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
      locale: request.headers.get("Accept-Language") ?? undefined,
      now: options.now?.(),
    }),
  );
}

export function acpRequestUrl(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
): URL {
  const requestUrl = new URL(request.url);
  if (!options.baseUrl) return requestUrl;

  const baseUrl = new URL(options.baseUrl);
  return new URL(`${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`, baseUrl);
}

export function createStaticSession(sessionID: string): MikaSessionAccess {
  const values = new Map<string, unknown>();

  return {
    sessionID,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      values.set(key, value);
    },
  };
}

export function parseAcpItemId(id: string): {
  readonly sellableId: SellableId;
  readonly priceId?: PriceId;
} {
  const [sellableId, priceId] = id.split(":");
  if (!sellableId) throw new Error("ACP item id must include a sellable id.");

  return {
    sellableId: createSellableId(sellableId),
    ...(priceId ? { priceId: createPriceId(priceId) } : {}),
  };
}
