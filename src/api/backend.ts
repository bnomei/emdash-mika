/**
 * Default Mika backend: repository ports, stock lifecycle, and full {@link MikaApi} wiring.
 * Implements cart, checkout, order, subscription, wishlist, webhook fulfillment, and admin flows.
 */
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  type MikaProviderAdapter,
  type MikaProviderLineItem,
  type MikaProviderPaymentEvent,
  type MikaProviderSubscriptionEvent,
  type MikaProviderWebhookEvent,
  type MikaVerifiedWebhookPayload,
} from "../provider";
import {
  cartWithCoupon,
  cartWithoutCoupon,
  catalogSellablesToDTO,
  couponDiscountAmount,
  createCheckoutAggregate,
  createOrderAggregate,
  createSubscriptionAggregate,
  orderLineFromCheckoutLine,
  snapshotPrice,
  stockAvailabilityToDTO,
} from "../model/builders";
import { createMikaAdminBackend } from "./backend-admin";
import { applyPaymentEventToOrder, orderBlocksFulfillment, orderRefundedAmount } from "./lifecycle";
import type { CheckoutLine, CouponSnapshot, CustomerSnapshot } from "../types/aggregates";
import type {
  CartDocument,
  CheckoutDocument,
  OrderDocument,
  SubscriptionDocument,
  WebhookDocument,
  WorkflowDocument,
} from "../types/documents";
import { createISODateTime, createMikaId } from "../types/primitives";
import type {
  CheckoutStatus,
  CurrencyCode,
  ISODateTime,
  JsonObject,
  JsonValue,
  MikaId,
  ProviderName,
  PurchaseMode,
} from "../types/primitives";
import type { StockItemRecord } from "../types/operational";
import type { MikaRequestContext } from "./context";
import { createMikaApi, type MikaApi } from "./server";
import type {
  AdminActionResultDTO,
  CartQuoteDTO,
  CheckoutCustomerInput,
  CheckoutPreviewDTO,
  CheckoutCancelInput,
  CheckoutPreviewInput,
  CheckoutSessionDTO,
  CheckoutStatusInput,
  MikaApiResult,
  StartCheckoutInput,
  WebhookReceiveDTO,
  WebhookReceiveInput,
  WebhookReplayInput,
} from "./types";
// Repository ports and shared backend config/dependency types now live in ./backend/ports.
import type {
  MikaDocumentList,
  MikaCatalogRepositoryPort,
  MikaSessionRepositoryPort,
  MikaAccountRepositoryPort,
  MikaLedgerRepositoryPort,
  MikaWebhookRepositoryPort,
  MikaAccountDeleteJobRepositoryPort,
  MikaWorkflowRepositoryPort,
  MikaAdminAuditRepositoryPort,
  MikaEmailOutboxRepositoryPort,
  MikaOpsRepositoryPort,
  MikaStockRepositoryPort,
  MikaEphemeralRepositoryPort,
  MikaBackendRepositories,
  MikaBackendNow,
  MikaBackendISODateTime,
  MikaBackendIdFactory,
  MikaBackendHashInput,
  MikaBackendHashHelper,
  MikaBackendDefaults,
  MikaCouponResolution,
  MikaCouponResolverInput,
  MikaCouponResolver,
  MikaBackendConfig,
  MikaBackendErrorObserver,
  MikaBackendDependencies,
  CreateMikaBackendApiInput,
} from "./backend/ports";
import {
  addMilliseconds,
  booleanChild,
  currentBackendISODateTime,
  customerChild,
  defaultBackendCurrency,
  isoChild,
  isSubscriptionStatus,
  jsonChild,
  jsonObject,
  metadataMikaId,
  metadataString,
  moneyDTO,
  moneyToJson,
  providerLineChildren,
  providerLineToJson,
  stringChild,
  totalsChild,
} from "./backend/shared";
import {
  apiFailure,
  checkoutEmpty,
  checkoutExpired,
  checkoutFailedReplay,
  checkoutIdempotencyInProgress,
  checkoutIdempotencyInputMismatch,
  checkoutPersistenceFailed,
  emitBackendNotification,
  forbidden,
  invalidCart,
  invalidCheckout,
  observeBackendError,
  outOfStock,
  providerFailed,
  validationFailed,
  webhookInvalid,
  webhookProcessingDeferred,
} from "./backend/errors";
import type { MikaApiFailure } from "./backend/errors";
import { WorkflowRunner, WorkflowRunnerLeaseLostError } from "./backend/workflow-runner";
import {
  createMikaStockLifecycleService,
  expireCheckoutReservations,
} from "./backend/stock-lifecycle";
import type { MikaStockLifecycleDependencies } from "./backend/stock-lifecycle";
import {
  checkoutBelongsToContext,
  hydratedCheckoutOverrides,
  isAnonymizedCustomer,
  withHydratedCustomerHandler,
} from "./backend/identity";
import {
  checkoutCancelAccessError,
  checkoutStatusAccessError,
  putCheckoutStatusToken,
} from "./backend/tokens";
import {
  requireProviderFeature,
  runAdminRepositoryAction,
  stableJsonStringify,
  toIdempotencyJson,
} from "./backend/admin-audit";
import {
  cartPriceUnavailable,
  couponRejectionMessage,
  couponSnapshotForSubtotal,
  createCartQuote,
  findQuoteCart,
  reopenCartDocument,
  selectCartPrice,
  siblingSellableQuantity,
  updateCartDocument,
  validateQuantityLimit,
} from "./backend/quote";
export { createMikaFixedRateCouponResolver } from "./backend/quote";
import {
  completeCheckoutForPaymentOrder,
  fulfillCheckoutPaymentOrder,
  fulfillPaidOrder,
  fulfillmentDocumentId,
  resolveDownload,
  revokeOrderFulfillmentAccess,
  updateOrderAfterRefund,
} from "./backend/fulfillment";
import type {
  PaymentWebhookWorkflowStep,
  RunPaymentWebhookWorkflowStep,
} from "./backend/fulfillment";
import { createCartBackend } from "./backend/cart";
import { createWishlistBackend } from "./backend/wishlist";
import {
  adminStockAdjustmentResult,
  cancelOrder,
  grantEntitlement,
  issueDownload,
  providerHealth,
  providerSync,
  refundOrder,
  releaseExpiredReservations,
  resendEmail,
  revokeEntitlement,
  revokeLicense,
} from "./backend/admin";
import {
  accountExportStatus,
  createAccountPortalSession,
  downloadAccountExport,
  getAccount,
  getOrderInvoice,
  requestAccountDelete,
  requestAccountExport,
  safeRequestReturnPath,
} from "./backend/account";
import { requestMagicLink, verifyMagicLink } from "./backend/magic-link";
import {
  emitSubscriptionLifecycleNotification,
  runSubscriptionAction,
  updateSubscriptionEntitlement,
} from "./backend/subscriptions";
export { createMikaStockLifecycleService } from "./backend/stock-lifecycle";
export type {
  ReserveStockInput,
  ReserveStockResult,
  ReleaseReservedStockInput,
  ReleaseReservedStockResult,
  ExpireReservedStockResult,
  ConsumeReservedStockInput,
  ConsumeReservedStockResult,
  ReleaseExpiredReservationsInput,
  ReleaseExpiredReservationsResult,
  ExtendReservationsInput,
  AdjustStockInput,
  AdjustStockResult,
  MikaStockLifecycleService,
} from "./backend/stock-lifecycle";
export type {
  MikaDocumentList,
  MikaCatalogRepositoryPort,
  MikaSessionRepositoryPort,
  MikaAccountRepositoryPort,
  MikaLedgerRepositoryPort,
  MikaWebhookRepositoryPort,
  MikaAccountDeleteJobRepositoryPort,
  MikaWorkflowRepositoryPort,
  MikaAdminAuditRepositoryPort,
  MikaEmailOutboxRepositoryPort,
  MikaOpsRepositoryPort,
  MikaStockRepositoryPort,
  MikaEphemeralRepositoryPort,
  MikaBackendRepositories,
  MikaBackendNow,
  MikaBackendISODateTime,
  MikaBackendIdFactory,
  MikaBackendHashInput,
  MikaBackendHashHelper,
  MikaBackendDefaults,
  MikaCouponResolution,
  MikaCouponResolverInput,
  MikaCouponResolver,
  MikaBackendConfig,
  MikaBackendErrorObserver,
  MikaBackendDependencies,
  CreateMikaBackendApiInput,
};

const CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "checkoutIdempotencyInputHash";
const CHECKOUT_CUSTOMER_EMAIL_METADATA_KEY = "checkoutCustomerEmail";
const CHECKOUT_CUSTOMER_NAME_METADATA_KEY = "checkoutCustomerName";
const CHECKOUT_CUSTOMER_COMPANY_METADATA_KEY = "checkoutCustomerCompany";
const CHECKOUT_CUSTOMER_VAT_ID_METADATA_KEY = "checkoutCustomerVatId";
// Internal checkout keys: stripped from provider metadata and omitted from persisted custom fields.
const CHECKOUT_INTERNAL_METADATA_KEYS = new Set<string>([
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
const DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS = new Set<string>([
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
]);
const CHECKOUT_PERSISTED_METADATA_OMIT_KEYS = new Set<string>([
  ...CHECKOUT_INTERNAL_METADATA_KEYS,
  ...DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
]);

/** Creates the production {@link MikaApi} implementation from storage and provider adapters. */
export function createMikaBackendApi(input: CreateMikaBackendApiInput): MikaApi {
  return createMikaApi({
    ...input.overrides,
    catalog: {
      sellables: async ({ contentRef }) => {
        const catalogItem = await input.repositories.catalog.findItemByContent(contentRef);
        if (!catalogItem) {
          return { ok: true, status: 200, data: [] };
        }

        const activeSellables = catalogItem.aggregate.sellables.filter(
          (sellable) => sellable.active,
        );
        const stockRecords = await Promise.all(
          activeSellables.map(async (sellable) => ({
            sellableId: sellable.id,
            stock: await input.repositories.stock.findBySellableId(sellable.id),
          })),
        );
        const stockBySellableId = new Map(
          stockRecords.flatMap((record) =>
            record.stock ? [[record.sellableId, record.stock] as const] : [],
          ),
        );

        return {
          ok: true,
          status: 200,
          data: catalogSellablesToDTO({
            catalog: catalogItem.aggregate,
            stockBySellableId,
          }),
        };
      },
      ...input.overrides?.catalog,
    },
    stock: {
      availability: async ({ sellableId }) => {
        const id = createMikaId(sellableId);
        const catalog = await input.repositories.catalog.findItemBySellableId(id);
        const sellable = catalog?.aggregate.sellables.find((item) => item.id === id);
        if (!sellable?.active) {
          return {
            ok: false,
            status: 404,
            error: {
              code: "SELLABLE_NOT_FOUND",
              message: `Sellable '${sellableId}' was not found.`,
            },
          };
        }

        const stock = await input.repositories.stock.findBySellableId(id);
        if (!stock) {
          return {
            ok: false,
            status: 404,
            error: {
              code: "SELLABLE_NOT_FOUND",
              message: `Sellable '${sellableId}' was not found.`,
            },
          };
        }

        const availability = stockAvailabilityToDTO(sellable, stock);

        if (!availability) {
          return {
            ok: false,
            status: 404,
            error: {
              code: "SELLABLE_NOT_FOUND",
              message: `Sellable '${sellableId}' was not found.`,
            },
          };
        }

        return { ok: true, status: 200, data: availability };
      },
      ...input.overrides?.stock,
    },
    admin: createMikaAdminBackend({
      handlers: {
        providerHealth: async (healthInput) => providerHealth(input, healthInput),
        providerSync: async (syncInput) => providerSync(input, syncInput),
        stockAdjust: async (adjustment) => {
          if (!Number.isInteger(adjustment.quantityDelta) || adjustment.quantityDelta === 0) {
            return validationFailed(
              "quantityDelta",
              "Quantity delta must be a non-zero whole number.",
            );
          }

          const result = await createMikaStockLifecycleService(input).adjust({
            stockItemId: adjustment.stockItemId,
            quantityDelta: adjustment.quantityDelta,
            ...(adjustment.reason !== undefined ? { reason: adjustment.reason } : {}),
            ...(adjustment.adminAuditId !== undefined
              ? { adminAuditId: adjustment.adminAuditId }
              : {}),
            ...(adjustment.idempotencyKey !== undefined
              ? { idempotencyKey: adjustment.idempotencyKey }
              : {}),
            ...(adjustment.metadata !== undefined ? { metadata: adjustment.metadata } : {}),
            now: currentBackendISODateTime(input),
          });

          if (result.status === "not_found") {
            return {
              ok: false,
              status: 404,
              error: {
                code: "NOT_FOUND",
                message: `Stock item '${adjustment.stockItemId}' was not found.`,
                fieldErrors: { stockItemId: "Stock item was not found." },
              },
            };
          }

          if (result.status === "would_go_negative") {
            return {
              ok: false,
              status: 409,
              error: {
                code: "CONFLICT",
                message: `Stock adjustment for '${adjustment.stockItemId}' would make on-hand quantity negative.`,
              },
            };
          }

          if (result.status === "would_undercut_reserved") {
            return {
              ok: false,
              status: 409,
              error: {
                code: "CONFLICT",
                message: `Stock adjustment for '${adjustment.stockItemId}' would undercut active reservations.`,
              },
            };
          }

          if (result.status === "idempotency_conflict") {
            return {
              ok: false,
              status: 409,
              error: {
                code: "CONFLICT",
                message: `Stock adjustment idempotency key was reused for a different stock item.`,
              },
            };
          }

          return {
            ok: true,
            status: 200,
            data: adminStockAdjustmentResult(result),
          };
        },
        releaseExpiredReservations: async (releaseInput = {}) =>
          releaseExpiredReservations(input, releaseInput),
        webhookReplay: async (replayInput) => replayWebhook(input, replayInput),
        orderRefund: async (refundInput) => refundOrder(input, refundInput),
        orderCancel: async (cancelInput) => cancelOrder(input, cancelInput),
        entitlementGrant: async (grantInput) => grantEntitlement(input, grantInput),
        entitlementRevoke: async (revokeInput) => revokeEntitlement(input, revokeInput),
        emailResend: async (resendInput) => resendEmail(input, resendInput),
        licenseRevoke: async (revokeInput) => revokeLicense(input, revokeInput),
        downloadIssue: async (issueInput) => issueDownload(input, issueInput),
      },
      overrides: input.overrides?.admin,
    }),
    cart: createCartBackend(input),
    wishlist: createWishlistBackend(input),
    checkout: {
      start: withHydratedCustomerHandler(input, (ctx, checkoutInput) =>
        startCheckout(input, ctx, checkoutInput),
      ),
      status: withHydratedCustomerHandler(input, (ctx, statusInput) =>
        checkoutStatus(input, ctx, statusInput),
      ),
      cancel: withHydratedCustomerHandler(input, (ctx, cancelInput) =>
        cancelCheckout(input, ctx, cancelInput),
      ),
      preview: withHydratedCustomerHandler(input, async (ctx, previewInput) => {
        const preview = await createCheckoutPreview(input, ctx, previewInput);

        return { ok: true, status: 200, data: preview };
      }),
      ...hydratedCheckoutOverrides(input, input.overrides?.checkout),
    },
    magicLink: {
      request: async (ctx, requestInput) => requestMagicLink(input, ctx, requestInput),
      verify: async (ctx, verifyInput) => verifyMagicLink(input, ctx, verifyInput),
      ...input.overrides?.magicLink,
    },
    account: {
      get: async (ctx) => getAccount(input, ctx),
      export: async (ctx) => requestAccountExport(input, ctx),
      exportStatus: async (ctx, exportInput) => accountExportStatus(input, ctx, exportInput),
      exportDownload: async (ctx, downloadInput) =>
        downloadAccountExport(input, ctx, downloadInput),
      delete: async (ctx) => requestAccountDelete(input, ctx),
      portal: async (ctx, portalInput) => createAccountPortalSession(input, ctx, portalInput),
      ...input.overrides?.account,
    },
    subscription: {
      cancel: async (ctx, actionInput) => runSubscriptionAction(input, ctx, actionInput, "cancel"),
      change: async (ctx, actionInput) => runSubscriptionAction(input, ctx, actionInput, "change"),
      renew: async (ctx, actionInput) => runSubscriptionAction(input, ctx, actionInput, "renew"),
      ...input.overrides?.subscription,
    },
    download: {
      resolve: async (downloadInput) => resolveDownload(input, downloadInput, false),
      confirm: async (downloadInput) => resolveDownload(input, downloadInput, true),
      ...input.overrides?.download,
    },
    order: {
      invoice: async (ctx, invoiceInput) => getOrderInvoice(input, ctx, invoiceInput),
      ...input.overrides?.order,
    },
    webhook: {
      receive: async (ctx, webhookInput) => receiveWebhook(input, ctx, webhookInput),
      ...input.overrides?.webhook,
    },
  });
}

async function receiveWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhookInput: WebhookReceiveInput,
): Promise<MikaApiResult<WebhookReceiveDTO>> {
  const provider = input.providers.get(webhookInput.provider);
  if (!provider?.verifyWebhook || !provider.parseWebhookEvent) {
    return webhookInvalid("Webhook provider does not support verified webhooks.");
  }

  const request = ctx.request;
  if (!request) {
    return webhookInvalid("Webhook request is unavailable.");
  }

  const rawBody = await readWebhookRawBody(request);
  if (!rawBody) {
    return webhookInvalid("Webhook raw body is unavailable.");
  }

  let verified: MikaVerifiedWebhookPayload;
  let event: MikaProviderWebhookEvent;
  try {
    verified = await provider.verifyWebhook({
      provider: webhookInput.provider,
      request,
      rawBody,
    });
    event = await provider.parseWebhookEvent(verified);
  } catch {
    return webhookInvalid("Webhook signature or payload could not be verified.");
  }

  if (verified.provider !== webhookInput.provider || event.provider !== webhookInput.provider) {
    return webhookInvalid("Webhook provider binding does not match the request.");
  }

  const eventType = event.type || webhookInput.eventType;
  if (!eventType) {
    return webhookInvalid("Webhook event type is unavailable.");
  }

  const providerEventId = event.providerEventId ?? webhookInput.providerEventId;
  const duplicate = await input.repositories.ops.findWebhookDuplicate({
    provider: webhookInput.provider,
    providerEventId,
    eventType,
    payloadHash: verified.payloadHash,
  });
  if (duplicate) {
    if (!webhookDuplicateCanReprocess(event, duplicate)) {
      return webhookDuplicateResult(duplicate);
    }

    const reprocessed = await processStoredWebhook(input, ctx, duplicate, event);
    return webhookReceiptResult(reprocessed, event);
  }

  const webhook = createWebhookDocument(input, ctx, verified, event, {
    eventType,
    providerEventId,
  });

  try {
    await input.repositories.ops.put(webhook);
  } catch {
    const replayedDuplicate = await input.repositories.ops.findWebhookDuplicate({
      provider: webhookInput.provider,
      providerEventId,
      eventType,
      payloadHash: verified.payloadHash,
    });
    if (replayedDuplicate) return webhookDuplicateResult(replayedDuplicate);

    return providerFailed("Webhook could not be stored.");
  }

  const processedWebhook = await processStoredWebhook(input, ctx, webhook, event);

  return webhookReceiptResult(processedWebhook, event);
}

function webhookDuplicateCanReprocess(
  event: MikaProviderWebhookEvent,
  duplicate: WebhookDocument,
): boolean {
  if (event.kind === "payment")
    return duplicate.status === "failed" || duplicate.status === "received";
  if (event.kind === "subscription") return duplicate.status === "received";

  return false;
}

async function replayWebhook(
  input: CreateMikaBackendApiInput,
  replayInput: WebhookReplayInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const webhook = await input.repositories.ops.findWebhookById(replayInput.webhookId);
  if (!webhook) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        message: `Webhook '${replayInput.webhookId}' was not found.`,
        fieldErrors: { webhookId: "Webhook was not found." },
      },
    };
  }

  if (replayInput.idempotencyKey) {
    return runAdminRepositoryAction(
      input,
      {
        action: "webhook.replay",
        targetType: "webhook",
        targetId: webhook.id,
        idempotencyKey: replayInput.idempotencyKey,
        idempotencyInput: toIdempotencyJson(replayInput),
        metadata: {
          webhookId: webhook.id,
          provider: webhook.provider,
          eventType: webhook.eventType,
          ...(webhook.providerEventId ? { providerEventId: webhook.providerEventId } : {}),
        },
      },
      () => replayStoredWebhook(input, webhook),
      "Webhook replay failed.",
    );
  }

  return {
    ok: true,
    status: 200,
    data: await replayStoredWebhook(input, webhook),
  };
}

async function replayStoredWebhook(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
): Promise<AdminActionResultDTO> {
  if (!isReplayableWebhookStatus(webhook.status)) {
    return {
      id: webhook.id,
      status: "completed",
      message: `Webhook '${webhook.id}' is not eligible for replay.`,
      affected: {
        processed: 0,
        failed: 0,
      },
    };
  }

  const event = storedWebhookEvent(webhook);
  if (!event) {
    const failed = await markWebhookFailed(
      input,
      webhook,
      currentBackendISODateTime(input),
      "Webhook payload could not be reconstructed for replay.",
    );

    return {
      id: failed.id,
      status: "failed",
      message: "Webhook payload could not be reconstructed for replay.",
      affected: {
        processed: 0,
        failed: 1,
      },
    };
  }

  const processed = await processStoredWebhook(
    input,
    { now: currentBackendISODateTime(input) },
    webhook,
    event,
  );
  if (event.kind === "payment" && processed === webhook) {
    return {
      id: webhook.id,
      status: "running",
      message: `Webhook '${webhook.id}' workflow is already running or not due for replay.`,
      affected: {
        processed: 0,
        failed: 0,
      },
    };
  }

  const processedCount = processed.status === "failed" ? 0 : 1;
  const failedCount = processed.status === "failed" ? 1 : 0;

  return {
    id: processed.id,
    status: processed.status === "failed" ? "failed" : "completed",
    affected: {
      processed: processedCount,
      failed: failedCount,
    },
  };
}

async function readWebhookRawBody(request: Request): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await request.clone().arrayBuffer());
  } catch {
    return null;
  }
}

function createWebhookDocument(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  verified: MikaVerifiedWebhookPayload,
  event: MikaProviderWebhookEvent,
  resolved: {
    readonly eventType: string;
    readonly providerEventId?: string;
  },
): WebhookDocument {
  const id = input.createId("webhook");
  const record = {
    id,
    provider: event.provider,
    providerEventId: resolved.providerEventId,
    eventType: resolved.eventType,
    payloadHash: verified.payloadHash,
    status: "received" as const,
    attemptCount: 0,
    receivedAt: ctx.now,
    rawPayloadJson: storedWebhookPayload(verified, event),
    normalizedPayloadJson: webhookEventToJson(event, { includeRaw: false }),
  };

  return {
    id,
    type: "webhook",
    schemaVersion: 1,
    provider: record.provider,
    providerEventId: record.providerEventId,
    eventType: record.eventType,
    payloadHash: record.payloadHash,
    status: record.status,
    receivedAt: record.receivedAt,
    record,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

function storedWebhookPayload(
  verified: MikaVerifiedWebhookPayload,
  event: MikaProviderWebhookEvent,
): JsonObject {
  return jsonObject({
    ...(verified.parsed ? { providerPayload: verified.parsed } : {}),
    ...(event.raw ? { providerPayload: verified.parsed ?? event.raw } : {}),
    normalizedEvent: webhookEventToJson(event, { includeRaw: true }),
  });
}

function webhookEventToJson(
  event: MikaProviderWebhookEvent,
  options: { readonly includeRaw: boolean },
): JsonObject {
  switch (event.kind) {
    case "payment":
      return jsonObject({
        kind: event.kind,
        paymentStatus: event.paymentStatus,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        providerCheckoutId: event.providerCheckoutId,
        providerPaymentId: event.providerPaymentId,
        providerOrderId: event.providerOrderId,
        providerSubscriptionId: event.providerSubscriptionId,
        customer: event.customer
          ? jsonObject({
              email: event.customer.email,
              name: event.customer.name,
              company: event.customer.company,
              vatId: event.customer.vatId,
            })
          : undefined,
        lines: event.lines.map(providerLineToJson),
        totals: event.totals
          ? jsonObject({
              subtotal: event.totals.subtotal ? moneyToJson(event.totals.subtotal) : undefined,
              discount: event.totals.discount ? moneyToJson(event.totals.discount) : undefined,
              tax: event.totals.tax ? moneyToJson(event.totals.tax) : undefined,
              total: event.totals.total ? moneyToJson(event.totals.total) : undefined,
            })
          : undefined,
        invoiceUrl: event.invoiceUrl,
        raw: options.includeRaw ? event.raw : undefined,
      });
    case "subscription":
      return jsonObject({
        kind: event.kind,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        providerSubscriptionId: event.providerSubscriptionId,
        providerCustomerId: event.providerCustomerId,
        providerPriceId: event.providerPriceId,
        status: event.status,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        raw: options.includeRaw ? event.raw : undefined,
      });
    case "unknown":
      return jsonObject({
        kind: event.kind,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        raw: options.includeRaw ? event.raw : undefined,
      });
  }
}

function isReplayableWebhookStatus(status: WebhookDocument["status"]): boolean {
  return (
    status === "failed" ||
    status === "received" ||
    status === "processing" ||
    isLegacyQueuedWebhookStatus(status)
  );
}

function isLegacyQueuedWebhookStatus(status: unknown): status is "queued" {
  return status === "queued";
}

function storedWebhookEvent(webhook: WebhookDocument): MikaProviderWebhookEvent | null {
  const rawPayload = webhook.record.rawPayloadJson;
  const payload =
    webhook.record.normalizedPayloadJson ??
    (rawPayload ? (jsonChild(rawPayload, "normalizedEvent") ?? rawPayload) : undefined);
  if (!payload) return null;

  const eventPayload =
    jsonChild(payload, "normalizedEvent") ?? (stringChild(payload, "kind") ? payload : null);
  if (!eventPayload) return null;

  const provider = stringChild(eventPayload, "provider");
  const type = stringChild(eventPayload, "type");
  if (provider !== webhook.provider || !type) return null;

  switch (stringChild(eventPayload, "kind")) {
    case "payment": {
      const paymentStatus = stringChild(eventPayload, "paymentStatus") ?? "failed";
      return {
        kind: "payment",
        paymentStatus,
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        providerCheckoutId: stringChild(eventPayload, "providerCheckoutId"),
        providerPaymentId: stringChild(eventPayload, "providerPaymentId"),
        providerOrderId: stringChild(eventPayload, "providerOrderId"),
        providerSubscriptionId: stringChild(eventPayload, "providerSubscriptionId"),
        customer: customerChild(eventPayload, "customer"),
        lines: providerLineChildren(eventPayload, "lines"),
        totals: totalsChild(eventPayload, "totals"),
        invoiceUrl: stringChild(eventPayload, "invoiceUrl"),
        raw: jsonChild(eventPayload, "raw"),
      };
    }
    case "subscription": {
      const status = stringChild(eventPayload, "status");
      if (!isSubscriptionStatus(status)) return null;

      return {
        kind: "subscription",
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        providerSubscriptionId: stringChild(eventPayload, "providerSubscriptionId"),
        providerCustomerId: stringChild(eventPayload, "providerCustomerId"),
        providerPriceId: stringChild(eventPayload, "providerPriceId"),
        status,
        currentPeriodStart: isoChild(eventPayload, "currentPeriodStart"),
        currentPeriodEnd: isoChild(eventPayload, "currentPeriodEnd"),
        cancelAtPeriodEnd: booleanChild(eventPayload, "cancelAtPeriodEnd"),
        raw: jsonChild(eventPayload, "raw"),
      };
    }
    case "unknown":
      return {
        kind: "unknown",
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        raw: jsonChild(eventPayload, "raw"),
      };
    default:
      return null;
  }
}

async function processStoredWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderWebhookEvent,
): Promise<WebhookDocument> {
  switch (event.kind) {
    case "payment":
      if (event.paymentStatus === "refunded" || event.paymentStatus === "partially_refunded") {
        try {
          return (
            (await withWebhookSubjectLock(
              input,
              ctx,
              webhook,
              paymentWebhookLockTarget(event),
              () => processPaymentReversalWebhook(input, ctx, webhook, event),
            )) ?? webhook
          );
        } catch (error) {
          if (error instanceof WorkflowRunnerLeaseLostError) return webhook;

          return markWebhookFailed(
            input,
            webhook,
            ctx.now,
            "Refund webhook could not be processed.",
            { strict: true },
          );
        }
      }

      if (event.paymentStatus !== "paid") {
        if (event.type === "checkout.session.expired") {
          return (
            (await withWebhookSubjectLock(
              input,
              ctx,
              webhook,
              paymentWebhookLockTarget(event),
              () => processCheckoutExpiredWebhook(input, ctx, webhook, event),
            )) ?? webhook
          );
        }

        const failed = await markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment webhook is not in a paid state.",
          { strict: true },
        );
        await emitCheckoutPaymentFailedNotification(input, ctx.now, failed, event);

        return failed;
      }

      try {
        return (
          (await withWebhookSubjectLock(input, ctx, webhook, paymentWebhookLockTarget(event), () =>
            processPaymentWebhook(input, ctx, webhook, event),
          )) ?? webhook
        );
      } catch (error) {
        if (error instanceof WorkflowRunnerLeaseLostError) return webhook;

        return markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment webhook could not be processed.",
          { strict: true, retryable: true },
        );
      }
    case "subscription":
      try {
        return (
          (await withWebhookSubjectLock(
            input,
            ctx,
            webhook,
            subscriptionWebhookLockTarget(event),
            () => processSubscriptionWebhook(input, ctx, webhook, event),
          )) ?? webhook
        );
      } catch {
        return markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Subscription webhook could not be processed.",
          { strict: true, retryable: true },
        );
      }
    case "unknown":
      return webhook;
  }
}

interface WebhookSubjectLockTarget {
  readonly kind: "payment" | "order" | "checkout" | "subscription" | "subscription_customer";
  readonly identity: string;
}

async function withWebhookSubjectLock<TResult>(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  target: WebhookSubjectLockTarget | null,
  run: () => Promise<TResult>,
): Promise<TResult | null> {
  if (!target) return run();

  const subject = `${target.kind}:${target.identity}`;
  const subjectHash = await input.hash(`webhook-subject-lock:${subject}`);
  const owner = `${webhook.id}:${ctx.now}`;
  const key = `webhook-subject-lock:${subjectHash}`;
  const lock = await input.repositories.ephemeral.tryAcquireLock({
    key,
    owner,
    subjectHash,
    expiresAt: addMilliseconds(ctx.now, 300_000),
    now: ctx.now,
  });
  if (!lock) return null;

  try {
    return await run();
  } finally {
    await input.repositories.ephemeral
      .releaseLock({ key, owner, now: ctx.now })
      .catch((error: unknown) =>
        observeBackendError(input, "webhook.subjectLock.release", error, { key }),
      );
  }
}

function paymentWebhookLockTarget(
  event: MikaProviderPaymentEvent,
): WebhookSubjectLockTarget | null {
  if (event.providerPaymentId) {
    return { kind: "payment", identity: `${event.provider}:${event.providerPaymentId}` };
  }
  if (event.providerOrderId) {
    return { kind: "order", identity: `${event.provider}:${event.providerOrderId}` };
  }
  if (event.providerCheckoutId) {
    return { kind: "checkout", identity: `${event.provider}:${event.providerCheckoutId}` };
  }

  return null;
}

function subscriptionWebhookLockTarget(
  event: MikaProviderSubscriptionEvent,
): WebhookSubjectLockTarget | null {
  if (event.providerSubscriptionId) {
    return { kind: "subscription", identity: `${event.provider}:${event.providerSubscriptionId}` };
  }
  if (event.providerCustomerId && event.providerPriceId) {
    return {
      kind: "subscription_customer",
      identity: `${event.provider}:${event.providerCustomerId}:${event.providerPriceId}`,
    };
  }

  return null;
}

/**
 * Applies a provider-initiated payment reversal (refund / chargeback / uncollectible invoice) to
 * the matching order: downgrades it to `refunded`/`partially_refunded` and, on a FULL reversal,
 * revokes the order's entitlements/licenses (a partial refund intentionally retains access). Idem-
 * potent: a re-delivered reversal for an already fully-refunded order is a no-op. A reversal with
 * a strong provider payment/order id is retryable until the matching Mika order exists; weak,
 * uncorrelated reversals are acknowledged so non-Mika provider noise is not retried forever.
 */
async function processPaymentReversalWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  const order = await findExistingPaymentOrder(input, event);
  if (!order) {
    if (reversalHasStrongOrderIdentity(event)) {
      return markWebhookFailed(
        input,
        webhook,
        ctx.now,
        "Refund webhook could not be linked to an order.",
        { strict: true },
      );
    }

    return markWebhookProcessed(input, webhook, ctx.now, {}, { strict: true });
  }

  if (order.paymentStatus === "refunded") {
    await revokeOrderFulfillmentAccess(input, order, ctx.now, "order_refunded");
    return markWebhookProcessedForOrder(input, webhook, ctx.now, order);
  }

  const now = ctx.now;
  const cumulativeReversed = event.totals?.total?.amount;
  if (event.paymentStatus === "partially_refunded" && cumulativeReversed === undefined) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Partial refund webhook is missing cumulative refund totals.",
      { strict: true },
    );
  }
  const refundAmount =
    event.paymentStatus === "partially_refunded" && cumulativeReversed !== undefined
      ? Math.max(0, cumulativeReversed - orderRefundedAmount(order))
      : undefined;

  const updated = updateOrderAfterRefund(
    order,
    {
      orderId: order.id,
      reason: event.type,
      ...(refundAmount !== undefined ? { amount: refundAmount } : {}),
    },
    now,
  );
  await input.repositories.ledger.put(updated);
  if (updated.status === "refunded") {
    await revokeOrderFulfillmentAccess(input, updated, now, "order_refunded");
  }

  return markWebhookProcessedForOrder(input, webhook, now, updated);
}

async function processCheckoutExpiredWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  const checkout = await findPaymentEventCheckout(input, event);
  if (!checkout) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Expired checkout webhook could not be linked to a checkout.",
      { strict: true },
    );
  }

  const expired = await expireCheckoutDocument(input, checkout, ctx.now);

  return markWebhookProcessed(input, webhook, ctx.now, {
    relatedCustomerId: expired.customerId,
  });
}

function reversalHasStrongOrderIdentity(event: MikaProviderPaymentEvent): boolean {
  return Boolean(event.providerPaymentId || event.providerOrderId);
}

type PaymentFailureWebhookEvent = Omit<MikaProviderPaymentEvent, "paymentStatus"> & {
  readonly paymentStatus?: string;
};

async function emitCheckoutPaymentFailedNotification(
  input: CreateMikaBackendApiInput,
  now: ISODateTime,
  webhook: WebhookDocument,
  event: PaymentFailureWebhookEvent,
): Promise<void> {
  const checkout = await findPaymentEventCheckout(input, event);

  await emitBackendNotification(input, "checkout.payment_failed", now, {
    ...(event.customer?.email ? { toEmail: event.customer.email } : {}),
    ...(checkout?.customerId ? { customerId: checkout.customerId } : {}),
    ...(checkout?.id ? { checkoutId: checkout.id } : {}),
    provider: event.provider,
    ...((event.providerCheckoutId ?? checkout?.providerCheckoutId)
      ? { providerCheckoutId: event.providerCheckoutId ?? checkout?.providerCheckoutId }
      : {}),
    ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
    ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
    ...(event.paymentStatus ? { paymentStatus: event.paymentStatus } : {}),
    eventType: event.type,
    webhookId: webhook.id,
    error: webhook.record.lastError ?? "Payment webhook is not in a paid state.",
    ...(event.totals?.total ? { total: event.totals.total } : {}),
  });
}

async function processPaymentWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  return runPaymentWebhookWorkflow(input, ctx, webhook, event, async (runWorkflowStep) => {
    let existingOrder = await findExistingPaymentOrder(input, event);
    if (existingOrder) {
      const orderSource = existingOrder;
      const order = await runWorkflowStep("persist_order", () =>
        updatePaymentOrderFromEvent(input, ctx, orderSource, event),
      );
      const fulfilledOrder = orderBlocksFulfillment(order)
        ? order
        : await fulfillCheckoutPaymentOrder(input, ctx, runWorkflowStep, order, event);

      return runWorkflowStep("mark_webhook", () =>
        markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
      );
    }

    const checkout = await runWorkflowStep("link_checkout", () =>
      findPaymentEventCheckout(input, event),
    );
    if (!checkout) {
      if (event.providerSubscriptionId) {
        return runWorkflowStep("mark_webhook", () =>
          markWebhookProcessed(input, webhook, ctx.now, {}, { strict: true }),
        );
      }
      return runWorkflowStep("mark_webhook", () =>
        markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment event could not be linked to a checkout.",
          {
            strict: true,
          },
        ),
      );
    }

    existingOrder = await findExistingPaymentOrder(input, event, checkout.id);
    if (existingOrder) {
      const orderSource = existingOrder;
      const order = await runWorkflowStep("persist_order", () =>
        updatePaymentOrderFromEvent(input, ctx, orderSource, event),
      );
      const fulfilledOrder = orderBlocksFulfillment(order)
        ? order
        : await fulfillCheckoutPaymentOrder(input, ctx, runWorkflowStep, order, event, checkout);

      return runWorkflowStep("mark_webhook", () =>
        markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
      );
    }

    const order = await runWorkflowStep("persist_order", async () =>
      persistNewPaymentOrder(
        input,
        ctx,
        await createPaymentOrderDocument(input, ctx, checkout, event),
        event,
        checkout,
      ),
    );
    await runWorkflowStep("complete_checkout", () =>
      completeCheckoutForPaymentOrder(input, ctx, order, event, checkout),
    );
    const fulfilledOrder = await runWorkflowStep("fulfill_order", () =>
      fulfillPaidOrder(input, ctx, order),
    );

    return runWorkflowStep("mark_webhook", () =>
      markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
    );
  });
}

async function runPaymentWebhookWorkflow(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
  run: (step: RunPaymentWebhookWorkflowStep) => Promise<WebhookDocument>,
): Promise<WebhookDocument> {
  const leasedWorkflow = await startPaymentWebhookWorkflow(input, ctx, webhook, event);
  if (!leasedWorkflow) return webhook;

  const runner = new WorkflowRunner<PaymentWebhookWorkflowStep>({
    ops: input.repositories.ops,
    workflow: leasedWorkflow,
    now: () => currentBackendISODateTime(input),
    nextAttemptAt: nextWorkflowAttemptAt,
    stepFailureMessage: "Payment webhook workflow failed.",
  });

  try {
    const result = await run((name, fn) => runner.runStep(name, fn));
    if (result.status === "failed") {
      await runner.fail(result.record.lastError ?? "Payment webhook could not be processed.");

      return result;
    }

    await runner.complete({
      webhookStatus: result.status,
      ...(result.record.relatedOrderId ? { relatedOrderId: result.record.relatedOrderId } : {}),
    });

    return result;
  } catch (error) {
    if (error instanceof WorkflowRunnerLeaseLostError) throw error;

    if (!runner.failurePersisted) {
      await runner.fail(
        error instanceof Error ? error.message : "Payment webhook workflow failed.",
      );
    }
    throw error;
  }
}

const PAYMENT_WEBHOOK_WORKFLOW_STEPS = [
  "link_checkout",
  "persist_order",
  "complete_checkout",
  "fulfill_order",
  "mark_webhook",
] as const satisfies readonly PaymentWebhookWorkflowStep[];

async function startPaymentWebhookWorkflow(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WorkflowDocument | null> {
  const id = fulfillmentDocumentId("workflow", webhook.id, "payment");
  const existing = await input.repositories.ops.findWorkflow(id);
  if (existing) {
    return leasePaymentWebhookWorkflow(
      input,
      ctx,
      id,
      webhook,
      shouldForcePaymentWebhookWorkflowLease(webhook),
    );
  }

  const workflow: WorkflowDocument = {
    id,
    type: "workflow",
    schemaVersion: 1,
    kind: "payment_webhook_fulfillment",
    status: "queued",
    subjectType: "webhook",
    subjectId: webhook.id,
    idempotencyKey: event.providerEventId ?? webhook.payloadHash,
    nextAttemptAt: ctx.now,
    record: {
      id,
      kind: "payment_webhook_fulfillment",
      status: "queued",
      subjectType: "webhook",
      subjectId: webhook.id,
      idempotencyKey: event.providerEventId ?? webhook.payloadHash,
      attemptCount: 0,
      maxAttempts: 5,
      nextAttemptAt: ctx.now,
      steps: paymentWorkflowSteps(null),
      resumeState: {
        provider: event.provider,
        webhookId: webhook.id,
        ...(event.providerCheckoutId ? { providerCheckoutId: event.providerCheckoutId } : {}),
        ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
        ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
      },
      createdAt: ctx.now,
      updatedAt: ctx.now,
      metadata: {
        source: "webhook.payment",
      },
    },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

  const created = await input.repositories.ops.createWorkflow(workflow);
  if (!created) {
    return leasePaymentWebhookWorkflow(
      input,
      ctx,
      id,
      webhook,
      shouldForcePaymentWebhookWorkflowLease(webhook),
    );
  }

  return leasePaymentWebhookWorkflow(input, ctx, id, webhook);
}

function shouldForcePaymentWebhookWorkflowLease(webhook: WebhookDocument): boolean {
  return isReplayableWebhookStatus(webhook.status);
}

function leasePaymentWebhookWorkflow(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  workflowId: MikaId,
  webhook: WebhookDocument,
  force = false,
): Promise<WorkflowDocument | null> {
  return input.repositories.ops.tryLeaseWorkflow({
    workflowId,
    leaseKey: `payment:${webhook.id}:${ctx.now}`,
    now: ctx.now,
    leaseExpiresAt: addMilliseconds(ctx.now, 300_000),
    force,
  });
}

function paymentWorkflowSteps(
  existing: WorkflowDocument | null,
): WorkflowDocument["record"]["steps"] {
  const existingSteps = new Map(existing?.record.steps.map((step) => [step.name, step]) ?? []);

  return PAYMENT_WEBHOOK_WORKFLOW_STEPS.map((name) => {
    const prior = existingSteps.get(name);
    return {
      name,
      status:
        prior?.status === "completed"
          ? "completed"
          : prior?.status === "failed"
            ? "failed"
            : "queued",
      startedAt: prior?.startedAt,
      completedAt: prior?.completedAt,
      failedAt: prior?.status === "failed" ? prior.failedAt : undefined,
      attemptCount: prior?.attemptCount ?? 0,
      nextAttemptAt: prior?.status === "failed" ? prior.nextAttemptAt : undefined,
      lastError: prior?.status === "failed" ? prior.lastError : undefined,
      state: prior?.state,
    };
  });
}

function nextWorkflowAttemptAt(now: ISODateTime, workflow: WorkflowDocument): ISODateTime {
  const attempt = Math.max(1, workflow.record.attemptCount);
  const delay = Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000);

  return addMilliseconds(now, delay);
}

async function processSubscriptionWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderSubscriptionEvent,
): Promise<WebhookDocument> {
  const resolved = await findOrCreateSubscriptionFromEvent(input, ctx, event);
  if (!resolved) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Subscription event could not be linked to a subscription.",
    );
  }
  if (resolved.kind === "anonymized_customer") {
    return markWebhookProcessed(input, webhook, ctx.now, {
      relatedCustomerId: resolved.customerId,
      ...(resolved.subscription ? { relatedSubscriptionId: resolved.subscription.id } : {}),
    });
  }

  const previous = resolved.created ? undefined : resolved.subscription;
  const updated = await updateSubscriptionFromEvent(input, ctx, resolved.subscription, event);
  const fulfilled = await updateSubscriptionEntitlement(input, ctx, updated);
  await emitSubscriptionLifecycleNotification(input, ctx.now, fulfilled, {
    event,
    previous,
    created: resolved.created,
  });

  return markWebhookProcessedForSubscription(input, webhook, ctx.now, fulfilled);
}

type SubscriptionFromEventResult =
  | {
      readonly kind: "subscription";
      readonly subscription: SubscriptionDocument;
      readonly created: boolean;
    }
  | {
      readonly kind: "anonymized_customer";
      readonly customerId: MikaId;
      readonly subscription?: SubscriptionDocument;
    };

async function findOrCreateSubscriptionFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  event: MikaProviderSubscriptionEvent,
): Promise<SubscriptionFromEventResult | null> {
  if (event.providerSubscriptionId) {
    const existing = await input.repositories.account.findSubscriptionByProvider(
      event.provider,
      event.providerSubscriptionId,
    );
    if (existing) {
      const customerId = existing.customerId ?? existing.aggregate.customer.customerId;
      if (customerId) {
        const customer = await input.repositories.account.findCustomerById(customerId);
        if (customer && isAnonymizedCustomer(customer)) {
          return { kind: "anonymized_customer", customerId, subscription: existing };
        }
      }
      return { kind: "subscription", subscription: existing, created: false };
    }
  }

  if (!event.providerSubscriptionId || !event.providerCustomerId || !event.providerPriceId) {
    return null;
  }

  const providerAccount = await input.repositories.account.findProviderAccount(
    event.provider,
    event.providerCustomerId,
  );
  if (!providerAccount) return null;

  const priceMatch = await input.repositories.catalog.findItemByProviderPrice(
    event.provider,
    event.providerPriceId,
  );
  if (!priceMatch) return null;

  const customer = await input.repositories.account.findCustomerById(providerAccount.customerId);
  if (customer && isAnonymizedCustomer(customer)) {
    return { kind: "anonymized_customer", customerId: providerAccount.customerId };
  }
  const customerSnapshot: CustomerSnapshot = {
    customerId: providerAccount.customerId,
    userId: customer?.userId,
    email: customer?.aggregate.email ?? providerAccount.record.emailSnapshot,
    emailHash: customer?.emailHash ?? customer?.aggregate.emailHash,
    name: customer?.aggregate.name,
    company: customer?.aggregate.company,
    vatId: customer?.aggregate.vatId,
  };
  const subscriptionId = input.createId("subscription");
  const aggregate = createSubscriptionAggregate({
    customer: customerSnapshot,
    sellable: snapshotPrice({
      content: priceMatch.catalog.aggregate.content,
      sellable: priceMatch.sellable,
      price: priceMatch.price,
      fallbackTitle: priceMatch.catalog.titleSnapshot ?? priceMatch.sellable.id,
    }),
    provider: event.provider,
    providerSubscriptionId: event.providerSubscriptionId,
    providerCustomerId: event.providerCustomerId,
    providerPriceId: event.providerPriceId,
    status: event.status,
    currentPeriodStart: event.currentPeriodStart,
    currentPeriodEnd: event.currentPeriodEnd,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    metadata: subscriptionEventMetadata(event),
  });

  return {
    kind: "subscription",
    subscription: {
      id: subscriptionId,
      type: "subscription",
      schemaVersion: 1,
      customerId: providerAccount.customerId,
      provider: event.provider,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      status: event.status,
      currentPeriodEnd: event.currentPeriodEnd,
      aggregate,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
    created: true,
  };
}

function subscriptionEventIsStale(
  subscription: SubscriptionDocument,
  event: MikaProviderSubscriptionEvent,
): boolean {
  const appliedStart = subscription.aggregate.currentPeriodStart;
  const eventStart = event.currentPeriodStart;
  if (!appliedStart || !eventStart) return false;

  return new Date(eventStart).getTime() < new Date(appliedStart).getTime();
}

async function updateSubscriptionFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
  event: MikaProviderSubscriptionEvent,
): Promise<SubscriptionDocument> {
  if (subscriptionEventIsStale(subscription, event)) {
    return subscription;
  }

  const eventStart = event.currentPeriodStart;
  const appliedStart = subscription.aggregate.currentPeriodStart;
  const eventAdvancesPeriod = Boolean(
    eventStart && appliedStart && new Date(eventStart).getTime() > new Date(appliedStart).getTime(),
  );
  const localStatusIsTerminal =
    subscription.status === "cancelled" || subscription.status === "expired";
  const eventStatusIsTerminal = event.status === "cancelled" || event.status === "expired";
  if (localStatusIsTerminal && !eventStatusIsTerminal && !eventAdvancesPeriod) {
    return subscription;
  }
  const preserveLocalCancel =
    subscription.status === "cancel_at_period_end" &&
    event.status === "active" &&
    !eventAdvancesPeriod;
  const preserveRenewedActive =
    subscription.status === "active" &&
    subscription.aggregate.cancelAtPeriodEnd === false &&
    subscription.aggregate.metadata?.["lastAdminAction"] === "subscription.renew" &&
    event.status === "active" &&
    event.cancelAtPeriodEnd === true &&
    !eventAdvancesPeriod;
  const status = preserveLocalCancel ? "cancel_at_period_end" : event.status;
  const cancelAtPeriodEnd = preserveLocalCancel
    ? true
    : preserveRenewedActive
      ? false
      : (event.cancelAtPeriodEnd ?? subscription.aggregate.cancelAtPeriodEnd ?? false);
  const priceMatch = event.providerPriceId
    ? await input.repositories.catalog.findItemByProviderPrice(
        event.provider,
        event.providerPriceId,
      )
    : null;
  const sellable =
    priceMatch && priceMatch.price.mode === "subscription"
      ? snapshotPrice({
          content: priceMatch.catalog.aggregate.content,
          sellable: priceMatch.sellable,
          price: priceMatch.price,
          fallbackTitle: priceMatch.catalog.titleSnapshot ?? priceMatch.sellable.id,
        })
      : subscription.aggregate.sellable;

  const updated: SubscriptionDocument = {
    ...subscription,
    providerCustomerId: event.providerCustomerId ?? subscription.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId ?? subscription.providerSubscriptionId,
    status,
    currentPeriodEnd: event.currentPeriodEnd ?? subscription.currentPeriodEnd,
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      providerRef: {
        ...subscription.aggregate.providerRef,
        provider: event.provider,
        subscriptionId:
          event.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId,
        customerId: event.providerCustomerId ?? subscription.aggregate.providerRef.customerId,
        priceId: event.providerPriceId ?? subscription.aggregate.providerRef.priceId,
      },
      sellable,
      status,
      cancelAtPeriodEnd,
      currentPeriodStart: event.currentPeriodStart ?? subscription.aggregate.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd,
      metadata: {
        ...subscription.aggregate.metadata,
        ...subscriptionEventMetadata(event),
      },
    },
  };

  await input.repositories.account.put(updated);

  return updated;
}

function subscriptionEventMetadata(event: MikaProviderSubscriptionEvent): JsonObject {
  return {
    source: "webhook.subscription",
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
    ...(event.providerSubscriptionId
      ? { providerSubscriptionId: event.providerSubscriptionId }
      : {}),
    ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}),
    ...(event.providerPriceId ? { providerPriceId: event.providerPriceId } : {}),
  };
}

async function findExistingPaymentOrder(
  input: CreateMikaBackendApiInput,
  event: MikaProviderPaymentEvent,
  checkoutSessionId?: MikaId,
): Promise<OrderDocument | null> {
  if (event.providerPaymentId) {
    const order = await input.repositories.ledger.findOrderByProviderPayment(
      event.provider,
      event.providerPaymentId,
    );
    if (order) return order;
  }

  if (event.providerOrderId) {
    const order = await input.repositories.ledger.findOrderByProviderOrder(
      event.provider,
      event.providerOrderId,
    );
    if (order) return order;
  }

  if (event.providerCheckoutId) {
    const order = await input.repositories.ledger.findOrderByProviderCheckout(
      event.provider,
      event.providerCheckoutId,
    );
    if (order) return order;
  }

  if (checkoutSessionId) {
    const order = await input.repositories.ledger.findOrderByCheckoutSession(checkoutSessionId);
    if (order) return order;
  }

  return null;
}

async function persistNewPaymentOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  checkout: CheckoutDocument,
): Promise<OrderDocument> {
  try {
    await input.repositories.ledger.put(order);

    return order;
  } catch (error) {
    const existingOrder = await findExistingPaymentOrder(input, event, checkout.id);
    if (!existingOrder) throw error;

    return updatePaymentOrderFromEvent(input, ctx, existingOrder, event);
  }
}

async function findPaymentEventCheckout(
  input: CreateMikaBackendApiInput,
  event: Pick<MikaProviderPaymentEvent, "provider" | "providerCheckoutId">,
): Promise<CheckoutDocument | null> {
  if (!event.providerCheckoutId) return null;

  return input.repositories.session.findCheckoutByProvider(
    event.provider,
    event.providerCheckoutId,
  );
}

async function createPaymentOrderDocument(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkout: CheckoutDocument,
  event: MikaProviderPaymentEvent,
): Promise<OrderDocument> {
  const orderId = input.createId("order");
  const total = checkout.aggregate.totals.total;
  const lines = checkout.aggregate.lines.map((line) =>
    orderLineFromCheckoutLine({
      id: input.createId("order_line"),
      line,
      metadata: paymentOrderLineMetadata(line, event),
    }),
  );
  const customer = await paymentCustomerSnapshot(input, checkout, event);

  return {
    id: orderId,
    type: "order",
    schemaVersion: 1,
    orderNumber: orderId,
    customerId: customer.customerId,
    ...(customer.emailHash ? { emailHash: customer.emailHash } : {}),
    provider: event.provider,
    providerCheckoutId:
      event.providerCheckoutId ??
      checkout.providerCheckoutId ??
      checkout.aggregate.binding.providerCheckoutId,
    providerPaymentId: event.providerPaymentId,
    providerOrderId: event.providerOrderId,
    checkoutSessionId: checkout.id,
    status: "paid",
    paymentStatus: "paid",
    currency: total.currency,
    totalAmount: total.amount,
    paidAt: ctx.now,
    aggregate: createOrderAggregate({
      customer,
      checkout: checkout.aggregate,
      lines,
      providerPaymentId: event.providerPaymentId,
      providerOrderId: event.providerOrderId,
      invoiceUrl: event.invoiceUrl,
      metadata: paymentOrderMetadata(event, checkout.id),
    }),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

async function updatePaymentOrderFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): Promise<OrderDocument> {
  const updated = applyPaymentEventToOrder(order, event, ctx.now, {
    invoiceUrl: event.invoiceUrl,
    providerRefs: mergePaymentProviderRefs(order.aggregate.providerRefs, order, event),
    metadata: {
      ...order.aggregate.metadata,
      ...paymentOrderMetadata(event, order.checkoutSessionId),
    },
  });

  await input.repositories.ledger.put(updated);

  return updated;
}

function mergePaymentProviderRefs(
  refs: OrderDocument["aggregate"]["providerRefs"],
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): OrderDocument["aggregate"]["providerRefs"] {
  const providerCheckoutId = event.providerCheckoutId ?? order.providerCheckoutId;
  const index = refs.findIndex(
    (ref) =>
      ref.provider === event.provider &&
      ((providerCheckoutId !== undefined && ref.checkoutId === providerCheckoutId) ||
        (event.providerPaymentId !== undefined && ref.paymentId === event.providerPaymentId) ||
        (event.providerOrderId !== undefined && ref.orderId === event.providerOrderId)),
  );
  const existing = refs[index] ?? { provider: event.provider };
  const merged = {
    ...existing,
    checkoutId: existing.checkoutId ?? providerCheckoutId,
    paymentId: existing.paymentId ?? event.providerPaymentId,
    orderId: existing.orderId ?? event.providerOrderId,
  };

  return index >= 0
    ? refs.map((ref, refIndex) => (refIndex === index ? merged : ref))
    : [...refs, merged];
}

async function paymentCustomerSnapshot(
  input: CreateMikaBackendApiInput,
  checkout: CheckoutDocument,
  event: MikaProviderPaymentEvent,
): Promise<CustomerSnapshot> {
  const checkoutCustomerRecord = checkout.customerId
    ? await input.repositories.account.findCustomerById(checkout.customerId)
    : null;
  const checkoutCustomerAnonymized =
    checkoutCustomerRecord !== null && isAnonymizedCustomer(checkoutCustomerRecord);
  const checkoutCustomer =
    checkoutCustomerRecord && !checkoutCustomerAnonymized ? checkoutCustomerRecord : null;
  const checkoutCustomerId = checkoutCustomerAnonymized ? undefined : checkout.customerId;
  const checkoutMetadataCustomer = checkoutCustomerFromMetadata(checkout.aggregate.metadata);
  const email =
    checkoutCustomer?.aggregate.email ?? event.customer?.email ?? checkoutMetadataCustomer.email;
  const normalizedEmail = email?.trim().toLowerCase();
  const payerEmailHash = normalizedEmail ? await input.hash(`email:${normalizedEmail}`) : undefined;

  const customer =
    checkoutCustomer ??
    (!checkout.customerId && payerEmailHash
      ? await input.repositories.account.findCustomerByEmailHash(payerEmailHash)
      : null);

  return {
    ...((customer?.customerId ?? checkoutCustomerId)
      ? { customerId: customer?.customerId ?? checkoutCustomerId }
      : {}),
    ...(customer?.userId ? { userId: customer.userId } : {}),
    email: customer?.aggregate.email ?? email,
    emailHash: customer?.emailHash ?? customer?.aggregate.emailHash ?? payerEmailHash,
    name: event.customer?.name ?? checkoutMetadataCustomer.name,
    company: event.customer?.company ?? checkoutMetadataCustomer.company,
    vatId: event.customer?.vatId ?? checkoutMetadataCustomer.vatId,
  };
}

function paymentOrderMetadata(
  event: MikaProviderPaymentEvent,
  checkoutSessionId?: MikaId,
): JsonObject {
  return {
    source: "webhook.payment",
    ...(checkoutSessionId ? { checkoutSessionId } : {}),
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
    ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
    ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
  };
}

function paymentOrderLineMetadata(line: CheckoutLine, event: MikaProviderPaymentEvent): JsonObject {
  return {
    checkoutLineId: line.id,
    ...(line.reservationId ? { reservationId: line.reservationId } : {}),
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
  };
}

async function markWebhookProcessedForOrder(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  order: OrderDocument,
): Promise<WebhookDocument> {
  return markWebhookProcessed(
    input,
    webhook,
    now,
    {
      relatedCustomerId: order.customerId,
      relatedOrderId: order.id,
    },
    { strict: true },
  );
}

async function markWebhookProcessedForSubscription(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  subscription: SubscriptionDocument,
): Promise<WebhookDocument> {
  return markWebhookProcessed(input, webhook, now, {
    relatedCustomerId: subscription.customerId,
    relatedSubscriptionId: subscription.id,
  });
}

async function markWebhookProcessed(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  related: Pick<
    WebhookDocument["record"],
    "relatedCustomerId" | "relatedOrderId" | "relatedSubscriptionId"
  >,
  options: { readonly strict?: boolean } = { strict: true },
): Promise<WebhookDocument> {
  const processed: WebhookDocument = {
    ...webhook,
    status: "processed",
    record: {
      ...webhook.record,
      status: "processed",
      attemptCount: webhook.record.attemptCount + 1,
      processedAt: now,
      ...related,
    },
    updatedAt: now,
  };

  return putWebhook(input, processed, options);
}

async function markWebhookFailed(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  lastError: string,
  options: { readonly strict?: boolean; readonly retryable?: boolean } = { strict: true },
): Promise<WebhookDocument> {
  const failed: WebhookDocument = {
    ...webhook,
    status: "failed",
    record: {
      ...webhook.record,
      status: "failed",
      attemptCount: webhook.record.attemptCount + 1,
      lastError,
      retryable: options.retryable ?? false,
    },
    updatedAt: now,
  };

  const persisted = await putWebhook(input, failed, options);
  await emitBackendNotification(input, "ops.webhook_failed", now, {
    webhookId: persisted.id,
    provider: persisted.provider,
    eventType: persisted.eventType,
    ...(persisted.providerEventId ? { providerEventId: persisted.providerEventId } : {}),
    payloadHash: persisted.payloadHash,
    lastError,
    ...(persisted.record.relatedCustomerId
      ? { relatedCustomerId: persisted.record.relatedCustomerId }
      : {}),
    ...(persisted.record.relatedOrderId ? { relatedOrderId: persisted.record.relatedOrderId } : {}),
    ...(persisted.record.relatedSubscriptionId
      ? { relatedSubscriptionId: persisted.record.relatedSubscriptionId }
      : {}),
  });

  return persisted;
}

async function putWebhook(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  options: { readonly strict?: boolean },
): Promise<WebhookDocument> {
  try {
    await input.repositories.ops.put(webhook);
  } catch (error) {
    if (options.strict) {
      throw new Error(`Webhook '${webhook.id}' status could not be persisted.`, { cause: error });
    }
    // The webhook has already been accepted; callers still receive the in-memory state.
    observeBackendError(input, "webhook.persistStatus", error, { webhookId: webhook.id });
  }

  return webhook;
}

function webhookDuplicateResult(duplicate: WebhookDocument): MikaApiResult<WebhookReceiveDTO> {
  return {
    ok: true,
    status: 200,
    data: {
      id: duplicate.id,
      status: "duplicate",
      replayable: duplicate.status === "failed" ? true : undefined,
    },
  };
}

function webhookReceiptResult(
  webhook: WebhookDocument,
  event: MikaProviderWebhookEvent,
): MikaApiResult<WebhookReceiveDTO> {
  if (
    (event.kind === "payment" || event.kind === "subscription") &&
    webhook.status === "received"
  ) {
    return webhookProcessingDeferred(webhook.id);
  }
  if (
    event.kind === "payment" &&
    (event.paymentStatus === "refunded" || event.paymentStatus === "partially_refunded") &&
    webhook.status === "failed"
  ) {
    return apiFailure(
      502,
      "PROVIDER_FAILED",
      webhook.record.lastError ?? "Refund webhook could not be processed.",
    );
  }
  if (
    (event.kind === "payment" || event.kind === "subscription") &&
    webhook.status === "failed" &&
    webhook.record.retryable === true
  ) {
    return apiFailure(
      502,
      "PROVIDER_FAILED",
      webhook.record.lastError ?? "Webhook could not be processed.",
    );
  }

  return {
    ok: true,
    status: 200,
    data: {
      id: webhook.id,
      status: webhook.status === "failed" ? "failed" : "received",
      replayable: true,
    },
  };
}

type CheckoutStartLineResolution = {
  readonly line: CheckoutLine;
  readonly stock: StockItemRecord | null;
};

type CheckoutStartResolution = {
  readonly cart: CartDocument | null;
  readonly cartVersion?: number;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly coupon?: CouponSnapshot;
  readonly lines: readonly CheckoutStartLineResolution[];
};

/**
 * Gates delegated-payment handoff at checkout start.
 *
 * `checkout.start` dispatches to the provider's `createDelegatedPayment` method whenever the
 * shared payment token key is present in `customFields`. Without this gate any caller holding a
 * leaked/intercepted token could trigger a charge for an attacker-chosen cart, bypassing the
 * `checkout.preview` payment-authorization contract. We require the caller to present the
 * `payment_authorization` input hash that a fresh preview of this exact cart produces (the same
 * hash `checkout.preview` returns and the ACP complete handler forwards), binding the delegated
 * payment to a current, previewed quote.
 */
async function requireDelegatedPaymentAuthorization(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  providerName: ProviderName | undefined,
): Promise<{ readonly ok: true } | MikaApiFailure> {
  const customFields = checkoutInput.customFields;
  const token = customFields?.[MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY];
  if (typeof token !== "string" || token.length === 0) return { ok: true };

  if (!providerName) {
    return validationFailed("provider", "A checkout provider is required.");
  }
  if (!checkoutInput.cartId) {
    return forbidden("Delegated payment requires a previewed cart checkout.");
  }
  const providedHash = customFields?.[MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY];
  if (typeof providedHash !== "string" || providedHash.length === 0) {
    return forbidden("Delegated payment requires a checkout.preview payment authorization.");
  }

  const proofInput: StartCheckoutInput = { ...checkoutInput, provider: providerName };
  const quote = await createCartQuote(input, ctx, proofInput);
  const mode = await resolveCheckoutPreviewMode(input, ctx, proofInput);
  const expectedHash = await delegatedPaymentProofHash(
    input,
    proofInput,
    quote,
    mode,
    providerName,
  );
  if (expectedHash !== providedHash) {
    return forbidden("Delegated payment authorization does not match the current checkout.");
  }

  return { ok: true };
}

type CheckoutProviderDispatch =
  | {
      readonly ok: true;
      readonly kind: "hosted";
      readonly providerName: ProviderName;
      readonly provider: MikaProviderAdapter;
      readonly method: NonNullable<MikaProviderAdapter["createCheckoutSession"]>;
    }
  | {
      readonly ok: true;
      readonly kind: "delegated";
      readonly providerName: ProviderName;
      readonly provider: MikaProviderAdapter;
      readonly method: NonNullable<MikaProviderAdapter["createDelegatedPayment"]>;
      readonly token: string;
    }
  | MikaApiFailure;

/**
 * Resolves which provider method `checkout.start` calls: `createDelegatedPayment` when the caller
 * (already authorized by {@link requireDelegatedPaymentAuthorization}) presents a shared payment
 * token, or `createCheckoutSession` for the ordinary hosted-checkout redirect flow.
 */
async function resolveCheckoutProviderDispatch(
  input: CreateMikaBackendApiInput,
  providerName: ProviderName,
  checkoutInput: StartCheckoutInput,
): Promise<CheckoutProviderDispatch> {
  const token = checkoutInput.customFields?.[MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY];
  if (typeof token === "string" && token.length > 0) {
    const feature = await requireProviderFeature(input, {
      providerName,
      method: "createDelegatedPayment",
      capability: "delegated_payment",
      capabilityFailureMessage: "Checkout provider capabilities could not be verified.",
      unsupportedMessage: (provider) =>
        `Provider '${provider}' does not support delegated payments.`,
    });
    if (!feature.ok) return feature;

    return {
      ok: true,
      kind: "delegated",
      providerName: feature.providerName,
      provider: feature.provider,
      method: feature.method,
      token,
    };
  }

  const feature = await requireProviderFeature(input, {
    providerName,
    method: "createCheckoutSession",
    capability: "hosted_checkout",
    capabilityFailureMessage: "Checkout provider capabilities could not be verified.",
    unsupportedMessage: (provider) => `Provider '${provider}' does not support hosted checkout.`,
  });
  if (!feature.ok) return feature;

  return {
    ok: true,
    kind: "hosted",
    providerName: feature.providerName,
    provider: feature.provider,
    method: feature.method,
  };
}

async function startCheckout(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const idempotencyInputHash = ctx.idempotencyKey
    ? await checkoutIdempotencyInputHash(input, ctx, checkoutInput)
    : undefined;
  const replayedCheckout = ctx.idempotencyKey
    ? await input.repositories.session.findCheckoutByIdempotencyKey(ctx.idempotencyKey)
    : null;
  if (replayedCheckout) {
    if (!(await checkoutBelongsToContext(input, replayedCheckout, ctx))) {
      return checkoutIdempotencyInputMismatch();
    }

    const replayedInputHash = checkoutStoredIdempotencyInputHash(replayedCheckout);
    if (replayedInputHash && idempotencyInputHash && replayedInputHash !== idempotencyInputHash) {
      return checkoutIdempotencyInputMismatch();
    }
    if (checkoutIsExpired(input, replayedCheckout)) {
      const expired = await expireCheckoutDocument(input, replayedCheckout, ctx.now);
      return checkoutStatusExpired(expired);
    }

    return checkoutDocumentResult(replayedCheckout);
  }

  const providerName = checkoutInput.provider ?? input.defaults?.provider;
  const delegatedPaymentAuth = await requireDelegatedPaymentAuthorization(
    input,
    ctx,
    checkoutInput,
    providerName,
  );
  if (!delegatedPaymentAuth.ok) return delegatedPaymentAuth;

  const resolved = await resolveCheckoutStart(input, ctx, checkoutInput);
  if (!resolved.ok) return resolved;

  if (!providerName) {
    return validationFailed("provider", "A checkout provider is required.");
  }

  const providerDispatch = await resolveCheckoutProviderDispatch(
    input,
    providerName,
    checkoutInput,
  );
  if (!providerDispatch.ok) return providerDispatch;
  if (providerDispatch.kind === "hosted" && !ctx.url) {
    return validationFailed("url", "Checkout requires a request URL.");
  }

  const checkoutId = input.createId("checkout");
  const expiresAt = checkoutExpiresAt(input, ctx);
  const statusToken = input.createId("checkout_status_token");
  // Optimistic cart claim serializes concurrent checkout starts; release on any downstream failure.
  // expectedVersion may be undefined for a cart persisted before `version` existed — the
  // repository leniently allows the claim in that case rather than rejecting it outright.
  const claimedCart = resolved.cart
    ? await input.repositories.session.claimCartForCheckout({
        cartId: resolved.cart.id,
        checkoutId,
        expectedVersion: resolved.cartVersion,
        claimExpiresAt: expiresAt,
        now: ctx.now,
      })
    : null;
  if (resolved.cart && !claimedCart) {
    return apiFailure(409, "CONFLICT", "Cart is already being checked out.", {
      cartId: "Cart is already being checked out.",
    });
  }
  const reserved = await reserveCheckoutLines(input, ctx, checkoutId, resolved, expiresAt);
  if (!reserved.ok) {
    if (claimedCart)
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    return reserved;
  }

  const checkoutSubtotal = reserved.lines.reduce(
    (sum, line) => sum + line.item.unitAmount * line.quantity,
    0,
  );
  const checkoutDiscountAmount = couponDiscountAmount(resolved.coupon, checkoutSubtotal);

  const providerSession = await (async () => {
    try {
      const total = moneyDTO(
        Math.max(0, checkoutSubtotal - checkoutDiscountAmount),
        resolved.currency,
      );
      const discount =
        checkoutDiscountAmount > 0
          ? moneyDTO(checkoutDiscountAmount, resolved.currency)
          : undefined;
      const lines = reserved.lines.map((line) => checkoutLineToProviderLine(providerName, line));

      if (providerDispatch.kind === "delegated") {
        return await providerDispatch.method.call(providerDispatch.provider, {
          idempotencyKey: ctx.idempotencyKey,
          mode: resolved.mode,
          token: providerDispatch.token,
          lines,
          ...(discount ? { discount } : {}),
          total,
          metadata: checkoutPersistedCustomMetadata(checkoutInput.customFields),
        });
      }

      return await providerDispatch.method.call(providerDispatch.provider, {
        idempotencyKey: ctx.idempotencyKey,
        mode: resolved.mode,
        provider: providerName,
        customer: checkoutInput.customer,
        lines,
        ...(discount ? { discount } : {}),
        total,
        successUrl: checkoutSuccessUrl(input, ctx, checkoutInput, checkoutId, statusToken),
        cancelUrl: checkoutCancelUrl(input, ctx, checkoutInput, checkoutId, statusToken),
        metadata: checkoutCustomMetadata(checkoutInput.customFields),
      });
    } catch {
      await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
      if (claimedCart) {
        await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
      }
      return null;
    }
  })();
  if (!providerSession) {
    await emitBackendNotification(input, "checkout.payment_failed", ctx.now, {
      ...(checkoutInput.customer?.email ? { toEmail: checkoutInput.customer.email } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      provider: providerName,
      status: "failed",
      error: "Checkout provider failed to create a session.",
      total: {
        amount: reserved.lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0),
        currency: resolved.currency,
      },
    });

    return providerFailed("Checkout provider failed to create a session.");
  }
  if (providerSession.status === "failed") {
    await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
    if (claimedCart) {
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    }
    await emitBackendNotification(input, "checkout.payment_failed", ctx.now, {
      ...(checkoutInput.customer?.email ? { toEmail: checkoutInput.customer.email } : {}),
      ...(ctx.customerId ? { customerId: ctx.customerId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      provider: providerName,
      status: "failed",
      error: "Checkout provider returned a failed session.",
      total: {
        amount: reserved.lines.reduce((sum, line) => sum + line.item.unitAmount * line.quantity, 0),
        currency: resolved.currency,
      },
    });

    return providerFailed("Checkout provider returned a failed session.");
  }

  const providerCheckoutId = providerSession.providerCheckoutId ?? providerSession.id;
  const documentExpiresAt = providerSession.expiresAt ?? expiresAt;
  try {
    if (new Date(documentExpiresAt).getTime() > new Date(expiresAt).getTime()) {
      await createMikaStockLifecycleService(input).extendReservations({
        reservationEventIds: reserved.reservationIds,
        expiresAt: documentExpiresAt,
        now: ctx.now,
      });
    }
  } catch {
    await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
    if (claimedCart) {
      await releaseCartCheckoutClaimQuietly(input, claimedCart.id, checkoutId, ctx.now);
    }

    return checkoutPersistenceFailed();
  }
  const checkoutDocument: CheckoutDocument = {
    id: checkoutId,
    type: "checkout",
    schemaVersion: 1,
    cartId: resolved.cart?.id,
    sessionId: ctx.sessionId,
    customerId: ctx.customerId,
    provider: providerName,
    providerCheckoutId,
    checkoutIdempotencyKey: ctx.idempotencyKey,
    checkoutIdempotencyInputHash: idempotencyInputHash,
    providerStatus: providerSession.status,
    redirectUrl: providerSession.redirectUrl,
    status: checkoutDocumentStatus(providerSession.status),
    expiresAt: documentExpiresAt,
    aggregate: createCheckoutAggregate({
      mode: resolved.mode,
      currency: resolved.currency,
      lines: reserved.lines,
      coupon: resolved.coupon,
      binding: {
        provider: providerName,
        providerCheckoutId,
        providerCustomerId: providerSession.providerCustomerId,
        returnPath: safeRequestReturnPath(ctx, checkoutInput.returnTo),
        cancelPath: checkoutCancelTarget(input, ctx, checkoutInput),
        successPath: checkoutSuccessTarget(input, ctx, checkoutInput),
        cartHash: await input.hash(
          JSON.stringify({
            cartId: resolved.cart?.id,
            currency: resolved.currency,
            lines: reserved.lines.map((line) => ({
              sellableId: line.item.sellableId,
              priceId: line.item.priceId,
              quantity: line.quantity,
              unitAmount: line.item.unitAmount,
              currency: line.item.currency,
              reservationId: line.reservationId,
            })),
            coupon: resolved.coupon,
          }),
        ),
      },
      metadata: checkoutMetadata({
        customFields: checkoutInput.customFields,
        customer: checkoutInput.customer,
        idempotencyInputHash,
        idempotencyKey: ctx.idempotencyKey,
        providerSession,
      }),
    }),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

  const persisted = await persistCheckoutStart(
    input,
    ctx,
    checkoutDocument,
    statusToken,
    checkoutStartCartForPersistence(resolved.cart, claimedCart),
    checkoutId,
    reserved.lines,
    reserved.reservationIds,
  );
  if (!persisted.ok) return persisted;

  const checkoutRedirectUrl = checkoutStatusAllowsRedirect(
    checkoutDocument.status,
    providerSession.status,
  )
    ? providerSession.redirectUrl
    : undefined;

  return {
    ok: true,
    status: 200,
    data: {
      id: checkoutId,
      status: providerSession.status,
      mode: providerSession.mode,
      provider: providerSession.provider,
      redirectUrl: checkoutRedirectUrl,
      statusToken,
      expiresAt: providerSession.expiresAt ?? checkoutDocument.expiresAt,
      paymentPending: providerSession.status === "pending" ? true : undefined,
    },
    effects: checkoutRedirectUrl ? [{ type: "redirect", url: checkoutRedirectUrl }] : undefined,
  };
}

async function resolveCheckoutStart(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<({ readonly ok: true } & CheckoutStartResolution) | MikaApiFailure> {
  if (checkoutInput.cartId && checkoutInput.sellableId) {
    return validationFailed(
      "sellableId",
      "Provide either a cartId or a sellableId for checkout, not both.",
    );
  }

  const defaultCurrency = defaultBackendCurrency(input);
  const expressBuyNow =
    checkoutInput.sellableId !== undefined && checkoutInput.cartId === undefined;
  const cartResult = expressBuyNow
    ? { ok: true as const, cart: null, expired: false }
    : await findCheckoutStartCart(input, ctx, checkoutInput.cartId, defaultCurrency);
  if (!cartResult.ok) return cartResult;
  if (cartResult.expired) return checkoutExpired();

  const lines: CheckoutStartLineResolution[] = [];
  const currency = cartResult.cart?.aggregate.currency ?? defaultCurrency;

  const cartLines = cartResult.cart?.aggregate.items ?? [];
  for (const cartLine of cartLines) {
    const line = await resolveCheckoutStartLine(input, {
      sellableId: cartLine.item.sellableId,
      priceId: cartLine.item.priceId,
      quantity: cartLine.quantity,
      quantityForLimit: cartLine.quantity + siblingSellableQuantity(cartLines, cartLine),
      currency,
      cartLineId: cartLine.id,
      metadata: cartLine.metadata,
    });
    if (!line.ok) return line;
    lines.push(line);
  }

  if (checkoutInput.sellableId) {
    const line = await resolveCheckoutStartLine(input, {
      sellableId: checkoutInput.sellableId,
      priceId: checkoutInput.priceId,
      quantity: checkoutInput.quantity ?? 1,
      currency,
    });
    if (!line.ok) return line;
    lines.push(line);
  }

  if (lines.length === 0) return checkoutEmpty();

  const modes = [...new Set(lines.map((line) => line.line.item.mode))];
  if (modes.length !== 1 || modes[0] === undefined) {
    return validationFailed("cartId", "Checkout requires lines with one purchase mode.");
  }

  let resolvedCart = cartResult.cart;
  let coupon = resolvedCart?.aggregate.coupon;
  if (checkoutInput.couponCode !== undefined) {
    const code = checkoutInput.couponCode.trim();
    if (code) {
      const resolved = await couponSnapshotForSubtotal(
        input,
        code,
        lines.reduce((sum, line) => sum + line.line.item.unitAmount * line.line.quantity, 0),
        currency,
      );
      if (!resolved) {
        return validationFailed("couponCode", couponRejectionMessage(input, code.toUpperCase()));
      }
      coupon = resolved;
    } else {
      coupon = undefined;
    }
    if (resolvedCart) {
      resolvedCart = {
        ...resolvedCart,
        updatedAt: ctx.now,
        aggregate: coupon
          ? cartWithCoupon({ cart: resolvedCart.aggregate, coupon })
          : cartWithoutCoupon({ cart: resolvedCart.aggregate }),
      };
    }
  }

  return {
    ok: true,
    cart: resolvedCart,
    cartVersion: cartResult.cart?.version,
    currency,
    mode: modes[0],
    coupon,
    lines,
  };
}

async function findCheckoutStartCart(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  cartId: MikaId | undefined,
  currency: CurrencyCode,
): Promise<
  | { readonly ok: true; readonly cart: CartDocument | null; readonly expired: boolean }
  | MikaApiFailure
> {
  const cartResult = await findQuoteCart(input, ctx, cartId, currency);
  if (!cartResult.cart) return { ok: true, cart: null, expired: false };
  if (cartResult.cart.status !== "open") {
    return invalidCart("cartId", cartResult.cart.id);
  }

  return { ok: true, cart: cartResult.cart, expired: cartResult.expired };
}

async function resolveCheckoutStartLine(
  input: CreateMikaBackendApiInput,
  lineInput: {
    readonly sellableId: MikaId;
    readonly priceId?: MikaId;
    readonly quantity: number;
    readonly quantityForLimit?: number;
    readonly currency: CurrencyCode;
    readonly cartLineId?: MikaId;
    readonly metadata?: JsonObject;
  },
): Promise<({ readonly ok: true } & CheckoutStartLineResolution) | MikaApiFailure> {
  if (!Number.isInteger(lineInput.quantity) || lineInput.quantity < 1) {
    return validationFailed("quantity", "Quantity must be a positive whole number.");
  }

  const catalog = await input.repositories.catalog.findItemBySellableId(lineInput.sellableId);
  if (!catalog) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: `Sellable '${lineInput.sellableId}' was not found.`,
      },
    };
  }

  const sellable = catalog.aggregate.sellables.find((item) => item.id === lineInput.sellableId);
  if (!sellable?.active) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELLABLE_INACTIVE",
        message: `Sellable '${lineInput.sellableId}' is inactive.`,
      },
    };
  }

  const price = selectCartPrice(sellable, lineInput.priceId, lineInput.currency);
  if (!price) {
    return cartPriceUnavailable(sellable, lineInput.priceId, lineInput.currency);
  }
  if (price.currency !== lineInput.currency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  const stock = await input.repositories.stock.findBySellableId(sellable.id);
  const quantityError = validateQuantityLimit(
    sellable,
    stock,
    lineInput.quantityForLimit ?? lineInput.quantity,
  );
  if (quantityError) return quantityError;

  return {
    ok: true,
    line: {
      id: input.createId("checkout_line"),
      cartLineId: lineInput.cartLineId,
      item: snapshotPrice({
        content: catalog.aggregate.content,
        sellable,
        price,
        fallbackTitle: catalog.aggregate.titleSnapshot ?? sellable.id,
      }),
      quantity: lineInput.quantity,
      metadata: lineInput.metadata,
    },
    stock,
  };
}

async function reserveCheckoutLines(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutId: MikaId,
  checkout: CheckoutStartResolution,
  expiresAt: ISODateTime,
): Promise<
  | {
      readonly ok: true;
      readonly lines: readonly CheckoutLine[];
      readonly reservationIds: readonly MikaId[];
    }
  | MikaApiFailure
> {
  const stock = createMikaStockLifecycleService(input);
  const lines: CheckoutLine[] = [];
  const reservationIds: MikaId[] = [];

  try {
    for (const resolution of checkout.lines) {
      if (!resolution.stock) {
        lines.push(resolution.line);
        continue;
      }

      const reservation = await stock.reserve({
        stockItemId: resolution.stock.id,
        quantity: resolution.line.quantity,
        expiresAt,
        now: ctx.now,
        cartId: checkout.cart?.id,
        checkoutSessionId: checkoutId,
        customerId: ctx.customerId,
        sessionId: ctx.sessionId,
        idempotencyKey: checkoutReservationIdempotencyKey(ctx, resolution),
        metadata: { source: "checkout.start" },
      });

      if (reservation.status === "insufficient_stock") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return outOfStock(resolution.line.item.sellableId);
      }
      if (reservation.status === "not_found") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return outOfStock(resolution.line.item.sellableId);
      }
      if (reservation.status === "replayed") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return checkoutIdempotencyInProgress();
      }
      if (reservation.status === "idempotency_conflict") {
        await releaseCheckoutReservations(input, reservationIds, ctx.now);
        return checkoutIdempotencyInputMismatch();
      }

      reservationIds.push(reservation.event.id);
      lines.push({ ...resolution.line, reservationId: reservation.event.id });
    }
  } catch (error) {
    await releaseCheckoutReservations(input, reservationIds, ctx.now);
    throw error;
  }

  return { ok: true, lines, reservationIds };
}

async function persistCheckoutStart(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutDocument: CheckoutDocument,
  statusToken: string,
  cart: CartDocument | null,
  checkoutId: MikaId,
  lines: readonly CheckoutLine[],
  reservationIds: readonly MikaId[],
): Promise<{ readonly ok: true } | MikaApiFailure> {
  let checkoutPersisted = false;

  try {
    await input.repositories.session.put(checkoutDocument);
    checkoutPersisted = true;
    await putCheckoutStatusToken(input, ctx, checkoutDocument, statusToken);
    if (cart) {
      await input.repositories.session.put(
        cartWithCheckoutReservations(cart, checkoutId, lines, ctx.now),
      );
    }
  } catch {
    await releaseCheckoutReservations(input, reservationIds, ctx.now);
    if (cart) {
      await releaseCartCheckoutClaimQuietly(input, cart.id, checkoutId, ctx.now);
    }
    if (checkoutPersisted) {
      await markCheckoutPersistenceFailed(input, checkoutDocument, ctx.now);
    }

    return checkoutPersistenceFailed();
  }

  return { ok: true };
}

function checkoutStartCartForPersistence(
  resolvedCart: CartDocument | null,
  claimedCart: CartDocument | null,
): CartDocument | null {
  if (!resolvedCart || !claimedCart) return claimedCart ?? resolvedCart;

  return {
    ...resolvedCart,
    status: claimedCart.status,
    aggregate: {
      ...resolvedCart.aggregate,
      metadata: {
        ...resolvedCart.aggregate.metadata,
        ...claimedCart.aggregate.metadata,
      },
    },
    updatedAt: claimedCart.updatedAt,
  };
}

async function markCheckoutPersistenceFailed(
  input: CreateMikaBackendApiInput,
  checkoutDocument: CheckoutDocument,
  now: ISODateTime,
): Promise<void> {
  try {
    await input.repositories.session.put({
      ...checkoutDocument,
      status: "failed",
      providerStatus: "failed",
      redirectUrl: undefined,
      failureReason: "Checkout could not be persisted after provider handoff.",
      updatedAt: now,
      aggregate: {
        ...checkoutDocument.aggregate,
        metadata: checkoutFailedMetadata(checkoutDocument.aggregate.metadata),
      },
    });
  } catch (error) {
    // Best effort: if the local store is unavailable, stock release already compensated inventory.
    observeBackendError(input, "checkout.markPersistenceFailed", error, {
      checkoutId: checkoutDocument.id,
    });
  }
}

async function releaseCheckoutReservations(
  input: MikaStockLifecycleDependencies,
  reservationIds: readonly MikaId[],
  now: ISODateTime,
): Promise<void> {
  const stock = createMikaStockLifecycleService(input);

  for (const reservationEventId of reservationIds) {
    await stock.release({ reservationEventId, now });
  }
}

async function releaseCartCheckoutClaimQuietly(
  input: CreateMikaBackendApiInput,
  cartId: MikaId,
  checkoutId: MikaId,
  now: ISODateTime,
): Promise<void> {
  try {
    await input.repositories.session.releaseCartCheckoutClaim({ cartId, checkoutId, now });
  } catch (error) {
    // Best effort: unlock the cart so another checkout attempt can proceed.
    observeBackendError(input, "checkout.releaseCartClaim", error, { cartId, checkoutId });
  }
}

function checkoutMetadata(input: {
  readonly customFields: JsonObject | undefined;
  readonly customer?: CheckoutCustomerInput;
  readonly idempotencyInputHash?: string;
  readonly idempotencyKey: string | undefined;
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

function checkoutCustomerToMetadata(customer: CheckoutCustomerInput | undefined): JsonObject {
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

function checkoutCustomerFromMetadata(metadata: JsonObject | undefined): CheckoutCustomerInput {
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

function checkoutCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return filterJsonObject(customFields, CHECKOUT_INTERNAL_METADATA_KEYS);
}

function checkoutPersistedCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return filterJsonObject(customFields, CHECKOUT_PERSISTED_METADATA_OMIT_KEYS);
}

function filterJsonObject(
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

async function checkoutIdempotencyInputHash(
  input: CreateMikaBackendApiInput,
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

function checkoutStoredIdempotencyInputHash(document: CheckoutDocument): string | undefined {
  return (
    document.checkoutIdempotencyInputHash ??
    metadataString(document.aggregate.metadata, CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY)
  );
}

function checkoutDocumentResult(document: CheckoutDocument): MikaApiResult<CheckoutSessionDTO> {
  if (document.status === "failed") {
    return checkoutFailedReplay(document.id);
  }

  return checkoutDocumentSuccessResult(document);
}

async function checkoutStatus(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  statusInput: CheckoutStatusInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const checkoutId = createMikaId(statusInput.checkoutId);
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const accessError = await checkoutStatusAccessError(input, ctx, document, statusInput.token);
  if (accessError) return accessError;

  const bindingError = checkoutBindingError(document);
  if (bindingError) return bindingError;

  if (checkoutIsExpired(input, document)) {
    const expired = await expireCheckoutDocument(input, document, ctx.now);
    return checkoutStatusExpired(expired);
  }

  return checkoutDocumentSuccessResult(document);
}

async function expireCheckoutDocument(
  input: CreateMikaBackendApiInput,
  document: CheckoutDocument,
  now: ISODateTime,
): Promise<CheckoutDocument> {
  if (
    document.status === "completed" ||
    document.orderId ||
    !checkoutStatusCanExpire(document.status)
  ) {
    return document;
  }

  const reservationIds = document.aggregate.lines
    .map((line) => line.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, now);
  }

  if (document.status === "expired" && document.providerStatus === "expired") return document;

  const expired: CheckoutDocument = {
    ...document,
    status: "expired",
    providerStatus: "expired",
    updatedAt: now,
  };
  await input.repositories.session.put(expired);

  return expired;
}

async function cancelCheckout(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  cancelInput: CheckoutCancelInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const checkoutId = createMikaId(cancelInput.checkoutId);
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const accessError = await checkoutCancelAccessError(input, ctx, document, cancelInput.token);
  if (accessError) return accessError;

  if (document.status === "completed" || document.orderId) {
    return checkoutDocumentSuccessResult(document);
  }
  if (
    document.status === "cancelled" ||
    document.status === "expired" ||
    document.status === "failed"
  ) {
    return checkoutDocumentSuccessResult(document);
  }

  const reservationIds = document.aggregate.lines
    .map((line) => line.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, ctx.now);
  }

  const current = await input.repositories.session.findCheckoutById(checkoutId);
  if (!current) return invalidCheckout("checkoutId", checkoutId);
  if (current.status === "completed" || current.orderId) {
    return checkoutDocumentSuccessResult(current);
  }
  if (
    current.status === "cancelled" ||
    current.status === "expired" ||
    current.status === "failed"
  ) {
    return checkoutDocumentSuccessResult(current);
  }

  const cancelled: CheckoutDocument = {
    ...current,
    status: "cancelled",
    providerStatus: "cancelled",
    updatedAt: ctx.now,
  };
  await input.repositories.session.put(cancelled);

  const stored = await input.repositories.session.findCheckoutById(checkoutId);
  if (!stored) return invalidCheckout("checkoutId", checkoutId);
  if (stored.status === "completed" || stored.orderId) {
    return checkoutDocumentSuccessResult(stored);
  }

  const cartDocument = stored.cartId
    ? await input.repositories.session.findById(stored.cartId)
    : null;
  if (cartDocument && cartDocument.type === "cart" && cartDocument.status === "checkout_pending") {
    await input.repositories.session.put(reopenCartDocument(cartDocument, ctx.now));
  }

  return checkoutDocumentSuccessResult(cancelled);
}

function checkoutDocumentSuccessResult(
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
    document.orderId ?? metadataMikaId(document.aggregate.metadata, "checkoutOrderId");

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      status: sessionStatus,
      mode: document.aggregate.mode,
      provider: document.provider,
      redirectUrl,
      expiresAt: document.expiresAt,
      paymentPending: status === "pending" ? true : undefined,
      orderId,
    },
    effects: redirectUrl ? [{ type: "redirect", url: redirectUrl }] : undefined,
  };
}

function checkoutStatusAllowsRedirect(
  documentStatus: CheckoutStatus,
  sessionStatus: CheckoutSessionDTO["status"],
): boolean {
  if (
    documentStatus === "cancelled" ||
    documentStatus === "expired" ||
    documentStatus === "failed"
  ) {
    return false;
  }

  return (
    sessionStatus === "created" ||
    sessionStatus === "redirected" ||
    sessionStatus === "pending" ||
    sessionStatus === "completed"
  );
}

function checkoutBindingError(document: CheckoutDocument): MikaApiFailure | null {
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

function checkoutIsExpired(input: CreateMikaBackendApiInput, document: CheckoutDocument): boolean {
  if (document.status === "expired") return true;
  if (!checkoutStatusCanExpire(document.status)) return false;
  if (!document.expiresAt) return false;

  return new Date(document.expiresAt).getTime() <= input.now().getTime();
}

function checkoutStatusCanExpire(status: CheckoutStatus): boolean {
  return status === "created" || status === "redirected";
}

function checkoutStatusExpired(document: CheckoutDocument): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_EXPIRED",
      message: `Checkout '${document.id}' has expired.`,
    },
  };
}

function checkoutFailedMetadata(metadata: JsonObject | undefined): JsonObject {
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

function checkoutReservationIdempotencyKey(
  ctx: MikaRequestContext,
  resolution: CheckoutStartLineResolution,
): string | undefined {
  if (!ctx.idempotencyKey || !resolution.stock) return undefined;

  return [
    "checkout",
    ctx.idempotencyKey,
    resolution.stock.id,
    resolution.line.item.sellableId,
    resolution.line.item.priceId ?? "",
  ].join(":");
}

function cartWithCheckoutReservations(
  cart: CartDocument,
  checkoutId: MikaId,
  lines: readonly CheckoutLine[],
  updatedAt: ISODateTime,
): CartDocument {
  const reservationByCartLineId = new Map(
    lines.flatMap((line) =>
      line.cartLineId && line.reservationId ? [[line.cartLineId, line.reservationId] as const] : [],
    ),
  );

  const updated = updateCartDocument(
    cart,
    cart.aggregate.items.map((item) => ({
      ...item,
      reservationId: reservationByCartLineId.get(item.id) ?? item.reservationId,
    })),
    updatedAt,
  );
  const {
    checkoutStartClaimId: _checkoutStartClaimId,
    checkoutStartClaimExpiresAt: _checkoutStartClaimExpiresAt,
    ...metadata
  } = updated.aggregate.metadata ?? {};

  return {
    ...updated,
    status: "checkout_pending",
    aggregate: {
      ...updated.aggregate,
      metadata: {
        ...metadata,
        checkoutSessionId: checkoutId,
      },
    },
  };
}

function checkoutLineToProviderLine(
  provider: ProviderName,
  line: CheckoutLine,
): MikaProviderLineItem {
  const providerRef = line.item.providerRefs?.find((ref) => ref.provider === provider);

  return {
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
  };
}

function checkoutSuccessUrl(
  input: CreateMikaBackendApiInput,
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

function checkoutCancelUrl(
  input: CreateMikaBackendApiInput,
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

function checkoutSuccessTarget(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return checkoutInput.successPath === undefined
    ? (input.config?.checkout?.successUrl ?? "/checkout/success")
    : safeRequestReturnPath(ctx, checkoutInput.successPath, "/checkout/success");
}

function checkoutCancelTarget(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return checkoutInput.cancelPath === undefined
    ? (input.config?.checkout?.cancelUrl ?? "/checkout/cancel")
    : safeRequestReturnPath(ctx, checkoutInput.cancelPath, "/checkout/cancel");
}

function checkoutExpiresAt(input: CreateMikaBackendApiInput, ctx: MikaRequestContext): ISODateTime {
  const ttlMs = input.config?.checkout?.ttlMs ?? 15 * 60_000;

  return createISODateTime(new Date(new Date(ctx.now).getTime() + ttlMs).toISOString());
}

function checkoutDocumentStatus(status: CheckoutSessionDTO["status"]): CheckoutStatus {
  return status === "pending" ? "created" : status === "binding_mismatch" ? "failed" : status;
}

function checkoutSessionStatus(status: string): CheckoutSessionDTO["status"] {
  return status === "created" ||
    status === "redirected" ||
    status === "pending" ||
    status === "completed" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "failed" ||
    status === "binding_mismatch"
    ? status
    : "failed";
}

async function createCheckoutPreview(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  previewInput: CheckoutPreviewInput,
): Promise<CheckoutPreviewDTO> {
  const quote = await createCartQuote(input, ctx, previewInput);
  const mode = await resolveCheckoutPreviewMode(input, ctx, previewInput);
  const provider = previewInput.provider ?? input.defaults?.provider;
  const inputHash = await delegatedPaymentProofHash(input, previewInput, quote, mode, provider);
  const hasPaymentAuthorization =
    previewInput.proofRefs?.some(
      (proof) =>
        proof.kind === "payment_authorization" &&
        proof.inputHash !== undefined &&
        proof.inputHash === inputHash,
    ) ?? false;
  const requiredProofs = [
    {
      kind: "payment_authorization" as const,
      required: true,
      reason: "Checkout start requires payment confirmation before provider handoff.",
      inputHash,
      expiresAt: quote.expiresAt,
    },
  ];
  const status =
    quote.status === "expired"
      ? "expired"
      : quote.status === "unavailable"
        ? "unavailable"
        : hasPaymentAuthorization
          ? "ready"
          : "requires_payment_authorization";

  return {
    id: input.createId("checkout_preview"),
    quoteId: previewInput.quoteId ?? quote.id,
    status,
    mode,
    provider,
    quote,
    requiredProofs,
    acceptedProofs: ["consent", "mandate", "payment_authorization"],
    proofRefs: previewInput.proofRefs,
    expiresAt: quote.expiresAt,
    inputHash,
    warnings: quote.warnings,
    errors: quote.errors,
  };
}

async function delegatedPaymentProofHash(
  input: CreateMikaBackendApiInput,
  checkoutInput: StartCheckoutInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
): Promise<string> {
  return input.hash(
    stableJsonStringify(delegatedPaymentProofProjection(checkoutInput, quote, mode, provider)),
  );
}

function delegatedPaymentProofProjection(
  checkoutInput: StartCheckoutInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
): unknown {
  return {
    cartId: checkoutInput.cartId ?? quote.cartId,
    sellableId: checkoutInput.sellableId,
    priceId: checkoutInput.priceId,
    quantity: checkoutInput.quantity,
    provider,
    couponCode: checkoutInput.couponCode,
    mode,
    customer: checkoutInput.customer,
    customFields: delegatedPaymentProofCustomFields(checkoutInput.customFields),
    successPath: checkoutInput.successPath,
    cancelPath: checkoutInput.cancelPath,
    returnTo: checkoutInput.returnTo,
    quote: {
      cartId: quote.cartId,
      status: quote.status,
      currency: quote.currency,
      items: quote.items,
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      shipping: quote.shipping,
      total: quote.total,
      adjustments: quote.adjustments,
      coupon: quote.coupon,
      expiresAt: quote.expiresAt,
      warnings: quote.warnings,
      errors: quote.errors,
    },
  } satisfies Record<string, unknown>;
}

function delegatedPaymentProofCustomFields(
  customFields: JsonObject | undefined,
): JsonObject | undefined {
  const filtered = filterJsonObject(
    checkoutCustomMetadata(customFields),
    DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
  );

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

async function resolveCheckoutPreviewMode(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  previewInput: CheckoutPreviewInput,
): Promise<PurchaseMode | undefined> {
  if (previewInput.sellableId) {
    const catalog = await input.repositories.catalog.findItemBySellableId(previewInput.sellableId);
    const sellable = catalog?.aggregate.sellables.find(
      (item) => item.id === previewInput.sellableId,
    );
    return sellable
      ? selectCartPrice(sellable, previewInput.priceId, defaultBackendCurrency(input))?.mode
      : undefined;
  }

  const cartResult = await findQuoteCart(
    input,
    ctx,
    previewInput.cartId,
    defaultBackendCurrency(input),
  );
  const modes = new Set(cartResult.cart?.aggregate.items.map((line) => line.item.mode) ?? []);
  return modes.size === 1 ? modes.values().next().value : undefined;
}
