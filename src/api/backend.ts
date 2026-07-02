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
  type MikaProviderInvoiceInput,
  type MikaProviderLineItem,
  type MikaProviderPaymentEvent,
  type MikaProviderOrderCancelInput,
  type MikaProviderRefundInput,
  type MikaProviderSubscriptionActionInput,
  type MikaProviderSubscriptionEvent,
  type MikaProviderWebhookEvent,
  type MikaVerifiedWebhookPayload,
} from "../provider";
import type { AdjustStockRepositoryResult } from "../storage/repositories";
import {
  findSessionRepositoryOpenCartBySessionAnyCurrency,
  nextCartVersion,
} from "../storage/repositories";
import {
  cartWithCoupon,
  cartWithoutCoupon,
  catalogSellablesToDTO,
  couponDiscountAmount,
  createCartAggregate,
  createCheckoutAggregate,
  createOrderAggregate,
  createSubscriptionAggregate,
  createWishlistAggregate,
  orderLineFromCheckoutLine,
  snapshotPrice,
  stockAvailabilityToDTO,
} from "../model/builders";
import { renderMikaEmail } from "../email";
import { emitMikaNotification } from "./notifications";
import { mikaPluginRoute } from "./routes";
import { mikaSafeReturnPath } from "./redirect-policy";
import { createMikaAdminBackend } from "./backend-admin";
import {
  applyOrderCancel,
  applyOrderRefund,
  applyPaymentEventToOrder,
  orderBlocksFulfillment,
  orderIsPaymentTerminal,
  orderRefundedAmount,
  subscriptionCancelAtPeriodEndAfterAction,
  subscriptionStatusAfterAction,
} from "./lifecycle";
import type {
  CartLine,
  CheckoutLine,
  CouponSnapshot,
  CustomerSnapshot,
  OrderLine,
  SellableDefinition,
  WishlistItem,
} from "../types/aggregates";
import type {
  CartDocument,
  CheckoutDocument,
  AccountDeleteRequestDocument,
  AccountExportDocument,
  CustomerDocument,
  EmailDocument,
  EntitlementDocument,
  LicenseDocument,
  OrderDocument,
  SubscriptionDocument,
  WebhookDocument,
  WorkflowDocument,
  WishlistDocument,
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
  SubscriptionStatus,
} from "../types/primitives";
import type { StockItemRecord } from "../types/operational";
import type { MikaRequestContext } from "./context";
import type {
  MikaNotificationContextMap,
  MikaNotificationIntent,
  MikaNotificationKind,
  MikaOrderConfirmedNotificationContext,
} from "./notifications";
import { createMikaApi, type MikaApi } from "./server";
import type {
  AccountDTO,
  AccountExportDTO,
  AccountExportDownloadDTO,
  AdminActionResultDTO,
  CartDTO,
  CartQuoteDTO,
  CheckoutCustomerInput,
  CheckoutPreviewDTO,
  CheckoutCancelInput,
  CheckoutPreviewInput,
  CheckoutSessionDTO,
  CheckoutStatusInput,
  MikaApiResult,
  DownloadDTO,
  DownloadIssueInput,
  DownloadResolutionDTO,
  EntitlementDTO,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  EmailResendInput,
  LicenseRevokeInput,
  OrderCancelInput,
  OrderInvoiceDTO,
  OrderInvoiceInput,
  OrderRefundInput,
  OrderSummaryDTO,
  ProviderHealthDTO,
  ProviderHealthInput,
  ProviderSyncInput,
  StartCheckoutInput,
  SubscriptionDTO,
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
  authRequired,
  cartLineNotFound,
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
  invalidWishlist,
  observeBackendError,
  orderNotFound,
  orderNotificationRecipient,
  outOfStock,
  providerFailed,
  providerUnsupportedForAction,
  sellableNotFound,
  subscriptionNotificationRecipient,
  tokenResult,
  validationFailed,
  webhookInvalid,
  webhookProcessingDeferred,
  wishlistItemNotFound,
} from "./backend/errors";
import type { MikaApiFailure } from "./backend/errors";
import { WorkflowRunner, WorkflowRunnerLeaseLostError } from "./backend/workflow-runner";
import {
  createMikaStockLifecycleService,
  expireCheckoutReservations,
} from "./backend/stock-lifecycle";
import type { MikaStockLifecycleDependencies } from "./backend/stock-lifecycle";
import {
  accountExportBelongsToIdentity,
  accountExportSubjectHash,
  checkoutBelongsToContext,
  customerEmailHash,
  hydratedCartOverrides,
  hydratedCheckoutOverrides,
  hydratedWishlistOverrides,
  isAnonymizedCustomer,
  orderAccessRevokedForAccountDelete,
  orderAllowsDownload,
  resolveAccountIdentity,
  withHydratedCustomerHandler,
} from "./backend/identity";
import {
  accountExportArtifactRef,
  accountExportDownloadTokenError,
  checkoutCancelAccessError,
  checkoutStatusAccessError,
  createOrderInvoiceToken,
  createOrderLineDownloadToken,
  downloadTokenError,
  hashAccountExportDownloadToken,
  hashDownloadToken,
  hashMagicLinkToken,
  magicLinkTokenError,
  orderDownloadSubjectHash,
  orderInvoiceAccessError,
  putCheckoutStatusToken,
} from "./backend/tokens";
import {
  assertCompletedProviderAction,
  missingTargetWithAudit,
  requireProviderFeature,
  runAdminProviderAction,
  runAdminRepositoryAction,
  stableJsonStringify,
  toIdempotencyJson,
} from "./backend/admin-audit";
import {
  callerOwnsMergeSource,
  cartDocumentToDTO,
  cartPriceUnavailable,
  couponRejectionMessage,
  couponSnapshotForSubtotal,
  createCartQuote,
  createCouponSnapshot,
  findOpenCart,
  findQuoteCart,
  isEquivalentCartLine,
  isEquivalentWishlistItem,
  reopenCartDocument,
  resolveCartLine,
  resolveWishlistItem,
  selectCartPrice,
  siblingSellableQuantity,
  updateCartDocument,
  validateQuantityLimit,
  wishlistDocumentToDTO,
} from "./backend/quote";
import type { MikaCartWishlistBackendInput } from "./backend/quote";
export { createMikaFixedRateCouponResolver } from "./backend/quote";
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

function createCartBackend(input: MikaCartWishlistBackendInput): MikaApi["cart"] {
  const cart = {
    get: async (ctx) => {
      const document = await findOrCreateOpenCart(input, ctx);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, document) };
    },
    quote: async (ctx, quoteInput) => {
      const quote = await createCartQuote(input, ctx, quoteInput);

      return { ok: true, status: 200, data: quote };
    },
    add: async (ctx, itemInput) => {
      const currency = input.defaults?.currency;
      if (!currency) {
        return validationFailed("currency", "A default cart currency is required.");
      }

      const resolved = await resolveCartLine(input, itemInput, currency);
      if (!resolved.ok) return resolved;

      const existing = await findOpenCart(input, ctx, currency);
      if (existing) {
        const writeBlocked = cartWriteBlocked(existing);
        if (writeBlocked) return writeBlocked;

        const merged = mergeCartAddLine(existing.aggregate.items, resolved.line, resolved);
        if (!merged.ok) return merged;

        const updated = updateCartDocument(existing, merged.items, ctx.now);
        const persisted = await putCartOrConflict(input, updated, existing.version);
        if (!persisted.ok) return persisted;

        return { ok: true, status: 200, data: await cartDocumentToDTO(input, persisted.cart) };
      }

      const quantityError = validateQuantityLimit(
        resolved.sellable,
        resolved.stock,
        resolved.line.quantity,
      );
      if (quantityError) return quantityError;

      return createCartWithFirstLine(input, ctx, currency, resolved.line, resolved);
    },
    update: async (ctx, itemInput) => {
      if (!Number.isInteger(itemInput.quantity) || itemInput.quantity < 1) {
        return validationFailed("quantity", "Quantity must be a positive whole number.");
      }

      const document = await findOrCreateOpenCart(input, ctx);
      const writeBlocked = cartWriteBlocked(document);
      if (writeBlocked) return writeBlocked;
      const line = document.aggregate.items.find((item) => item.id === itemInput.lineId);
      if (!line) {
        return cartLineNotFound(itemInput.lineId);
      }

      const catalog = await input.repositories.catalog.findItemBySellableId(line.item.sellableId);
      const sellable = catalog?.aggregate.sellables.find(
        (item) => item.id === line.item.sellableId,
      );
      if (!sellable) {
        return sellableNotFound(line.item.sellableId);
      }

      const stock = await input.repositories.stock.findBySellableId(line.item.sellableId);
      const sellableDemand =
        itemInput.quantity + siblingSellableQuantity(document.aggregate.items, line);
      const quantityError = validateQuantityLimit(sellable, stock, sellableDemand);
      if (quantityError) return quantityError;

      const updated = updateCartDocument(
        document,
        document.aggregate.items.map((item) =>
          item.id === itemInput.lineId ? { ...item, quantity: itemInput.quantity } : item,
        ),
        ctx.now,
      );

      const persisted = await putCartOrConflict(input, updated, document.version);
      if (!persisted.ok) return persisted;

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, persisted.cart) };
    },
    remove: async (ctx, itemInput) => {
      const document = await findOrCreateOpenCart(input, ctx);
      const writeBlocked = cartWriteBlocked(document);
      if (writeBlocked) return writeBlocked;
      if (!document.aggregate.items.some((item) => item.id === itemInput.lineId)) {
        return cartLineNotFound(itemInput.lineId);
      }

      const updated = updateCartDocument(
        document,
        document.aggregate.items.filter((item) => item.id !== itemInput.lineId),
        ctx.now,
      );

      const persisted = await putCartOrConflict(input, updated, document.version);
      if (!persisted.ok) return persisted;

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, persisted.cart) };
    },
    merge: async (ctx, mergeInput) => {
      const currency = defaultBackendCurrency(input);
      const targetResult = mergeInput.targetCartId
        ? await findOwnedOpenCartById(input, ctx, mergeInput.targetCartId, "targetCartId")
        : { ok: true as const, cart: await findOrCreateOpenCart(input, ctx) };
      if (!targetResult.ok) return targetResult;
      const writeBlocked = cartWriteBlocked(targetResult.cart);
      if (writeBlocked) return writeBlocked;
      if (targetResult.cart.aggregate.currency !== currency) {
        return validationFailed(
          "targetCartId",
          `Target cart uses currency '${targetResult.cart.aggregate.currency}'.`,
        );
      }

      const sourceSessionId = mergeInput.sourceSessionId;
      if (!sourceSessionId) {
        return {
          ok: true,
          status: 200,
          data: await cartDocumentToDTO(input, targetResult.cart),
        };
      }

      const source =
        (await input.repositories.session.findOpenCartBySession(sourceSessionId, currency)) ??
        (await findOpenCartBySessionAnyCurrency(input, sourceSessionId));
      if (!source || source.id === targetResult.cart.id || !callerOwnsMergeSource(ctx, source)) {
        return {
          ok: true,
          status: 200,
          data: await cartDocumentToDTO(input, targetResult.cart),
        };
      }
      if (source.aggregate.currency !== targetResult.cart.aggregate.currency) {
        return validationFailed(
          "sourceSessionId",
          `Source cart uses currency '${source.aggregate.currency}'.`,
        );
      }

      const mergedItemsResult = await mergeCartLines(input, targetResult.cart, source);
      if (!mergedItemsResult.ok) return mergedItemsResult;

      const updated = updateCartDocument(
        targetResult.cart,
        mergedItemsResult.items,
        ctx.now,
        targetResult.cart.aggregate.coupon ?? source.aggregate.coupon,
      );

      const persisted = await putCartOrConflict(input, updated, targetResult.cart.version);
      if (!persisted.ok) return persisted;
      const finalTarget = await abandonMergedSourceCart(input, ctx, source, persisted.cart);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, finalTarget) };
    },
    applyCoupon: async (ctx, couponInput) => {
      const cartResult = couponInput.cartId
        ? await findOwnedOpenCartById(input, ctx, couponInput.cartId, "cartId")
        : { ok: true as const, cart: await findOrCreateOpenCart(input, ctx) };
      if (!cartResult.ok) return cartResult;
      const writeBlocked = cartWriteBlocked(cartResult.cart);
      if (writeBlocked) return writeBlocked;

      const code = couponInput.code.trim();
      if (!code) {
        return validationFailed("code", "Coupon code is required.");
      }

      const coupon = await createCouponSnapshot(input, cartResult.cart, code);
      if (!coupon) {
        return validationFailed("code", couponRejectionMessage(input, code.toUpperCase()));
      }

      const updated: CartDocument = {
        ...cartResult.cart,
        updatedAt: ctx.now,
        version: nextCartVersion(cartResult.cart.version),
        aggregate: cartWithCoupon({
          cart: cartResult.cart.aggregate,
          coupon,
        }),
      };

      const persisted = await putCartOrConflict(input, updated, cartResult.cart.version);
      if (!persisted.ok) return persisted;

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, persisted.cart) };
    },
    removeCoupon: async (ctx, couponInput) => {
      const cartResult = couponInput.cartId
        ? await findOwnedOpenCartById(input, ctx, couponInput.cartId, "cartId")
        : { ok: true as const, cart: await findOrCreateOpenCart(input, ctx) };
      if (!cartResult.ok) return cartResult;
      const writeBlocked = cartWriteBlocked(cartResult.cart);
      if (writeBlocked) return writeBlocked;

      const updated: CartDocument = {
        ...cartResult.cart,
        updatedAt: ctx.now,
        version: nextCartVersion(cartResult.cart.version),
        aggregate: cartWithoutCoupon({ cart: cartResult.cart.aggregate }),
      };

      const persisted = await putCartOrConflict(input, updated, cartResult.cart.version);
      if (!persisted.ok) return persisted;

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, persisted.cart) };
    },
  } satisfies MikaApi["cart"];

  return {
    get: withHydratedCustomerHandler(input, cart.get),
    quote: withHydratedCustomerHandler(input, cart.quote),
    add: withHydratedCustomerHandler(input, cart.add),
    update: withHydratedCustomerHandler(input, cart.update),
    remove: withHydratedCustomerHandler(input, cart.remove),
    merge: withHydratedCustomerHandler(input, cart.merge),
    applyCoupon: withHydratedCustomerHandler(input, cart.applyCoupon),
    removeCoupon: withHydratedCustomerHandler(input, cart.removeCoupon),
    ...hydratedCartOverrides(input, input.overrides?.cart),
  };
}

function createWishlistBackend(input: MikaCartWishlistBackendInput): MikaApi["wishlist"] {
  const wishlist = {
    get: async (ctx) => {
      const document = await findOrCreateActiveWishlist(input, ctx);

      return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, document) };
    },
    add: async (ctx, itemInput) => {
      const resolved = await resolveWishlistItem(input, itemInput);
      if (!resolved.ok) return resolved;

      const document = await findOrCreateActiveWishlist(input, ctx);
      const existingItem = document.aggregate.items.find((item) =>
        isEquivalentWishlistItem(item, resolved.item),
      );
      const items = existingItem
        ? document.aggregate.items
        : [...document.aggregate.items, resolved.item];
      const updated = updateWishlistDocument(document, items, ctx.now);

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, updated) };
    },
    remove: async (ctx, itemInput) => {
      const document = await findOrCreateActiveWishlist(input, ctx);
      if (!document.aggregate.items.some((item) => item.id === itemInput.itemId)) {
        return wishlistItemNotFound(itemInput.itemId);
      }

      const updated = updateWishlistDocument(
        document,
        document.aggregate.items.filter((item) => item.id !== itemInput.itemId),
        ctx.now,
      );

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, updated) };
    },
    moveToCart: async (ctx, itemInput) => {
      const quantity = itemInput.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        return validationFailed("quantity", "Quantity must be a positive whole number.");
      }

      const document = await findOrCreateActiveWishlist(input, ctx);
      const item = document.aggregate.items.find((candidate) => candidate.id === itemInput.itemId);
      if (!item) {
        return wishlistItemNotFound(itemInput.itemId);
      }

      const currency = defaultBackendCurrency(input);
      const existingCart = await findOpenCart(input, ctx, currency);
      if (existingCart) {
        const writeBlocked = cartWriteBlocked(existingCart);
        if (writeBlocked) return writeBlocked;
      }
      const cart = existingCart ?? createCartDocument(input, ctx, currency);
      if (item.item.currency !== cart.aggregate.currency) {
        return validationFailed(
          "itemId",
          `Wishlist item '${item.id}' uses currency '${item.item.currency}'.`,
        );
      }

      const line: CartLine = {
        id: input.createId("cart_line"),
        item: item.item,
        quantity,
        addedAt: ctx.now,
        metadata: item.metadata,
      };
      const itemsResult = await mergeCartLine(input, cart.aggregate.items, line);
      if (!itemsResult.ok) return itemsResult;

      const updatedCart = updateCartDocument(cart, itemsResult.items, ctx.now);
      const updatedWishlist = updateWishlistDocument(
        document,
        document.aggregate.items.filter((candidate) => candidate.id !== item.id),
        ctx.now,
      );

      await input.repositories.session.put(updatedCart);
      await input.repositories.session.put(updatedWishlist);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updatedCart) };
    },
    saveForLater: async (ctx, itemInput) => {
      const cart = await findOrCreateOpenCart(input, ctx);
      const writeBlocked = cartWriteBlocked(cart);
      if (writeBlocked) return writeBlocked;
      const line = cart.aggregate.items.find((candidate) => candidate.id === itemInput.lineId);
      if (!line) {
        return cartLineNotFound(itemInput.lineId);
      }

      const document = await findOrCreateActiveWishlist(input, ctx);
      const item: WishlistItem = {
        id: input.createId("wishlist_item"),
        item: line.item,
        addedAt: ctx.now,
        metadata: line.metadata,
      };
      const wishlistItems = mergeWishlistItems(document.aggregate.items, [item]);
      const updatedWishlist = updateWishlistDocument(document, wishlistItems, ctx.now);
      const updatedCart = updateCartDocument(
        cart,
        cart.aggregate.items.filter((candidate) => candidate.id !== line.id),
        ctx.now,
      );

      await input.repositories.session.put(updatedWishlist);
      await input.repositories.session.put(updatedCart);

      return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, updatedWishlist) };
    },
    merge: async (ctx, mergeInput) => {
      const targetResult = mergeInput.targetWishlistId
        ? await findOwnedActiveWishlistById(input, ctx, mergeInput.targetWishlistId)
        : { ok: true as const, wishlist: await findOrCreateActiveWishlist(input, ctx) };
      if (!targetResult.ok) return targetResult;

      const sourceSessionId = mergeInput.sourceSessionId;
      if (!sourceSessionId) {
        return {
          ok: true,
          status: 200,
          data: await wishlistDocumentToDTO(input, targetResult.wishlist),
        };
      }

      const source = await input.repositories.session.findWishlistBySession(sourceSessionId);
      if (
        !source ||
        source.id === targetResult.wishlist.id ||
        !callerOwnsMergeSource(ctx, source)
      ) {
        return {
          ok: true,
          status: 200,
          data: await wishlistDocumentToDTO(input, targetResult.wishlist),
        };
      }

      const updated = updateWishlistDocument(
        targetResult.wishlist,
        mergeWishlistItems(targetResult.wishlist.aggregate.items, source.aggregate.items),
        ctx.now,
      );
      const mergedSource: WishlistDocument = {
        ...source,
        status: "merged",
        updatedAt: ctx.now,
      };

      await input.repositories.session.put(updated);
      await input.repositories.session.put(mergedSource);

      return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, updated) };
    },
  } satisfies MikaApi["wishlist"];

  return {
    get: withHydratedCustomerHandler(input, wishlist.get),
    add: withHydratedCustomerHandler(input, wishlist.add),
    remove: withHydratedCustomerHandler(input, wishlist.remove),
    moveToCart: withHydratedCustomerHandler(input, wishlist.moveToCart),
    saveForLater: withHydratedCustomerHandler(input, wishlist.saveForLater),
    merge: withHydratedCustomerHandler(input, wishlist.merge),
    ...hydratedWishlistOverrides(input, input.overrides?.wishlist),
  };
}

async function getAccount(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<MikaApiResult<AccountDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account access requires an authenticated customer identity.");
  }

  if (identity.customer) {
    return {
      ok: true,
      status: 200,
      data: await accountDTOForCustomer(input, ctx, identity.customer),
    };
  }

  const orderItems = identity.emailHash
    ? (await input.repositories.ledger.listOrdersByEmailHash(identity.emailHash)).items
    : [];
  const orders = await Promise.all(
    orderItems.map((item) => orderSummaryDTO(input, ctx, item.data)),
  );

  return {
    ok: true,
    status: 200,
    data: {
      orders,
      subscriptions: [],
      entitlements: identity.entitlements.map((item) => entitlementDTO(item.data)),
      downloads: (
        await Promise.all(orderItems.map((item) => orderDownloadDTOs(input, ctx, item.data)))
      ).flat(),
    },
  };
}

async function requestAccountExport(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<MikaApiResult<AccountExportDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account export requires an authenticated customer identity.");
  }

  const now = ctx.now;
  const exportId = input.createId("account_export");
  const token = input.createId("account_export_token");
  const tokenHash = await hashAccountExportDownloadToken(input, token);
  const expiresAt = addMilliseconds(now, input.config?.accountExport?.ttlMs ?? 24 * 60 * 60_000);
  const account = identity.customer
    ? await accountDTOForCustomer(input, ctx, identity.customer, ACCOUNT_EXPORT_LIMIT)
    : {
        orders: [],
        subscriptions: [],
        entitlements: identity.entitlements.map((item) => entitlementDTO(item.data)),
        downloads: [],
      };
  const artifactRef = accountExportArtifactRef(account, now);

  await input.repositories.ephemeral.put({
    key: tokenHash,
    kind: "token",
    subjectHash: accountExportSubjectHash(identity),
    status: "pending",
    count: 0,
    expiresAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
    data: {
      purpose: "account_export_download",
      exportId,
    },
  });

  const identityEmailHash = identity.customer?.emailHash ?? identity.emailHash;
  const record = {
    id: exportId,
    customerId: identity.customer?.customerId,
    userId: identity.customer?.userId ?? identity.userId,
    ...(identityEmailHash ? { emailHash: identityEmailHash } : {}),
    status: "ready" as const,
    requestedAt: now,
    finishedAt: now,
    expiresAt,
    downloadTokenHash: tokenHash,
    artifactRef,
  };

  const document: AccountExportDocument = {
    id: exportId,
    type: "accountExport",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    status: record.status,
    expiresAt,
    record,
    createdAt: now,
    updatedAt: now,
  };

  await input.repositories.ops.put(document);

  const dto = accountExportDTO(document, ctx, token);
  await emitBackendNotification(input, "account.export_ready", now, {
    ...(record.customerId ? { customerId: record.customerId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...((identity.customer?.emailHash ?? identity.emailHash)
      ? { emailHash: identity.customer?.emailHash ?? identity.emailHash }
      : {}),
    exportId,
    expiresAt,
    ...(dto.downloadHref ? { downloadHref: dto.downloadHref } : {}),
    tokenId: token,
  });

  return { ok: true, status: 202, data: dto };
}

async function accountExportStatus(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  statusInput: { readonly exportId: MikaId },
): Promise<MikaApiResult<AccountExportDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account export status requires an authenticated customer identity.");
  }

  const document = await input.repositories.ops.findAccountExport(statusInput.exportId);
  if (!document || !accountExportBelongsToIdentity(document, identity)) {
    return forbidden("Account export is not available for this identity.");
  }

  return { ok: true, status: 200, data: accountExportDTO(document, ctx) };
}

async function downloadAccountExport(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  downloadInput: {
    readonly exportId: MikaId;
    readonly token?: string;
    readonly consumeToken?: boolean;
  },
): Promise<MikaApiResult<AccountExportDownloadDTO>> {
  const document = await input.repositories.ops.findAccountExport(downloadInput.exportId);
  if (!document) {
    return tokenResult("TOKEN_INVALID", "Account export download token is invalid.");
  }

  if (downloadInput.token) {
    const tokenHash = await hashAccountExportDownloadToken(input, downloadInput.token.trim());
    if (tokenHash !== document.record.downloadTokenHash) {
      return tokenResult("TOKEN_INVALID", "Account export download token is invalid.");
    }

    const record = await input.repositories.ephemeral.get(tokenHash);
    const tokenError = accountExportDownloadTokenError(record, document.id, ctx.now);
    if (tokenError) return tokenError;

    if (!downloadInput.consumeToken) {
      return accountExportDownloadConfirmationResult(document, ctx.now);
    }

    const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, ctx.now);
    if (!consumed) {
      const current = await input.repositories.ephemeral.get(tokenHash);
      return (
        accountExportDownloadTokenError(current, document.id, ctx.now) ??
        tokenResult("TOKEN_INVALID", "Account export download token is invalid.")
      );
    }

    return accountExportDownloadResult(document, ctx.now);
  }

  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account export download requires an authenticated customer identity.");
  }
  if (!accountExportBelongsToIdentity(document, identity)) {
    return forbidden("Account export download is not available for this identity.");
  }

  return accountExportDownloadResult(document, ctx.now);
}

async function requestAccountDelete(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<MikaApiResult<{ requested: boolean }>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account deletion requires an authenticated customer identity.");
  }
  const block = await accountDeleteBlocked(input, {
    customerId: identity.customer?.customerId,
    sessionId: ctx.sessionId,
  });
  if (block) return block;

  const now = ctx.now;
  const requestId = input.createId("account_delete_request");
  const record = {
    id: requestId,
    customerId: identity.customer?.customerId,
    userId: identity.customer?.userId ?? identity.userId,
    emailHash: identity.customer?.emailHash ?? identity.emailHash,
    status: "queued" as const,
    requestedAt: now,
  };
  const document: AccountDeleteRequestDocument = {
    id: requestId,
    type: "accountDeleteRequest",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    status: record.status,
    record,
    createdAt: now,
    updatedAt: now,
  };

  await input.repositories.ops.put(document);

  await emitBackendNotification(input, "account.delete_requested", now, {
    ...(record.customerId ? { customerId: record.customerId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.emailHash ? { emailHash: record.emailHash } : {}),
    requestId,
  });

  return { ok: true, status: 202, data: { requested: true } };
}

async function accountDeleteBlocked(
  input: CreateMikaBackendApiInput,
  identity: { readonly customerId?: MikaId; readonly sessionId?: string },
): Promise<MikaApiFailure | null> {
  if (identity.customerId) {
    const subscriptions = await input.repositories.account.listSubscriptionsByCustomer(
      identity.customerId,
      Number.MAX_SAFE_INTEGER,
    );
    const activeSubscription = subscriptions.items.find((item) =>
      subscriptionBlocksAccountDelete(item.data),
    );
    if (activeSubscription) {
      return apiFailure(
        409,
        "CONFLICT",
        "Account deletion is blocked while an active subscription exists. Cancel the subscription in the host application first.",
        { subscriptionId: "Active subscriptions must be cancelled before account deletion." },
      );
    }

    const pendingCarts = await input.repositories.session.listCheckoutPendingCartsByCustomer(
      identity.customerId,
      1,
    );
    if (pendingCarts.items.length > 0) {
      return apiFailure(
        409,
        "CONFLICT",
        "Account deletion is blocked while a checkout is in progress.",
        { cartId: "Complete or cancel the active checkout before account deletion." },
      );
    }
  }

  if (identity.sessionId) {
    const pendingCarts = await input.repositories.session.listCheckoutPendingCartsBySession(
      identity.sessionId,
      1,
    );
    if (pendingCarts.items.length > 0) {
      return apiFailure(
        409,
        "CONFLICT",
        "Account deletion is blocked while a checkout is in progress.",
        { cartId: "Complete or cancel the active checkout before account deletion." },
      );
    }
  }

  return null;
}

function subscriptionBlocksAccountDelete(subscription: SubscriptionDocument): boolean {
  return subscription.status !== "cancelled" && subscription.status !== "expired";
}

async function createAccountPortalSession(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  portalInput: { readonly returnTo?: string },
): Promise<MikaApiResult<{ redirectUrl: string }>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity?.customer) {
    return authRequired("Account portal requires an authenticated customer identity.");
  }

  const providerAccount = (
    await input.repositories.account.listProviderAccountsByCustomer(identity.customer.customerId, 1)
  ).items[0]?.data;
  if (!providerAccount) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: "No provider account is available for portal sessions.",
      },
    };
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: providerAccount.provider,
    method: "createPortalSession",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support portal sessions.`,
  });
  if (!providerFeature.ok) return providerFeature;

  try {
    const session = await providerFeature.method.call(providerFeature.provider, {
      providerCustomerId: providerAccount.providerCustomerId,
      returnUrl: accountPortalReturnUrl(ctx, portalInput.returnTo),
    });

    return {
      ok: true,
      status: 200,
      data: { redirectUrl: session.redirectUrl },
    };
  } catch (error) {
    return providerFailed(
      error instanceof Error ? error.message : "Provider portal session failed.",
    );
  }
}

type SubscriptionActionKind = "cancel" | "change" | "renew";

const subscriptionActionMethods = {
  cancel: "cancelSubscription",
  change: "changeSubscription",
  renew: "renewSubscription",
} as const;

async function runSubscriptionAction(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  actionInput: { readonly subscriptionId: MikaId; readonly priceId?: MikaId },
  action: SubscriptionActionKind,
): Promise<MikaApiResult<AccountDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity?.customer) {
    return authRequired("Subscription changes require an authenticated customer identity.");
  }

  const subscription = await input.repositories.account.findSubscriptionById(
    actionInput.subscriptionId,
  );
  if (!subscription || subscription.customerId !== identity.customer.customerId) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        message: `Subscription '${actionInput.subscriptionId}' was not found.`,
        fieldErrors: { subscriptionId: "Subscription was not found." },
      },
    };
  }

  if (subscription.status === "cancelled" || subscription.status === "expired") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Subscription '${actionInput.subscriptionId}' is ${subscription.status} and cannot be modified.`,
        fieldErrors: { subscriptionId: `Subscription is ${subscription.status}.` },
      },
    };
  }

  const methodName = subscriptionActionMethods[action];
  const providerFeature = await requireProviderFeature(input, {
    providerName: subscription.provider,
    method: methodName,
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support subscription ${action}.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const priceMatch =
    action === "change" && actionInput.priceId
      ? await input.repositories.catalog.findPriceById(actionInput.priceId)
      : null;
  if (action === "change" && actionInput.priceId && !priceMatch) {
    return validationFailed("priceId", `Price '${actionInput.priceId}' was not found.`);
  }
  if (action === "change" && actionInput.priceId && priceMatch) {
    const current = subscription.aggregate.sellable;
    if (
      priceMatch.sellable.id !== current.sellableId ||
      priceMatch.price.mode !== "subscription" ||
      priceMatch.price.currency !== current.currency
    ) {
      return validationFailed(
        "priceId",
        `Price '${actionInput.priceId}' is not a valid change target for this subscription.`,
      );
    }
  }

  const providerPriceId =
    priceMatch?.price.providerRefs.find((ref) => ref.provider === subscription.provider)?.priceId ??
    (action === "change" ? undefined : subscription.aggregate.providerRef.priceId);
  if (action === "change" && actionInput.priceId && !providerPriceId) {
    return providerUnsupportedForAction(
      `Price '${actionInput.priceId}' is not mapped for provider '${subscription.provider}'.`,
    );
  }

  const providerSubscriptionId =
    subscription.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId;
  const providerInput: MikaProviderSubscriptionActionInput = {
    subscriptionId: subscription.id,
    ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
    ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
    ...(providerPriceId ? { providerPriceId } : {}),
  };
  const idempotencyInput: JsonObject = {
    subscriptionId: actionInput.subscriptionId,
    ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
  };

  return runAdminProviderAction(
    input,
    {
      action: `subscription.${action}`,
      targetType: "subscription",
      targetId: subscription.id,
      idempotencyKey: ctx.idempotencyKey,
      idempotencyInput,
      metadata: {
        provider: subscription.provider,
        subscriptionId: subscription.id,
        ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
        ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
        ...(providerPriceId ? { providerPriceId } : {}),
      },
    },
    async () => {
      const result = await providerFeature.method.call(providerFeature.provider, providerInput);
      if (result.status !== "completed") {
        throw new Error(
          result.message ??
            `Provider subscription ${action} did not complete (status: ${result.status}).`,
        );
      }

      await updateSubscriptionAfterAction(input, ctx, subscription, action, priceMatch);

      return accountDTOForCustomer(input, ctx, identity.customer);
    },
    `Provider subscription ${action} failed.`,
  );
}

async function updateSubscriptionAfterAction(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
  action: SubscriptionActionKind,
  priceMatch: Awaited<ReturnType<MikaBackendRepositories["catalog"]["findPriceById"]>>,
): Promise<SubscriptionDocument> {
  const providerPriceId = priceMatch?.price.providerRefs.find(
    (ref) => ref.provider === subscription.provider,
  )?.priceId;
  const changedSellable = priceMatch
    ? snapshotPrice({
        content: priceMatch.catalog.aggregate.content,
        sellable: priceMatch.sellable,
        price: priceMatch.price,
        fallbackTitle: priceMatch.catalog.titleSnapshot ?? priceMatch.sellable.id,
      })
    : subscription.aggregate.sellable;
  const status = subscriptionStatusAfterAction(subscription.status, action);
  const cancelAtPeriodEnd = subscriptionCancelAtPeriodEndAfterAction(
    subscription.aggregate.cancelAtPeriodEnd,
    action,
  );
  const updated: SubscriptionDocument = {
    ...subscription,
    status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      sellable: changedSellable,
      providerRef: {
        ...subscription.aggregate.providerRef,
        ...(providerPriceId ? { priceId: providerPriceId } : {}),
      },
      status,
      cancelAtPeriodEnd,
      metadata: {
        ...subscription.aggregate.metadata,
        lastAdminAction: `subscription.${action}`,
      },
    },
  };

  await input.repositories.account.put(updated);
  const fulfilled = await updateSubscriptionEntitlement(input, ctx, updated);
  await emitSubscriptionLifecycleNotification(input, ctx.now, fulfilled, {
    previous: subscription,
  });

  return fulfilled;
}

async function providerHealth(
  input: CreateMikaBackendApiInput,
  healthInput: ProviderHealthInput,
): Promise<MikaApiResult<ProviderHealthDTO>> {
  const providerName = healthInput.provider ?? input.defaults?.provider;
  if (!providerName) return providerUnsupportedForAction("No provider is configured.");

  const provider = input.providers.get(providerName);
  if (!provider)
    return providerUnsupportedForAction(`Provider '${providerName}' is not configured.`);

  try {
    const health =
      (await provider.health?.()) ??
      ({
        provider: providerName,
        ok: true,
        capabilities: await provider.capabilities(),
        checkedAt: currentBackendISODateTime(input),
      } satisfies ProviderHealthDTO);

    return { ok: true, status: 200, data: health };
  } catch (error) {
    return providerFailed(error instanceof Error ? error.message : "Provider health check failed.");
  }
}

async function providerSync(
  input: CreateMikaBackendApiInput,
  syncInput: ProviderSyncInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  if (syncInput.scope === "entry" && !syncInput.contentRef) {
    return validationFailed("contentRef", "Entry-scoped provider sync requires contentRef.");
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: syncInput.provider,
    method: "syncCatalog",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support catalog sync.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const providerInput = {
    mode: syncInput.mode ?? "dry_run",
    ...(syncInput.scope ? { scope: syncInput.scope } : {}),
    ...(syncInput.contentRef ? { contentRef: syncInput.contentRef } : {}),
  };
  const syncMetadata: JsonObject = {
    provider: providerFeature.providerName,
    mode: providerInput.mode,
    ...(providerInput.scope ? { scope: providerInput.scope } : {}),
    ...(providerInput.contentRef
      ? {
          contentRef: {
            collection: providerInput.contentRef.collection,
            id: providerInput.contentRef.id,
            ...(providerInput.contentRef.locale ? { locale: providerInput.contentRef.locale } : {}),
          },
        }
      : {}),
  };

  return runAdminProviderAction(
    input,
    {
      action: "provider.syncCatalog",
      idempotencyKey: syncInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(syncInput),
      metadata: syncMetadata,
    },
    () => providerFeature.method.call(providerFeature.provider, providerInput),
    "Provider catalog sync failed.",
  );
}

async function releaseExpiredReservations(
  input: CreateMikaBackendApiInput,
  releaseInput: { readonly now?: ISODateTime; readonly idempotencyKey?: string } = {},
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const release = async (): Promise<AdminActionResultDTO> => {
    const result = await createMikaStockLifecycleService(input).releaseExpiredReservations({
      now: releaseInput.now ?? currentBackendISODateTime(input),
    });

    return {
      status: "completed",
      affected: {
        reservationsScanned: result.scannedCount,
        reservationsReleased: result.releasedCount,
        stockItems: result.stockItemsAffected,
      },
    };
  };

  if (!releaseInput.idempotencyKey) {
    return {
      ok: true,
      status: 200,
      data: await release(),
    };
  }

  return runAdminRepositoryAction(
    input,
    {
      action: "stock.releaseExpiredReservations",
      idempotencyKey: releaseInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(releaseInput),
      metadata: releaseInput.now ? { now: releaseInput.now } : {},
    },
    release,
    "Expired reservation release failed.",
  );
}

async function refundOrder(
  input: CreateMikaBackendApiInput,
  refundInput: OrderRefundInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const order = await input.repositories.ledger.findOrderById(refundInput.orderId);
  if (!order) {
    return orderNotFound(refundInput.orderId);
  }
  if (order.status === "cancelled") {
    return validationFailed("orderId", `Order '${order.id}' is cancelled and cannot be refunded.`);
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: order.provider,
    method: "refundPayment",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support order refunds.`,
  });
  if (!providerFeature.ok) return providerFeature;
  const refundableAmount = Math.max(0, order.totalAmount - orderRefundedAmount(order));
  if (refundableAmount <= 0) {
    return validationFailed("amount", `Order '${order.id}' has no remaining refundable amount.`);
  }
  if (refundInput.amount !== undefined && refundInput.amount > refundableAmount) {
    return validationFailed(
      "amount",
      `Refund amount exceeds the remaining refundable amount for order '${order.id}'.`,
    );
  }

  const providerInput: MikaProviderRefundInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(refundInput.amount !== undefined ? { amount: refundInput.amount } : {}),
    ...(refundInput.reason ? { reason: refundInput.reason } : {}),
    ...(refundInput.idempotencyKey ? { idempotencyKey: refundInput.idempotencyKey } : {}),
  };

  return runAdminProviderAction(
    input,
    {
      action: "order.refund",
      targetType: "order",
      targetId: order.id,
      idempotencyKey: refundInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(refundInput),
      metadata: {
        provider: order.provider,
        orderId: order.id,
        ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
        ...(refundInput.amount !== undefined ? { amount: refundInput.amount } : {}),
        ...(refundInput.reason ? { reason: refundInput.reason } : {}),
      },
    },
    async () => {
      const result = await providerFeature.method.call(providerFeature.provider, providerInput);
      assertCompletedProviderAction(result, "Provider order refund did not complete.");

      const now = currentBackendISODateTime(input);
      const updated = updateOrderAfterRefund(order, refundInput, now);
      await input.repositories.ledger.put(updated);
      if (updated.status === "refunded") {
        await revokeOrderFulfillmentAccess(input, updated, now, "order_refunded");
      }

      return {
        ...result,
        id: result.id ?? order.id,
        status: "completed",
      };
    },
    "Provider order refund failed.",
  );
}

/**
 * Revokes entitlements and licenses created by order fulfillment when an order is
 * fully refunded. Fulfillment documents use deterministic ids derived from the order
 * and line id, so each line's entitlement/license is recomputed and revoked in place.
 * Only `entitlement` and `license` fulfillment kinds create revocable access; other
 * kinds (`download`, `external`, `none`) have nothing to revoke. Already-revoked or
 * missing documents are skipped. Partial refunds intentionally retain access.
 */
async function revokeOrderFulfillmentAccess(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  now: ISODateTime,
  revokeReason: "order_refunded" | "order_cancelled" = "order_refunded",
): Promise<void> {
  for (const line of order.aggregate.lines) {
    switch (line.item.fulfillmentKind) {
      case "entitlement": {
        const entitlement = await input.repositories.account.findEntitlementById(
          fulfillmentDocumentId("entitlement", order.id, line.id),
        );
        if (entitlement && entitlement.status === "active") {
          await input.repositories.account.put({
            ...entitlement,
            status: "revoked",
            updatedAt: now,
            record: {
              ...entitlement.record,
              status: "revoked",
              revokedAt: now,
              metadata: {
                ...entitlement.record.metadata,
                revokeReason,
              },
            },
          });
        }
        break;
      }
      case "license": {
        const license = await input.repositories.account.findLicenseById(
          fulfillmentDocumentId("license", order.id, line.id),
        );
        if (license && license.status === "active") {
          await input.repositories.account.put({
            ...license,
            status: "revoked",
            updatedAt: now,
            record: {
              ...license.record,
              status: "revoked",
              revokedAt: now,
              metadata: {
                ...license.record.metadata,
                revokeReason,
              },
            },
          });
        }
        break;
      }
    }
  }
}

async function cancelOrder(
  input: CreateMikaBackendApiInput,
  cancelInput: OrderCancelInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const order = await input.repositories.ledger.findOrderById(cancelInput.orderId);
  if (!order) {
    return orderNotFound(cancelInput.orderId);
  }
  if (orderIsPaymentTerminal(order)) {
    return validationFailed(
      "orderId",
      `Order '${order.id}' is in a terminal payment state and cannot be cancelled.`,
    );
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: order.provider,
    method: "cancelOrder",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support order cancellation.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const providerInput: MikaProviderOrderCancelInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
    ...(cancelInput.reason ? { reason: cancelInput.reason } : {}),
  };

  return runAdminProviderAction(
    input,
    {
      action: "order.cancel",
      targetType: "order",
      targetId: order.id,
      idempotencyKey: cancelInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(cancelInput),
      metadata: {
        provider: order.provider,
        orderId: order.id,
        ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
        ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
        ...(cancelInput.reason ? { reason: cancelInput.reason } : {}),
      },
    },
    async () => {
      const result = await providerFeature.method.call(providerFeature.provider, providerInput);
      assertCompletedProviderAction(result, "Provider order cancellation did not complete.");

      const now = currentBackendISODateTime(input);
      const updated = updateOrderAfterCancel(order, cancelInput, now);
      await input.repositories.ledger.put(updated);
      await revokeOrderFulfillmentAccess(input, updated, now, "order_cancelled");

      return {
        ...result,
        id: result.id ?? order.id,
        status: "completed",
      };
    },
    "Provider order cancellation failed.",
  );
}

async function getOrderInvoice(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  invoiceInput: OrderInvoiceInput,
): Promise<MikaApiResult<OrderInvoiceDTO>> {
  const order = await input.repositories.ledger.findOrderById(invoiceInput.orderId);
  if (!order) return orderNotFound(invoiceInput.orderId);

  const accessError = await orderInvoiceAccessError(input, ctx, order, invoiceInput.token);
  if (accessError) return accessError;

  if (order.aggregate.invoiceUrl) {
    return {
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        href: order.aggregate.invoiceUrl,
      },
    };
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: order.provider,
    method: "getInvoiceUrl",
    capability: "invoice_url",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support invoice URLs.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const providerInput: MikaProviderInvoiceInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
  };

  try {
    const invoice = await providerFeature.method.call(providerFeature.provider, providerInput);

    return {
      ok: true,
      status: 200,
      data: {
        ...invoice,
        orderId: order.id,
      },
    };
  } catch {
    return providerFailed("Provider invoice lookup failed.");
  }
}

async function grantEntitlement(
  input: CreateMikaBackendApiInput,
  grantInput: EntitlementGrantInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const email = grantInput.email?.trim();
  const emailHash = email ? await input.hash(`email:${email.toLowerCase()}`) : undefined;
  const entitlementId = input.createId("entitlement");

  return runAdminRepositoryAction(
    input,
    {
      action: "entitlement.grant",
      targetType: "entitlement",
      targetId: entitlementId,
      idempotencyKey: grantInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(grantInput),
      metadata: {
        entitlementKey: grantInput.entitlementKey,
        ...(grantInput.customerId ? { customerId: grantInput.customerId } : {}),
        ...(grantInput.userId ? { userId: grantInput.userId } : {}),
        ...(emailHash ? { emailHash } : {}),
        ...(grantInput.expiresAt ? { expiresAt: grantInput.expiresAt } : {}),
      },
    },
    async (audit) => {
      const entitlement = createManualEntitlementDocument(
        entitlementId,
        grantInput,
        audit.createdAt,
        emailHash,
      );
      await input.repositories.account.put(entitlement);

      return {
        id: entitlement.id,
        status: "completed",
        affected: {
          entitlements: 1,
        },
      };
    },
    "Entitlement grant failed.",
  );
}

async function revokeEntitlement(
  input: CreateMikaBackendApiInput,
  revokeInput: EntitlementRevokeInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const entitlements = await findEntitlementsForRevoke(input, revokeInput);
  const primaryEntitlement = entitlements[0];
  if (!primaryEntitlement) {
    return missingTargetWithAudit(input, {
      action: "entitlement.revoke",
      targetType: "entitlement",
      field: "entitlementId",
      value: revokeInput.entitlementId ?? revokeInput.entitlementKey ?? "unknown",
      targetId: revokeInput.entitlementId,
      metadata: {
        ...(revokeInput.entitlementKey ? { entitlementKey: revokeInput.entitlementKey } : {}),
        ...(revokeInput.customerId ? { customerId: revokeInput.customerId } : {}),
      },
    });
  }

  return runAdminRepositoryAction(
    input,
    {
      action: "entitlement.revoke",
      targetType: "entitlement",
      targetId: primaryEntitlement.id,
      idempotencyKey: revokeInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(revokeInput),
      metadata: {
        entitlementId: primaryEntitlement.id,
        entitlementIds: entitlements.map((entitlement) => entitlement.id),
        entitlementKey: primaryEntitlement.entitlementKey,
        ...(primaryEntitlement.customerId ? { customerId: primaryEntitlement.customerId } : {}),
        ...(revokeInput.reason ? { reason: revokeInput.reason } : {}),
      },
    },
    async (audit) => {
      const now = audit.createdAt;
      const updated: EntitlementDocument[] = entitlements.map((entitlement) => ({
        ...entitlement,
        status: "revoked",
        updatedAt: now,
        record: {
          ...entitlement.record,
          status: "revoked",
          revokedAt: now,
          metadata: {
            ...entitlement.record.metadata,
            ...(revokeInput.reason ? { revokeReason: revokeInput.reason } : {}),
          },
        },
      }));
      for (const entitlement of updated) {
        await input.repositories.account.put(entitlement);
      }

      return {
        id: primaryEntitlement.id,
        status: "completed",
        affected: {
          entitlements: updated.length,
        },
      };
    },
    "Entitlement revoke failed.",
  );
}

async function resendEmail(
  input: CreateMikaBackendApiInput,
  resendInput: EmailResendInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const email = await input.repositories.ops.findEmail(resendInput.emailId);
  if (!email) {
    return missingTargetWithAudit(input, {
      action: "email.resend",
      targetType: "email",
      field: "emailId",
      value: resendInput.emailId,
      targetId: resendInput.emailId,
    });
  }

  return runAdminRepositoryAction(
    input,
    {
      action: "email.resend",
      targetType: "email",
      targetId: email.id,
      idempotencyKey: resendInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(resendInput),
      metadata: {
        emailId: email.id,
        kind: email.kind,
      },
    },
    async (audit) => {
      const now = audit.createdAt;
      await input.repositories.ops.put({
        ...email,
        status: "queued",
        nextAttemptAt: now,
        updatedAt: now,
        record: {
          ...email.record,
          status: "queued",
          nextAttemptAt: now,
          attemptCount: 0,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError: undefined,
          metadata: {
            ...email.record.metadata,
            resentAt: now,
            adminAuditId: audit.id,
          },
        },
      });

      return {
        id: email.id,
        status: "completed",
        affected: {
          emails: 1,
        },
      };
    },
    "Email resend failed.",
  );
}

async function revokeLicense(
  input: CreateMikaBackendApiInput,
  revokeInput: LicenseRevokeInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const license = await input.repositories.account.findLicenseById(revokeInput.licenseId);
  if (!license) {
    return missingTargetWithAudit(input, {
      action: "license.revoke",
      targetType: "license",
      field: "licenseId",
      value: revokeInput.licenseId,
      targetId: revokeInput.licenseId,
    });
  }

  return runAdminRepositoryAction(
    input,
    {
      action: "license.revoke",
      targetType: "license",
      targetId: license.id,
      idempotencyKey: revokeInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(revokeInput),
      metadata: {
        licenseId: license.id,
        ...(license.customerId ? { customerId: license.customerId } : {}),
        ...(license.orderId ? { orderId: license.orderId } : {}),
        ...(license.orderLineId ? { orderLineId: license.orderLineId } : {}),
        ...(revokeInput.reason ? { reason: revokeInput.reason } : {}),
      },
    },
    async (audit) => {
      const now = audit.createdAt;
      const updated: LicenseDocument = {
        ...license,
        status: "revoked",
        updatedAt: now,
        record: {
          ...license.record,
          status: "revoked",
          revokedAt: now,
          metadata: {
            ...license.record.metadata,
            ...(revokeInput.reason ? { revokeReason: revokeInput.reason } : {}),
          },
        },
      };
      await input.repositories.account.put(updated);

      return {
        id: updated.id,
        status: "completed",
        affected: {
          licenses: 1,
        },
      };
    },
    "License revoke failed.",
  );
}

async function issueDownload(
  input: CreateMikaBackendApiInput,
  issueInput: DownloadIssueInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const target = await resolveDownloadIssueTarget(input, issueInput);
  if (!target) {
    return missingTargetWithAudit(input, {
      action: "download.issue",
      targetType: "download",
      field: "orderId",
      value: issueInput.orderId ?? issueInput.entitlementId ?? "unknown",
      targetId: issueInput.orderId,
      metadata: {
        ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
        ...(issueInput.orderLineId ? { orderLineId: issueInput.orderLineId } : {}),
      },
    });
  }

  const now = currentBackendISODateTime(input);
  const expiresAt =
    issueInput.expiresAt ?? addMilliseconds(now, input.config?.download?.tokenTtlMs ?? 15 * 60_000);
  const downloadToken = input.createId("download_token");
  const downloadTokenHash = await hashDownloadToken(input, downloadToken);
  return runAdminRepositoryAction(
    input,
    {
      action: "download.issue",
      targetType: "download",
      targetId: createMikaId(target.downloadRef),
      createdAt: now,
      idempotencyKey: issueInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(issueInput),
      metadata: {
        orderId: target.order.id,
        orderLineId: target.line.id,
        downloadRef: target.downloadRef,
        ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
        ...(target.license?.id ? { licenseId: target.license.id } : {}),
        expiresAt,
      },
    },
    async (audit) => {
      if (!target.line.downloadRefs?.includes(target.downloadRef)) {
        await input.repositories.ledger.put(
          addDownloadRefToOrder(target.order, target.line.id, target.downloadRef, now),
        );
      }

      const subjectHash = orderDownloadSubjectHash(target.order);
      await input.repositories.ephemeral.put({
        key: downloadTokenHash,
        kind: "token",
        ...(subjectHash ? { subjectHash } : {}),
        status: "pending",
        count: 0,
        expiresAt,
        version: 1,
        createdAt: now,
        updatedAt: now,
        data: {
          purpose: "download",
          tokenId: downloadToken,
          downloadRef: target.downloadRef,
          orderId: target.order.id,
          orderLineId: target.line.id,
          ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
          ...(target.license?.id ? { licenseId: target.license.id } : {}),
          title: target.line.item.titleSnapshot,
          redirectUrl: target.downloadRef,
          adminAuditId: audit.id,
        },
      });

      await emitBackendNotification(input, "download.ready", now, {
        ...orderNotificationRecipient(target.order),
        downloadRef: target.downloadRef,
        orderId: target.order.id,
        orderLineId: target.line.id,
        title: target.line.item.titleSnapshot,
        tokenId: downloadToken,
        expiresAt,
        ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
        ...(target.license?.id ? { licenseId: target.license.id } : {}),
      });

      return {
        id: createMikaId(target.downloadRef),
        status: "completed",
        affected: {
          downloads: 1,
          tokens: 1,
        },
      };
    },
    "Download issue failed.",
  );
}

function createManualEntitlementDocument(
  entitlementId: MikaId,
  grantInput: EntitlementGrantInput,
  now: ISODateTime,
  emailHash?: string,
): EntitlementDocument {
  const record = {
    id: entitlementId,
    ...(grantInput.customerId ? { customerId: grantInput.customerId } : {}),
    ...(grantInput.userId ? { userId: grantInput.userId } : {}),
    ...(emailHash ? { emailHash } : {}),
    entitlementKey: grantInput.entitlementKey,
    status: "active" as const,
    ...(grantInput.expiresAt ? { currentPeriodEnd: grantInput.expiresAt } : {}),
    grantedAt: now,
    metadata: {
      source: "admin",
    },
  };

  return {
    id: entitlementId,
    type: "entitlement",
    schemaVersion: 1,
    ...(record.customerId ? { customerId: record.customerId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.emailHash ? { emailHash: record.emailHash } : {}),
    entitlementKey: record.entitlementKey,
    status: record.status,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

async function findEntitlementsForRevoke(
  input: CreateMikaBackendApiInput,
  revokeInput: EntitlementRevokeInput,
): Promise<readonly EntitlementDocument[]> {
  if (revokeInput.entitlementId) {
    const entitlement = await input.repositories.account.findEntitlementById(
      revokeInput.entitlementId,
    );
    return entitlement ? [entitlement] : [];
  }

  if (!revokeInput.customerId || !revokeInput.entitlementKey) return [];

  const entitlements = await input.repositories.account.listEntitlementsByCustomer(
    revokeInput.customerId,
  );
  return entitlements.items.flatMap((item) =>
    item.data.entitlementKey === revokeInput.entitlementKey && item.data.status === "active"
      ? [item.data]
      : [],
  );
}

async function resolveDownloadIssueTarget(
  input: CreateMikaBackendApiInput,
  issueInput: DownloadIssueInput,
): Promise<{
  readonly order: OrderDocument;
  readonly line: OrderLine;
  readonly downloadRef: string;
  readonly license?: LicenseDocument;
} | null> {
  const entitlement = issueInput.entitlementId
    ? await input.repositories.account.findEntitlementById(issueInput.entitlementId)
    : null;
  if (issueInput.entitlementId && (!entitlement || entitlement.status !== "active")) return null;

  const orderId = issueInput.orderId ?? entitlement?.orderId;
  if (!orderId) return null;

  const order = await input.repositories.ledger.findOrderById(orderId);
  if (!order) return null;

  const line =
    order.aggregate.lines.find((candidate) => candidate.id === issueInput.orderLineId) ??
    order.aggregate.lines.find(
      (candidate) => candidate.entitlementId === issueInput.entitlementId,
    ) ??
    order.aggregate.lines[0];
  if (!line || (issueInput.orderLineId && line.id !== issueInput.orderLineId)) return null;

  const downloadRef = line.downloadRefs?.[0] ?? orderLineDownloadRef(order, line);
  const license = await findLicenseForDownload(input, order, line, issueInput.entitlementId);

  return { order, line, downloadRef, ...(license ? { license } : {}) };
}

async function findLicenseForDownload(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  line: OrderLine,
  entitlementId?: MikaId,
): Promise<LicenseDocument | null> {
  if (!order.customerId) return null;

  const licenses = await input.repositories.account.listLicensesByCustomer(order.customerId);
  return (
    licenses.items.find(
      (item) =>
        item.data.status === "active" &&
        item.data.orderId === order.id &&
        item.data.orderLineId === line.id &&
        (!entitlementId || item.data.entitlementId === entitlementId),
    )?.data ?? null
  );
}

function addDownloadRefToOrder(
  order: OrderDocument,
  orderLineId: MikaId,
  downloadRef: string,
  now: ISODateTime,
): OrderDocument {
  return {
    ...order,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      lines: order.aggregate.lines.map((line) =>
        line.id === orderLineId
          ? { ...line, downloadRefs: [...(line.downloadRefs ?? []), downloadRef] }
          : line,
      ),
      metadata: {
        ...order.aggregate.metadata,
        lastAdminAction: "download.issue",
      },
    },
  };
}

/** Reports a swallowed best-effort failure to the host observer; never throws. */
async function requestMagicLink(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  requestInput: { readonly email: string; readonly returnTo?: string },
): Promise<MikaApiResult<{ sent: boolean }>> {
  const email = requestInput.email.trim();
  const normalizedEmail = email.toLowerCase();
  const emailHash = await input.hash(`email:${normalizedEmail}`);
  const token = input.createId("magic_link_token");
  const tokenHash = await hashMagicLinkToken(input, token);
  const tokenId = token;
  const now = ctx.now;
  const expiresAt = addMilliseconds(now, input.config?.magicLink?.ttlMs ?? 15 * 60_000);
  const customer = await input.repositories.account.findCustomerByEmailHash(emailHash);
  const safeReturnTo =
    requestInput.returnTo === undefined
      ? undefined
      : safeRequestReturnPath(ctx, requestInput.returnTo);

  await input.repositories.ephemeral.put({
    key: tokenHash,
    kind: "token",
    subjectHash: emailHash,
    status: "pending",
    count: 0,
    expiresAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
    data: {
      purpose: "magic_link",
      tokenId,
      email,
      emailHash,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
    },
  });

  const link = magicLinkUrl(input, ctx, token, safeReturnTo);
  const intent: MikaNotificationIntent<"magic_link.requested"> = {
    kind: "magic_link.requested",
    occurredAt: now,
    context: {
      toEmail: email,
      emailHash,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      ...(customer?.userId ? { userId: customer.userId } : {}),
      link,
      purpose: "sign_in",
      expiresAt,
      ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
      tokenId,
    },
  };

  await emitMikaNotification(
    input.notifications?.handle,
    intent,
    () => queueDefaultMagicLinkRequestedEmail(input, intent, tokenHash),
    (error) => observeBackendError(input, "notification.hook.magic_link.requested", error),
  );

  return { ok: true, status: 200, data: { sent: true } };
}

async function queueDefaultMagicLinkRequestedEmail(
  input: CreateMikaBackendApiInput,
  intent: MikaNotificationIntent<"magic_link.requested">,
  tokenHash: string,
): Promise<void> {
  const { context } = intent;
  const now = intent.occurredAt;
  const rendered = renderMikaEmail("magic_link", {
    toEmail: context.toEmail,
    url: context.link,
    purpose: context.purpose,
    expiresAt: context.expiresAt,
  });
  const emailId = input.createId("email");
  const emailRecord = {
    id: emailId,
    customerId: context.customerId,
    tokenId: context.tokenId,
    kind: "magic_link" as const,
    toEmail: context.toEmail,
    subject: rendered.subject,
    status: "queued" as const,
    idempotencyKey: `magic-link:${tokenHash}`,
    templateKey: rendered.template,
    templateVersion: "1",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: now,
    createdAt: now,
    metadata: {
      purpose: context.purpose,
      expiresAt: context.expiresAt,
      link: context.link,
      ...(context.emailHash ? { emailHash: context.emailHash } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.returnTo ? { returnTo: context.returnTo } : {}),
    },
  };

  await input.repositories.ops.put({
    id: emailId,
    type: "email",
    schemaVersion: 1,
    status: emailRecord.status,
    nextAttemptAt: emailRecord.nextAttemptAt,
    tokenId: emailRecord.tokenId,
    kind: emailRecord.kind,
    record: emailRecord,
    createdAt: now,
    updatedAt: now,
  });
}

async function verifyMagicLink(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  verifyInput: { readonly token: string; readonly returnTo?: string },
): Promise<MikaApiResult<AccountDTO>> {
  if (!ctx.session) {
    return authRequired("Magic link verification requires a writable session.");
  }

  const tokenHash = await hashMagicLinkToken(input, verifyInput.token.trim());
  const record = await input.repositories.ephemeral.get(tokenHash);
  const tokenError = magicLinkTokenError(record, ctx.now);
  if (tokenError) return tokenError;

  const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, ctx.now);
  if (!consumed) {
    const current = await input.repositories.ephemeral.get(tokenHash);
    return (
      magicLinkTokenError(current, ctx.now) ??
      tokenResult("TOKEN_INVALID", "Magic link token is invalid.")
    );
  }

  try {
    const customer = record?.subjectHash
      ? await input.repositories.account.findCustomerByEmailHash(record.subjectHash)
      : null;
    if (customer) {
      const data = await accountDTOForCustomer(input, ctx, customer);
      await ctx.session.regenerate?.();
      await clearSessionKeys(ctx.session, ["mika.emailHash", "mika.userId"]);
      await ctx.session.set("mika.customerId", customer.customerId);
      if (customer.userId) await ctx.session.set("mika.userId", customer.userId);

      return { ok: true, status: 200, data };
    }

    const email = record?.data ? stringChild(record.data, "email") : undefined;
    if (record?.subjectHash) {
      await ctx.session.regenerate?.();
      await clearSessionKeys(ctx.session, ["mika.customerId", "mika.userId"]);
      await ctx.session.set("mika.emailHash", record.subjectHash);
    }

    return {
      ok: true,
      status: 200,
      data: {
        customer: email ? { email } : undefined,
        orders: [],
        subscriptions: [],
        entitlements: [],
        downloads: [],
      },
    };
  } catch (error) {
    await input.repositories.ephemeral
      .restoreToken(tokenHash, ctx.now)
      .catch((restoreError: unknown) =>
        observeBackendError(input, "magicLink.restoreToken", restoreError),
      );
    throw error;
  }
}

async function clearSessionKeys(
  session: NonNullable<MikaRequestContext["session"]>,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    if (session.delete) {
      await session.delete(key);
    } else {
      await session.set<undefined>(key, undefined);
    }
  }
}

const ACCOUNT_EXPORT_LIMIT = Number.MAX_SAFE_INTEGER;

async function accountDTOForCustomer(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  customer: CustomerDocument,
  limit?: number,
): Promise<AccountDTO> {
  const emailHash = customerEmailHash(customer);
  const [
    customerOrders,
    emailHashOrders,
    subscriptions,
    customerEntitlements,
    emailHashEntitlements,
  ] = await Promise.all([
    input.repositories.ledger.listOrdersByCustomer(customer.customerId, limit),
    emailHash
      ? input.repositories.ledger.listOrdersByEmailHash(emailHash, limit)
      : Promise.resolve({ items: [], nextCursor: undefined }),
    input.repositories.account.listSubscriptionsByCustomer(customer.customerId, limit),
    input.repositories.account.listEntitlementsByCustomer(customer.customerId, limit),
    emailHash
      ? input.repositories.account.listEntitlementsByEmailHash(emailHash, limit)
      : Promise.resolve({ items: [], nextCursor: undefined }),
  ]);

  const orders = uniqueDocumentsById([...customerOrders.items, ...emailHashOrders.items]);
  const entitlements = uniqueDocumentsById([
    ...customerEntitlements.items,
    ...emailHashEntitlements.items,
  ]);
  const orderSummaries = await Promise.all(
    orders.map((item) => orderSummaryDTO(input, ctx, item.data)),
  );

  return {
    customer: {
      id: customer.customerId,
      userId: customer.userId,
      email: customer.aggregate.email,
      name: customer.aggregate.name,
    },
    orders: orderSummaries,
    subscriptions: subscriptions.items.map((item) => subscriptionDTO(item.data)),
    entitlements: entitlements.map((item) => entitlementDTO(item.data)),
    downloads: (
      await Promise.all(orders.map((item) => orderDownloadDTOs(input, ctx, item.data)))
    ).flat(),
  };
}

function uniqueDocumentsById<TDocument extends { readonly id: string }>(
  items: readonly {
    readonly id: string;
    readonly data: TDocument;
  }[],
): readonly {
  readonly id: string;
  readonly data: TDocument;
}[] {
  const seen = new Set<string>();
  const unique: {
    readonly id: string;
    readonly data: TDocument;
  }[] = [];

  for (const item of items) {
    if (seen.has(item.data.id)) continue;
    seen.add(item.data.id);
    unique.push(item);
  }

  return unique;
}

async function orderSummaryDTO(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<OrderSummaryDTO> {
  const invoiceToken = await createOrderInvoiceToken(input, ctx, order);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.aggregate.totals.total,
    createdAt: order.createdAt,
    invoiceHref: mikaPluginRoute("orderInvoice", {
      origin: ctx.url,
      search: { orderId: order.id, token: invoiceToken },
    }),
  };
}

function subscriptionDTO(subscription: SubscriptionDocument): SubscriptionDTO {
  return {
    id: subscription.id,
    title: subscription.aggregate.sellable.titleSnapshot,
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.aggregate.cancelAtPeriodEnd,
  };
}

function entitlementDTO(entitlement: EntitlementDocument): EntitlementDTO {
  return {
    key: entitlement.entitlementKey,
    status: entitlement.status,
    source: entitlement.orderId ? "order" : entitlement.subscriptionId ? "subscription" : "manual",
    expiresAt: entitlement.record.currentPeriodEnd,
  };
}

async function orderDownloadDTOs(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<readonly DownloadDTO[]> {
  const downloads: DownloadDTO[] = [];
  for (const line of order.aggregate.lines) {
    for (const downloadRef of line.downloadRefs ?? []) {
      const { token, expiresAt } = await createOrderLineDownloadToken(
        input,
        ctx,
        order,
        line,
        downloadRef,
      );
      downloads.push({
        id: createMikaId(downloadRef),
        title: line.item.titleSnapshot,
        href: `/download/${token}`,
        expiresAt,
      });
    }
  }
  return downloads;
}

function accountExportDTO(
  document: AccountExportDocument,
  ctx: MikaRequestContext,
  token?: string,
): AccountExportDTO {
  const expired = document.expiresAt <= ctx.now;
  const status = expired && document.status !== "failed" ? "expired" : document.status;

  return {
    id: document.id,
    status,
    requestedAt: document.record.requestedAt,
    expiresAt: document.expiresAt,
    ...(status === "ready"
      ? {
          downloadHref: mikaPluginRoute("accountExportDownload", {
            origin: ctx.url?.origin,
            search: {
              exportId: document.id,
              token,
            },
          }),
        }
      : {}),
  };
}

function accountExportDownloadResult(
  document: AccountExportDocument,
  now: ISODateTime,
): MikaApiResult<AccountExportDownloadDTO> {
  if (document.expiresAt <= now || document.status === "expired") {
    return tokenResult("TOKEN_EXPIRED", "Account export download token has expired.");
  }
  if (document.status !== "ready") {
    return tokenResult("TOKEN_INVALID", "Account export download is not ready.");
  }

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      href: document.record.artifactRef,
      expiresAt: document.expiresAt,
    },
  };
}

function accountExportDownloadConfirmationResult(
  document: AccountExportDocument,
  now: ISODateTime,
): MikaApiResult<AccountExportDownloadDTO> {
  const ready = accountExportDownloadResult(document, now);
  if (!ready.ok) return ready;

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      expiresAt: document.expiresAt,
      requiresConfirmation: true,
      confirmMethod: "POST",
    },
  };
}

async function resolveDownload(
  input: CreateMikaBackendApiInput,
  downloadInput: { readonly token: string },
  consumeToken: boolean,
): Promise<MikaApiResult<DownloadResolutionDTO>> {
  const now = input.isoNow?.() ?? createISODateTime(input.now().toISOString());
  const tokenHash = await hashDownloadToken(input, downloadInput.token.trim());
  const record = await input.repositories.ephemeral.get(tokenHash);
  const tokenError = downloadTokenError(record, now);
  if (tokenError) return tokenError;

  const data = record?.data ?? {};
  const downloadRef = stringChild(data, "downloadRef");
  if (!downloadRef) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }

  // createOrderLineDownloadToken always stamps the order id it minted the token for onto the
  // token record, so the common case resolves via a direct indexed lookup instead of scanning
  // every order for a matching downloadRef. Only a token missing that field (predating it, or
  // host-authored without it) falls back to the full-ledger scan.
  const tokenOrderId = stringChild(data, "orderId");
  const order = tokenOrderId
    ? await input.repositories.ledger.findOrderById(createMikaId(tokenOrderId))
    : await input.repositories.ledger.findOrderByDownloadRef(downloadRef);
  const line = order?.aggregate.lines.find((candidate) =>
    candidate.downloadRefs?.includes(downloadRef),
  );
  if (!order || !line || !orderAllowsDownload(order)) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }
  if (orderAccessRevokedForAccountDelete(order)) {
    return tokenResult("DOWNLOAD_REVOKED", "Download access has been revoked.");
  }

  const orderLineId = stringChild(data, "orderLineId");
  if (orderLineId && line.id !== orderLineId) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }

  const entitlementId = stringChild(data, "entitlementId");
  if (entitlementId) {
    const entitlement = await input.repositories.account.findEntitlementById(
      createMikaId(entitlementId),
    );
    if (
      !entitlement ||
      entitlement.status !== "active" ||
      (entitlement.record.currentPeriodEnd !== undefined &&
        entitlement.record.currentPeriodEnd <= now) ||
      (entitlement.orderId && entitlement.orderId !== order.id)
    ) {
      return tokenResult("DOWNLOAD_REVOKED", "Download access has been revoked.");
    }
  }

  const licenseId = stringChild(data, "licenseId");
  if (licenseId) {
    const license = await input.repositories.account.findLicenseById(createMikaId(licenseId));
    if (
      !license ||
      license.status !== "active" ||
      license.record.orderId !== order.id ||
      license.record.orderLineId !== line.id
    ) {
      return tokenResult("DOWNLOAD_REVOKED", "Download access has been revoked.");
    }
  }

  if (consumeToken) {
    const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, now);
    if (!consumed) {
      const current = await input.repositories.ephemeral.get(tokenHash);
      return (
        downloadTokenError(current, now) ??
        tokenResult("TOKEN_INVALID", "Download token is invalid.")
      );
    }
  }

  return {
    ok: true,
    status: 200,
    data: {
      title: stringChild(data, "title") ?? line.item.titleSnapshot,
      redirectUrl: stringChild(data, "redirectUrl") ?? downloadRef,
      expiresAt: record?.expiresAt,
    },
  };
}

const DEFAULT_MAGIC_LINK_VERIFY_PATH = "/account/magic-link";

function magicLinkUrl(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  token: string,
  returnTo?: string,
): string {
  const verifyPath = input.config?.magicLink?.verifyPath ?? DEFAULT_MAGIC_LINK_VERIFY_PATH;
  const search = new URLSearchParams({ token });
  if (returnTo) search.set("returnTo", returnTo);
  const target = `${verifyPath}?${search.toString()}`;

  return ctx.url?.origin ? new URL(target, ctx.url.origin).toString() : target;
}

function accountPortalReturnUrl(ctx: MikaRequestContext, returnTo?: string): string {
  if (!returnTo) return ctx.url?.href ?? "/";
  if (!ctx.url) return safeRequestReturnPath(ctx, returnTo);

  return new URL(safeRequestReturnPath(ctx, returnTo), ctx.url.origin).toString();
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

async function fulfillCheckoutPaymentOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  runWorkflowStep: RunPaymentWebhookWorkflowStep,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  checkout?: CheckoutDocument,
): Promise<OrderDocument> {
  await runWorkflowStep("complete_checkout", () =>
    completeCheckoutForPaymentOrder(input, ctx, order, event, checkout),
  );

  return runWorkflowStep("fulfill_order", () => fulfillPaidOrder(input, ctx, order));
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

type RunPaymentWebhookWorkflowStep = <TResult>(
  name: PaymentWebhookWorkflowStep,
  fn: () => Promise<TResult>,
) => Promise<TResult>;

type PaymentWebhookWorkflowStep =
  | "link_checkout"
  | "persist_order"
  | "complete_checkout"
  | "fulfill_order"
  | "mark_webhook";

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

async function updateSubscriptionEntitlement(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
): Promise<SubscriptionDocument> {
  if (subscription.aggregate.sellable.fulfillmentKind !== "entitlement") return subscription;

  const entitlementId =
    subscription.aggregate.entitlementId ??
    fulfillmentDocumentId("entitlement", subscription.id, "subscription");
  const existing = await input.repositories.account.findEntitlementById(entitlementId);
  const status =
    existing?.status === "revoked"
      ? existing.status
      : entitlementStatusForSubscription(subscription.status);
  const record = {
    id: entitlementId,
    customerId: subscription.customerId ?? subscription.aggregate.customer.customerId,
    userId: subscription.aggregate.customer.userId,
    emailHash: subscription.aggregate.customer.emailHash,
    entitlementKey:
      subscription.aggregate.sellable.entitlementKey ??
      subscriptionSellableContentKey(subscription),
    contentCollection: subscription.aggregate.sellable.content.collection,
    contentId: subscription.aggregate.sellable.content.id,
    sellableId: subscription.aggregate.sellable.sellableId,
    subscriptionId: subscription.id,
    status,
    sourceStatus: subscription.status,
    currentPeriodEnd: subscription.aggregate.currentPeriodEnd,
    grantedAt: existing?.record.grantedAt ?? ctx.now,
    metadata: {
      fulfillmentKind: subscription.aggregate.sellable.fulfillmentKind,
      ...(subscription.providerSubscriptionId
        ? { providerSubscriptionId: subscription.providerSubscriptionId }
        : {}),
    },
  };
  const entitlement: EntitlementDocument = {
    id: entitlementId,
    type: "entitlement",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    entitlementKey: record.entitlementKey,
    status: record.status,
    subscriptionId: record.subscriptionId,
    record,
    createdAt: existing?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
  };

  await input.repositories.account.put(entitlement);

  if (subscription.aggregate.entitlementId === entitlementId) return subscription;

  const updated: SubscriptionDocument = {
    ...subscription,
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      entitlementId,
    },
  };
  await input.repositories.account.put(updated);

  return updated;
}

async function emitSubscriptionLifecycleNotification(
  input: CreateMikaBackendApiInput,
  now: ISODateTime,
  subscription: SubscriptionDocument,
  options: {
    readonly created?: boolean;
    readonly previous?: SubscriptionDocument;
    readonly event?: MikaProviderSubscriptionEvent;
  } = {},
): Promise<void> {
  const kind =
    subscription.status === "past_due"
      ? "subscription.renewal_failed"
      : options.created && (subscription.status === "active" || subscription.status === "trialing")
        ? "subscription.started"
        : "subscription.updated";

  await emitBackendNotification(input, kind, now, {
    ...subscriptionNotificationRecipient(subscription),
    subscriptionId: subscription.id,
    status: subscription.status,
    ...(options.previous?.status && options.previous.status !== subscription.status
      ? { previousStatus: options.previous.status }
      : {}),
    provider: subscription.provider,
    ...((subscription.providerCustomerId ?? subscription.aggregate.providerRef.customerId)
      ? {
          providerCustomerId:
            subscription.providerCustomerId ?? subscription.aggregate.providerRef.customerId,
        }
      : {}),
    ...((subscription.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId)
      ? {
          providerSubscriptionId:
            subscription.providerSubscriptionId ??
            subscription.aggregate.providerRef.subscriptionId,
        }
      : {}),
    ...(subscription.aggregate.providerRef.priceId
      ? { providerPriceId: subscription.aggregate.providerRef.priceId }
      : {}),
    ...((subscription.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd)
      ? {
          currentPeriodEnd:
            subscription.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd,
        }
      : {}),
    cancelAtPeriodEnd: subscription.aggregate.cancelAtPeriodEnd,
    sellableId: subscription.aggregate.sellable.sellableId,
    title: subscription.aggregate.sellable.titleSnapshot,
    ...(subscription.aggregate.entitlementId
      ? { entitlementId: subscription.aggregate.entitlementId }
      : {}),
    ...(options.event?.type ? { eventType: options.event.type } : {}),
  });
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

function entitlementStatusForSubscription(
  status: SubscriptionStatus,
): EntitlementDocument["status"] {
  switch (status) {
    case "active":
    case "trialing":
    case "cancel_at_period_end":
    case "past_due":
      return "active";
    case "cancelled":
    case "expired":
      return "expired";
    case "incomplete":
      return "inactive";
  }
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

async function completeCheckoutForPaymentOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  knownCheckout?: CheckoutDocument,
): Promise<void> {
  const checkout = knownCheckout ?? (await findOrderCheckout(input, order, event));
  if (!checkout) return;

  const completedCheckout: CheckoutDocument = {
    ...checkout,
    status: "completed",
    providerStatus: "completed",
    orderId: order.id,
    updatedAt: ctx.now,
    aggregate: {
      ...checkout.aggregate,
      metadata: completedCheckoutMetadata(checkout.aggregate.metadata, order, event),
    },
  };
  await input.repositories.session.put(completedCheckout);

  if (!checkout.cartId) return;

  const document = await input.repositories.session.findById(checkout.cartId);
  if (!document || document.type !== "cart") return;
  if (
    document.status !== "checkout_pending" ||
    metadataMikaId(document.aggregate.metadata, "checkoutSessionId") !== checkout.id
  ) {
    return;
  }

  await input.repositories.session.put({
    ...document,
    status: "converted",
    version: nextCartVersion(document.version),
    updatedAt: ctx.now,
    aggregate: {
      ...document.aggregate,
      metadata: {
        ...document.aggregate.metadata,
        checkoutSessionId: checkout.id,
        checkoutOrderId: order.id,
      },
    },
  });
}

async function findOrderCheckout(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): Promise<CheckoutDocument | null> {
  if (order.checkoutSessionId) {
    const checkout = await input.repositories.session.findCheckoutById(order.checkoutSessionId);
    if (checkout) return checkout;
  }

  const providerCheckoutId = event.providerCheckoutId ?? order.providerCheckoutId;
  if (!providerCheckoutId) return null;

  return input.repositories.session.findCheckoutByProvider(event.provider, providerCheckoutId);
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

function completedCheckoutMetadata(
  metadata: JsonObject | undefined,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): JsonObject {
  return {
    ...metadata,
    checkoutProviderStatus: "completed",
    checkoutOrderId: order.id,
    ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
    ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
  };
}

async function fulfillPaidOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<OrderDocument> {
  const fulfilledLines: OrderLine[] = [];
  const originalLines = order.aggregate.lines;
  let changed = false;

  try {
    for (const line of originalLines) {
      const fulfilled = await fulfillPaidOrderLine(input, ctx, order, line);
      fulfilledLines.push(fulfilled);
      const lineChanged = fulfilled !== line;
      changed = changed || lineChanged;
      if (lineChanged) {
        const progressedLines = [...fulfilledLines, ...originalLines.slice(fulfilledLines.length)];
        await input.repositories.ledger.put(
          orderWithFulfilledLines(order, progressedLines, ctx.now),
        );
      }
    }
  } catch (error) {
    if (changed) {
      const progressedLines = [...fulfilledLines, ...originalLines.slice(fulfilledLines.length)];
      await input.repositories.ledger
        .put(orderWithFulfilledLines(order, progressedLines, ctx.now))
        .catch((persistError: unknown) =>
          observeBackendError(input, "fulfillment.persistProgress", persistError, {
            orderId: order.id,
          }),
        );
    }
    throw error;
  }

  const orderAlreadyMarkedFulfilled = typeof order.aggregate.metadata?.["fulfilledAt"] === "string";

  if (!changed && orderAlreadyMarkedFulfilled) {
    await queueOrderConfirmationEmail(input, ctx, order, fulfilledLines);
    await emitOrderDownloadReadyNotifications(input, ctx, order, originalLines, {
      includeExistingRefs: true,
    });
    return order;
  }

  const fulfilledOrder = orderWithFulfilledLines(
    order,
    fulfilledLines,
    ctx.now,
    orderAlreadyMarkedFulfilled ? undefined : ctx.now,
  );

  await input.repositories.ledger.put(fulfilledOrder);
  await queueOrderConfirmationEmail(input, ctx, fulfilledOrder, fulfilledLines);
  await emitOrderDownloadReadyNotifications(input, ctx, fulfilledOrder, originalLines, {
    includeExistingRefs: !orderAlreadyMarkedFulfilled,
  });

  return fulfilledOrder;
}

function orderWithFulfilledLines(
  order: OrderDocument,
  lines: readonly OrderLine[],
  now: ISODateTime,
  fulfilledAt?: ISODateTime,
): OrderDocument {
  return {
    ...order,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      lines,
      metadata: {
        ...order.aggregate.metadata,
        ...(fulfilledAt ? { fulfilledAt } : {}),
      },
    },
  };
}

async function fulfillPaidOrderLine(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  line: OrderLine,
): Promise<OrderLine> {
  const stockMovementId = await consumeOrderLineReservation(input, ctx, order, line);
  let fulfilledLine: OrderLine =
    stockMovementId && line.stockMovementId !== stockMovementId
      ? { ...line, stockMovementId }
      : line;

  switch (line.item.fulfillmentKind) {
    case "none":
    case "external":
      return fulfilledLine;
    case "entitlement": {
      const entitlement = createOrderLineEntitlementDocument(order, line, ctx.now);
      const existing = await input.repositories.account.findEntitlementById(entitlement.id);
      if (!existing) await input.repositories.account.put(entitlement);
      return fulfilledLine.entitlementId === entitlement.id
        ? fulfilledLine
        : { ...fulfilledLine, entitlementId: entitlement.id };
    }
    case "download": {
      const downloadRef = orderLineDownloadRef(order, line);
      return fulfilledLine.downloadRefs?.includes(downloadRef)
        ? fulfilledLine
        : { ...fulfilledLine, downloadRefs: [...(fulfilledLine.downloadRefs ?? []), downloadRef] };
    }
    case "license": {
      const license = await createOrderLineLicenseDocument(input, order, line, ctx.now);
      const existing = await input.repositories.account.findLicenseById(license.id);
      if (!existing) await input.repositories.account.put(license);
      await emitFulfillmentNotificationOnce(
        input,
        ctx,
        {
          id: fulfillmentDocumentId("workflow", order.id, line.id, "notification_license_issued"),
          kind: "license.issued",
          subjectType: "orderLine",
          subjectId: line.id,
          idempotencyKey: `license.issued:${order.id}:${line.id}`,
        },
        {
          ...orderNotificationRecipient(order),
          ...(license.customerId ? { customerId: license.customerId } : {}),
          licenseId: license.id,
          orderId: order.id,
          orderLineId: line.id,
          ...(license.record.entitlementId ? { entitlementId: license.record.entitlementId } : {}),
          displayKeySuffix: license.record.displayKeySuffix,
          sellableId: line.item.sellableId,
          fulfillmentKind: line.item.fulfillmentKind,
        },
      );
      return fulfilledLine.licenseKeySuffix === license.record.displayKeySuffix
        ? fulfilledLine
        : { ...fulfilledLine, licenseKeySuffix: license.record.displayKeySuffix };
    }
  }
}

async function consumeOrderLineReservation(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  line: OrderLine,
): Promise<MikaId | undefined> {
  const reservationId = metadataMikaId(line.metadata, "reservationId");
  if (!reservationId) return line.stockMovementId;
  if (line.stockMovementId === reservationId) return line.stockMovementId;

  const result = await createMikaStockLifecycleService(input).consume({
    reservationEventId: reservationId,
    now: ctx.now,
    orderId: order.id,
    orderLineId: line.id,
  });

  if (result.status === "consumed") return result.event.id;
  if (result.status === "not_active" && result.event.status === "consumed") return result.event.id;

  throw new Error(`Reservation '${reservationId}' for order line '${line.id}' was not active.`);
}

function createOrderLineEntitlementDocument(
  order: OrderDocument,
  line: OrderLine,
  now: ISODateTime,
): EntitlementDocument {
  const id = fulfillmentDocumentId("entitlement", order.id, line.id);
  const entitlementKey = line.item.entitlementKey ?? orderLineContentKey(line);
  const record = {
    id,
    customerId: order.customerId ?? order.aggregate.customer.customerId,
    userId: order.aggregate.customer.userId,
    emailHash: order.aggregate.customer.emailHash,
    entitlementKey,
    contentCollection: line.item.content.collection,
    contentId: line.item.content.id,
    sellableId: line.item.sellableId,
    orderId: order.id,
    status: "active" as const,
    sourceStatus: order.status,
    grantedAt: now,
    metadata: {
      orderLineId: line.id,
      fulfillmentKind: line.item.fulfillmentKind,
    },
  };

  return {
    id,
    type: "entitlement",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    entitlementKey: record.entitlementKey,
    status: record.status,
    orderId: record.orderId,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

async function createOrderLineLicenseDocument(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  line: OrderLine,
  now: ISODateTime,
): Promise<LicenseDocument> {
  const id = fulfillmentDocumentId("license", order.id, line.id);
  const licenseKeyHash = await input.hash(`license:${order.id}:${line.id}`);
  const displayKeySuffix = licenseKeyHash
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-6)
    .toUpperCase();
  const record = {
    id,
    orderId: order.id,
    orderLineId: line.id,
    entitlementId: line.entitlementId,
    licenseKeyHash,
    displayKeySuffix,
    status: "active" as const,
    createdAt: now,
    metadata: {
      fulfillmentKind: line.item.fulfillmentKind,
      sellableId: line.item.sellableId,
    },
  };

  return {
    id,
    type: "license",
    schemaVersion: 1,
    orderId: record.orderId,
    orderLineId: record.orderLineId,
    entitlementId: record.entitlementId,
    status: record.status,
    customerId: order.customerId ?? order.aggregate.customer.customerId,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

async function queueOrderConfirmationEmail(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  lines: readonly OrderLine[],
): Promise<void> {
  const recipient = orderNotificationRecipient(order);
  const toEmail = recipient.toEmail?.trim();
  if (!toEmail) return;

  const notificationMarkerId = orderConfirmedNotificationMarkerId(order.id);
  const defaultEmailId = fulfillmentDocumentId("email", order.id, "order_confirmation");
  const markerLease = await acquireNotificationMarker(input, ctx, {
    id: notificationMarkerId,
    kind: "order.confirmed",
    subjectType: "order",
    subjectId: order.id,
    idempotencyKey: `order.confirmed:${order.id}`,
    metadata: {
      defaultEmailId,
    },
  });
  if (markerLease.status !== "acquired") return;

  try {
    const existingDefaultEmail = await input.repositories.ops.findEmail(defaultEmailId);
    if (existingDefaultEmail) {
      await markerLease.runner.complete({
        notificationKind: "order.confirmed",
        defaultEmailId,
        defaultEmailAlreadyQueued: true,
      });
      return;
    }

    const fulfillmentKinds = [...new Set(lines.map((line) => line.item.fulfillmentKind))];
    const context: MikaOrderConfirmedNotificationContext = {
      ...recipient,
      toEmail,
      orderId: order.id,
      orderNumber: order.orderNumber,
      ...(order.provider ? { provider: order.provider } : {}),
      ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
      ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
      ...(order.checkoutSessionId ? { checkoutSessionId: order.checkoutSessionId } : {}),
      subtotal: order.aggregate.totals.subtotal,
      ...(order.aggregate.totals.discount ? { discount: order.aggregate.totals.discount } : {}),
      total: order.aggregate.totals.total,
      fulfilledLines: lines.map((line) => ({
        lineId: line.id,
        sellableId: line.item.sellableId,
        ...(line.item.priceId ? { priceId: line.item.priceId } : {}),
        ...(line.item.sku ? { sku: line.item.sku } : {}),
        title: line.item.titleSnapshot,
        quantity: line.quantity,
        total: { amount: line.totalAmount, currency: line.item.currency },
        fulfillmentKind: line.item.fulfillmentKind,
        ...(line.entitlementId ? { entitlementId: line.entitlementId } : {}),
        ...(line.downloadRefs ? { downloadRefs: line.downloadRefs } : {}),
        ...(line.licenseKeySuffix ? { licenseKeySuffix: line.licenseKeySuffix } : {}),
        ...(line.stockMovementId ? { stockMovementId: line.stockMovementId } : {}),
        ...(line.metadata ? { metadata: line.metadata } : {}),
      })),
      fulfillmentKinds,
    };
    const intent: MikaNotificationIntent<"order.confirmed"> = {
      kind: "order.confirmed",
      occurredAt: ctx.now,
      context,
    };

    await emitMikaNotification(
      input.notifications?.handle,
      intent,
      () => queueDefaultOrderConfirmedEmail(input, intent, defaultEmailId),
      (error) => observeBackendError(input, "notification.hook.order.confirmed", error),
    );
    await markerLease.runner.complete({
      notificationKind: "order.confirmed",
      defaultEmailId,
    });
  } catch (error) {
    await markerLease.runner.fail(
      error instanceof Error ? error.message : "Order-confirmation notification failed.",
    );
    throw error;
  }
}

async function queueDefaultOrderConfirmedEmail(
  input: CreateMikaBackendApiInput,
  intent: MikaNotificationIntent<"order.confirmed">,
  emailId?: MikaId,
): Promise<void> {
  const { context } = intent;
  const id = emailId ?? fulfillmentDocumentId("email", context.orderId, "order_confirmation");
  const existing = await input.repositories.ops.findEmail(id);
  if (existing) return;

  const rendered = renderMikaEmail("order_confirmation", {
    toEmail: context.toEmail,
    orderNumber: context.orderNumber,
    subtotal: context.subtotal,
    ...(context.discount ? { discount: context.discount } : {}),
    total: context.total,
    lines: context.fulfilledLines.map((line) => ({
      title: line.title,
      quantity: line.quantity,
      total: line.total,
    })),
  });
  const record = {
    id,
    customerId: context.customerId,
    orderId: context.orderId,
    kind: "order_confirmation" as const,
    toEmail: context.toEmail,
    subject: rendered.subject,
    status: "queued" as const,
    idempotencyKey: `order-confirmation:${context.orderId}`,
    templateKey: rendered.template,
    templateVersion: "1",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: intent.occurredAt,
    createdAt: intent.occurredAt,
    metadata: {
      orderLineIds: context.fulfilledLines.map((line) => line.lineId),
      fulfillmentKinds: [...context.fulfillmentKinds],
      ...(context.emailHash ? { emailHash: context.emailHash } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
    },
  };
  const document: EmailDocument = {
    id,
    type: "email",
    schemaVersion: 1,
    status: record.status,
    nextAttemptAt: record.nextAttemptAt,
    orderId: record.orderId,
    kind: record.kind,
    record,
    createdAt: intent.occurredAt,
    updatedAt: intent.occurredAt,
  };

  await input.repositories.ops.put(document);
}

async function emitOrderDownloadReadyNotifications(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  originalLines: readonly OrderLine[],
  options: { readonly includeExistingRefs?: boolean } = {},
): Promise<void> {
  const originalById = new Map(originalLines.map((line) => [line.id, line]));

  for (const line of order.aggregate.lines) {
    const originalRefs = new Set(originalById.get(line.id)?.downloadRefs ?? []);
    const addedRefs = options.includeExistingRefs
      ? (line.downloadRefs ?? [])
      : (line.downloadRefs ?? []).filter((downloadRef) => !originalRefs.has(downloadRef));

    for (const downloadRef of addedRefs) {
      await emitFulfillmentNotificationOnce(
        input,
        ctx,
        {
          id: fulfillmentDocumentId("workflow", downloadRef, "notification_download_ready"),
          kind: "download.ready",
          subjectType: "orderDownload",
          subjectId: createMikaId(downloadRef),
          idempotencyKey: `download.ready:${downloadRef}`,
        },
        {
          ...orderNotificationRecipient(order),
          downloadRef,
          orderId: order.id,
          orderLineId: line.id,
          title: line.item.titleSnapshot,
        },
      );
    }
  }
}

function orderLineDownloadRef(order: OrderDocument, line: OrderLine): string {
  return `download:${order.id}:${line.id}`;
}

function orderConfirmedNotificationMarkerId(orderId: MikaId): MikaId {
  return fulfillmentDocumentId("workflow", orderId, "notification_order_confirmed");
}

type NotificationMarkerLease =
  | {
      readonly status: "acquired";
      readonly runner: WorkflowRunner<never>;
    }
  | {
      readonly status: "active" | "completed";
    };

async function acquireNotificationMarker(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  marker: {
    readonly id: MikaId;
    readonly kind: MikaNotificationKind;
    readonly subjectType: string;
    readonly subjectId: MikaId;
    readonly idempotencyKey: string;
    readonly metadata?: JsonObject;
  },
): Promise<NotificationMarkerLease> {
  const existing = await input.repositories.ops.findWorkflow(marker.id);
  if (existing?.status === "completed") return { status: "completed" };

  const workflowKind = `notification.${marker.kind}` as WorkflowDocument["kind"];
  if (!existing) {
    await input.repositories.ops.createWorkflow({
      id: marker.id,
      type: "workflow",
      schemaVersion: 1,
      kind: workflowKind,
      status: "queued",
      subjectType: marker.subjectType,
      subjectId: marker.subjectId,
      idempotencyKey: marker.idempotencyKey,
      nextAttemptAt: ctx.now,
      record: {
        id: marker.id,
        kind: workflowKind,
        status: "queued",
        subjectType: marker.subjectType,
        subjectId: marker.subjectId,
        idempotencyKey: marker.idempotencyKey,
        attemptCount: 0,
        maxAttempts: 5,
        nextAttemptAt: ctx.now,
        steps: [],
        createdAt: ctx.now,
        updatedAt: ctx.now,
        metadata: {
          notificationKind: marker.kind,
          ...marker.metadata,
        },
      },
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  }

  const leased = await input.repositories.ops.tryLeaseWorkflow({
    workflowId: marker.id,
    leaseKey: `notification:${marker.id}:${ctx.now}`,
    now: ctx.now,
    leaseExpiresAt: addMilliseconds(ctx.now, 300_000),
  });
  if (!leased) return { status: "active" };

  return {
    status: "acquired",
    runner: new WorkflowRunner<never>({
      ops: input.repositories.ops,
      workflow: leased,
      now: () => ctx.now,
      nextAttemptAt: (now) => now,
      stepFailureMessage: "Notification hook failed.",
    }),
  };
}

async function emitFulfillmentNotificationOnce<TKind extends MikaNotificationKind>(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  marker: {
    readonly id: MikaId;
    readonly kind: TKind;
    readonly subjectType: string;
    readonly subjectId: MikaId;
    readonly idempotencyKey: string;
  },
  context: MikaNotificationContextMap[TKind],
): Promise<void> {
  const lease = await acquireNotificationMarker(input, ctx, {
    id: marker.id,
    kind: marker.kind,
    subjectType: marker.subjectType,
    subjectId: marker.subjectId,
    idempotencyKey: marker.idempotencyKey,
  });
  if (lease.status !== "acquired") return;

  try {
    await emitBackendNotification(input, marker.kind, ctx.now, context);
    await lease.runner.complete({
      notificationKind: marker.kind,
      idempotencyKey: marker.idempotencyKey,
    });
  } catch (error) {
    await lease.runner.fail(
      error instanceof Error ? error.message : "Fulfillment notification hook failed.",
    );
    throw error;
  }
}

function orderLineContentKey(line: OrderLine): string {
  return `${line.item.content.collection}:${line.item.content.id}`;
}

function subscriptionSellableContentKey(subscription: SubscriptionDocument): string {
  const content = subscription.aggregate.sellable.content;
  return `${content.collection}:${content.id}`;
}

function fulfillmentDocumentId(namespace: string, ...parts: readonly string[]): MikaId {
  return createMikaId([namespace, ...parts].map(fulfillmentIdPart).join("_"));
}

function fulfillmentIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "value";
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

async function findOrCreateActiveWishlist(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
): Promise<WishlistDocument> {
  const existing = await findActiveWishlist(input, ctx);
  if (existing) return existing;

  const wishlist = createWishlistDocument(input, ctx);
  await input.repositories.session.put(wishlist);

  return wishlist;
}

async function findActiveWishlist(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
): Promise<WishlistDocument | null> {
  if (ctx.customerId) {
    return input.repositories.session.findWishlistByCustomer(ctx.customerId);
  }

  return ctx.sessionId ? input.repositories.session.findWishlistBySession(ctx.sessionId) : null;
}

async function findOwnedActiveWishlistById(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  wishlistId: MikaId,
): Promise<{ readonly ok: true; readonly wishlist: WishlistDocument } | MikaApiFailure> {
  const document = await input.repositories.session.findById(wishlistId);
  if (!document || document.type !== "wishlist" || document.status !== "active") {
    return invalidWishlist("targetWishlistId", wishlistId);
  }

  if (!callerOwnsMergeSource(ctx, document)) {
    return invalidWishlist("targetWishlistId", wishlistId);
  }

  return { ok: true, wishlist: document };
}

function createWishlistDocument(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
): WishlistDocument {
  const now = ctx.now;

  return {
    id: input.createId("wishlist"),
    type: "wishlist",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    customerId: ctx.customerId,
    userId: ctx.userId,
    status: "active",
    expiresAt: input.config?.wishlist?.ttlMs
      ? createISODateTime(
          new Date(new Date(now).getTime() + input.config.wishlist.ttlMs).toISOString(),
        )
      : undefined,
    aggregate: createWishlistAggregate(),
    createdAt: now,
    updatedAt: now,
  };
}

function updateWishlistDocument(
  wishlist: WishlistDocument,
  items: readonly WishlistItem[],
  updatedAt: ISODateTime,
): WishlistDocument {
  return {
    ...wishlist,
    updatedAt,
    aggregate: createWishlistAggregate({
      items,
      metadata: wishlist.aggregate.metadata,
    }),
  };
}

async function findOrCreateOpenCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
): Promise<CartDocument> {
  const currency = defaultBackendCurrency(input);
  const existing = await findOpenCart(input, ctx, currency);
  if (existing) return existing;

  const cart = createCartDocument(input, ctx, currency);
  await input.repositories.session.put(cart);

  return cart;
}

function cartWriteBlocked(cart: CartDocument): MikaApiFailure | null {
  if (cart.status === "open") return null;

  return apiFailure(409, "CONFLICT", `Cart '${cart.id}' is locked by an active checkout.`, {
    cartId: "Cart is locked by an active checkout.",
  });
}

/**
 * Attempts an optimistic-concurrency cart write and reports a conflict when another writer
 * (a concurrent tab, or a checkout claim) already changed the cart since it was read, instead of
 * blindly overwriting — and silently discarding — that concurrent write.
 */
async function putCartOrConflict(
  input: MikaCartWishlistBackendInput,
  cart: CartDocument,
  expectedVersion: number | undefined,
): Promise<{ readonly ok: true; readonly cart: CartDocument } | MikaApiFailure> {
  const persisted = await input.repositories.session.putCartIfUnchanged(cart, expectedVersion);
  if (!persisted) {
    return apiFailure(409, "CONFLICT", `Cart '${cart.id}' was changed by another request.`, {
      cartId: "Cart was changed by another request. Reload the cart and try again.",
    });
  }

  return { ok: true, cart: persisted };
}

/**
 * Marks the merge source cart abandoned now that its lines have been merged into `target`.
 * Retries the merge once against the source's latest state if it changed concurrently (e.g. a
 * `cart.add` landed on it) after being read for the merge that produced `target` — otherwise that
 * concurrent write would be silently stranded on a cart the caller may never revisit (e.g. after
 * login regenerates the session id the guest cart was keyed by). Returns the target cart that
 * reflects whatever actually got merged, so the caller's response isn't stale after a retry.
 * Best-effort beyond one retry: if the source keeps changing, it's left open (not force-abandoned,
 * which would discard whatever it still holds) and the caller can merge it again later.
 */
async function abandonMergedSourceCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  source: CartDocument,
  target: CartDocument,
): Promise<CartDocument> {
  const abandoned: CartDocument = {
    ...source,
    status: "abandoned",
    updatedAt: ctx.now,
    version: nextCartVersion(source.version),
  };
  const released = await input.repositories.session.putCartIfUnchanged(abandoned, source.version);
  if (released) return target;

  const latestSource = await input.repositories.session.findById(source.id);
  if (!latestSource || latestSource.type !== "cart" || latestSource.status !== "open") {
    return target;
  }

  // Reconcile every line source had against what changed since the first pass never saw —
  // re-merging latestSource wholesale would double-count every line source already had at the
  // original read (mergeCartLines has no way to tell "already merged" apart from "new" once both
  // sides are full carts). A line entirely new since the original read is merged at its full
  // quantity; a line that was already merged but whose quantity grew concurrently (e.g. a racing
  // cart.update bumping it) is merged at only the increase, since its original quantity is already
  // reflected in target. Symmetrically, a line whose quantity shrank (or that was removed
  // entirely) concurrently must have that decrease applied against target too — leaving target at
  // the stale, too-high quantity isn't "nothing to recover", it's target silently disagreeing with
  // what the customer actually asked for, and once this retry succeeds source is marked
  // "abandoned" (terminal — nothing resurrects it), so the correct lower quantity would be lost for
  // good rather than just deferred to "merge again later".
  const originalLinesById = new Map(source.aggregate.items.map((line) => [line.id, line]));
  const latestLinesById = new Map(latestSource.aggregate.items.map((line) => [line.id, line]));
  const increasedOrNewLines = latestSource.aggregate.items.flatMap((line) => {
    const original = originalLinesById.get(line.id);
    if (!original) return [line];
    if (line.quantity > original.quantity) {
      return [{ ...line, quantity: line.quantity - original.quantity }];
    }
    return [];
  });
  const decreasedOrRemovedLines = source.aggregate.items.flatMap((originalLine) => {
    const latestQuantity = latestLinesById.get(originalLine.id)?.quantity ?? 0;

    return latestQuantity < originalLine.quantity
      ? [{ line: originalLine, decreaseBy: originalLine.quantity - latestQuantity }]
      : [];
  });
  if (increasedOrNewLines.length === 0 && decreasedOrRemovedLines.length === 0) return target;

  // Decreases must land on target's items *before* increases are validated: mergeCartLines checks
  // a new/grown line's sibling-quantity demand against target's other same-sellable lines, and
  // those siblings must already reflect any concurrent decrease — otherwise validation sees a
  // stale, too-high sibling quantity, can spuriously reject a combination that's actually within
  // limits, and drops the entire retry (both the legitimate decrease and the legitimate increase)
  // with no self-correction: a later merge attempt still sees target's stale contribution and
  // fails the same way forever.
  const decreasedItems = decreasedOrRemovedLines.reduce(
    (items, { line, decreaseBy }) => applyCartLineQuantityDelta(items, line, -decreaseBy),
    target.aggregate.items,
  );

  const retryMerged =
    increasedOrNewLines.length > 0
      ? await mergeCartLines(
          input,
          { ...target, aggregate: { ...target.aggregate, items: decreasedItems } },
          { ...latestSource, aggregate: { ...latestSource.aggregate, items: increasedOrNewLines } },
        )
      : { ok: true as const, items: decreasedItems };
  if (!retryMerged.ok) return target;

  const retryUpdated = updateCartDocument(
    target,
    retryMerged.items,
    ctx.now,
    target.aggregate.coupon ?? latestSource.aggregate.coupon,
  );
  const retryPersisted = await input.repositories.session.putCartIfUnchanged(
    retryUpdated,
    target.version,
  );
  if (!retryPersisted) return target;

  const retryAbandoned: CartDocument = {
    ...latestSource,
    status: "abandoned",
    updatedAt: ctx.now,
    version: nextCartVersion(latestSource.version),
  };
  await input.repositories.session.putCartIfUnchanged(retryAbandoned, latestSource.version);

  return retryPersisted;
}

/**
 * Applies `quantityDelta` (negative to decrease) to the item in `items` equivalent to `line`,
 * removing it entirely if the result drops to zero or below. A no-op if no equivalent line exists
 * (nothing to decrease).
 */
function applyCartLineQuantityDelta(
  items: readonly CartLine[],
  line: CartLine,
  quantityDelta: number,
): readonly CartLine[] {
  const existingIndex = items.findIndex((candidate) => isEquivalentCartLine(candidate, line));
  if (existingIndex === -1) return items;

  const nextQuantity = items[existingIndex]!.quantity + quantityDelta;
  if (nextQuantity <= 0) {
    return items.filter((_, index) => index !== existingIndex);
  }

  return items.map((candidate, index) =>
    index === existingIndex ? { ...candidate, quantity: nextQuantity } : candidate,
  );
}

/** Merges `line` into `currentItems` (combining quantities for an equivalent existing line). */
function mergeCartAddLine(
  currentItems: readonly CartLine[],
  line: CartLine,
  resolved: { readonly sellable: SellableDefinition; readonly stock: StockItemRecord | null },
): { readonly ok: true; readonly items: readonly CartLine[] } | MikaApiFailure {
  const existingLine = currentItems.find((candidate) => isEquivalentCartLine(candidate, line));
  const nextQuantity = (existingLine?.quantity ?? 0) + line.quantity;
  const sellableDemand = nextQuantity + siblingSellableQuantity(currentItems, line);
  const quantityError = validateQuantityLimit(resolved.sellable, resolved.stock, sellableDemand);
  if (quantityError) return quantityError;

  const items = existingLine
    ? currentItems.map((candidate) =>
        candidate.id === existingLine.id ? { ...candidate, quantity: nextQuantity } : candidate,
      )
    : [...currentItems, line];

  return { ok: true, items };
}

/**
 * Creates a brand-new open cart with `line`, serialized against concurrent creates for the same
 * identity+currency via a short-lived lock. Without this, two simultaneous first-add requests
 * (e.g. a double click before any cart exists) would each find no existing cart via `findOpenCart`
 * and blind-`put` a separate document — the loser's cart becomes invisible to subsequent reads
 * (which only ever return one open cart per identity+currency), silently discarding its line.
 */
async function createCartWithFirstLine(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
  line: CartLine,
  resolved: { readonly sellable: SellableDefinition; readonly stock: StockItemRecord | null },
): Promise<MikaApiResult<CartDTO>> {
  const lockIdentity = ctx.customerId ?? ctx.sessionId;
  if (!lockIdentity) {
    const document = updateCartDocument(createCartDocument(input, ctx, currency), [line], ctx.now);
    await input.repositories.session.put(document);

    return { ok: true, status: 200, data: await cartDocumentToDTO(input, document) };
  }

  const lockKey = `cart-create-lock:${await input.hash(`${lockIdentity}:${currency}`)}`;
  const owner = input.createId("cart_create_lock_owner");
  const lock = await input.repositories.ephemeral.tryAcquireLock({
    key: lockKey,
    owner,
    expiresAt: addMilliseconds(ctx.now, 30_000),
    now: ctx.now,
  });
  if (!lock) {
    // Someone else is creating the first cart for this identity+currency right now — join it
    // instead of racing a second document into existence.
    const winner = await findOpenCart(input, ctx, currency);
    if (!winner) {
      return apiFailure(409, "CONFLICT", "Cart is being created by another request.", {
        cartId: "Cart is being created by another request. Reload the cart and try again.",
      });
    }
    const writeBlocked = cartWriteBlocked(winner);
    if (writeBlocked) return writeBlocked;

    const merged = mergeCartAddLine(winner.aggregate.items, line, resolved);
    if (!merged.ok) return merged;

    const updated = updateCartDocument(winner, merged.items, ctx.now);
    const persisted = await putCartOrConflict(input, updated, winner.version);
    if (!persisted.ok) return persisted;

    return { ok: true, status: 200, data: await cartDocumentToDTO(input, persisted.cart) };
  }

  try {
    const document = updateCartDocument(createCartDocument(input, ctx, currency), [line], ctx.now);
    await input.repositories.session.put(document);

    return { ok: true, status: 200, data: await cartDocumentToDTO(input, document) };
  } finally {
    await input.repositories.ephemeral
      .releaseLock({ key: lockKey, owner, now: ctx.now })
      .catch((error: unknown) =>
        observeBackendError(input, "cart.createLock.release", error, { lockKey }),
      );
  }
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

function safeRequestReturnPath(
  ctx: MikaRequestContext,
  candidate?: string,
  fallback = ctx.url ? `${ctx.url.pathname}${ctx.url.search}${ctx.url.hash}` : "/",
): string {
  return mikaSafeReturnPath(candidate ?? fallback, {
    origin: ctx.url,
    fallback,
  });
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

async function findOpenCartBySessionAnyCurrency(
  input: MikaCartWishlistBackendInput,
  sessionId: string,
): Promise<CartDocument | null> {
  return findSessionRepositoryOpenCartBySessionAnyCurrency(input.repositories.session, sessionId);
}

function createCartDocument(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
): CartDocument {
  const now = ctx.now;

  return {
    id: input.createId("cart"),
    type: "cart",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    customerId: ctx.customerId,
    userId: ctx.userId,
    status: "open",
    currency,
    expiresAt: input.config?.cart?.ttlMs
      ? createISODateTime(new Date(new Date(now).getTime() + input.config.cart.ttlMs).toISOString())
      : undefined,
    version: 1,
    aggregate: createCartAggregate({ currency }),
    createdAt: now,
    updatedAt: now,
  };
}

async function findOwnedOpenCartById(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  cartId: MikaId,
  field: string,
): Promise<{ readonly ok: true; readonly cart: CartDocument } | MikaApiFailure> {
  const document = await input.repositories.session.findById(cartId);
  if (!document || document.type !== "cart" || document.status !== "open") {
    return invalidCart(field, cartId);
  }

  if (!callerOwnsMergeSource(ctx, document)) {
    return invalidCart(field, cartId);
  }

  return { ok: true, cart: document };
}

async function mergeCartLines(
  input: MikaCartWishlistBackendInput,
  target: CartDocument,
  source: CartDocument,
): Promise<{ readonly ok: true; readonly items: readonly CartLine[] } | MikaApiFailure> {
  const items = [...target.aggregate.items];

  for (const sourceLine of source.aggregate.items) {
    if (sourceLine.item.currency !== target.aggregate.currency) {
      return validationFailed(
        "sourceSessionId",
        `Source line '${sourceLine.id}' uses currency '${sourceLine.item.currency}'.`,
      );
    }

    const existingLine = items.find((line) => isEquivalentCartLine(line, sourceLine));
    const nextQuantity = (existingLine?.quantity ?? 0) + sourceLine.quantity;
    const quantityError = await validateExistingLineQuantity(
      input,
      sourceLine,
      nextQuantity + siblingSellableQuantity(items, sourceLine),
    );
    if (quantityError) return quantityError;

    if (existingLine) {
      const existingIndex = items.findIndex((line) => line.id === existingLine.id);
      items[existingIndex] = { ...existingLine, quantity: nextQuantity };
    } else {
      items.push(sourceLine);
    }
  }

  return { ok: true, items };
}

async function mergeCartLine(
  input: MikaCartWishlistBackendInput,
  currentItems: readonly CartLine[],
  nextLine: CartLine,
): Promise<{ readonly ok: true; readonly items: readonly CartLine[] } | MikaApiFailure> {
  const items = [...currentItems];
  const existingLine = items.find((line) => isEquivalentCartLine(line, nextLine));
  const nextQuantity = (existingLine?.quantity ?? 0) + nextLine.quantity;
  const quantityError = await validateExistingLineQuantity(
    input,
    nextLine,
    nextQuantity + siblingSellableQuantity(items, nextLine),
  );
  if (quantityError) return quantityError;

  if (!existingLine) {
    return { ok: true, items: [...items, nextLine] };
  }

  return {
    ok: true,
    items: items.map((line) =>
      line.id === existingLine.id ? { ...line, quantity: nextQuantity } : line,
    ),
  };
}

function mergeWishlistItems(
  targetItems: readonly WishlistItem[],
  sourceItems: readonly WishlistItem[],
): readonly WishlistItem[] {
  const items = [...targetItems];

  for (const sourceItem of sourceItems) {
    if (!items.some((item) => isEquivalentWishlistItem(item, sourceItem))) {
      items.push(sourceItem);
    }
  }

  return items;
}

async function validateExistingLineQuantity(
  input: MikaCartWishlistBackendInput,
  line: CartLine,
  quantity: number,
): Promise<MikaApiFailure | null> {
  const catalog = await input.repositories.catalog.findItemBySellableId(line.item.sellableId);
  const sellable = catalog?.aggregate.sellables.find((item) => item.id === line.item.sellableId);
  if (!sellable) return sellableNotFound(line.item.sellableId);

  const stock = await input.repositories.stock.findBySellableId(line.item.sellableId);
  return validateQuantityLimit(sellable, stock, quantity);
}

function adminStockAdjustmentResult(
  result: Extract<AdjustStockRepositoryResult, { readonly status: "adjusted" | "replayed" }>,
): AdminActionResultDTO {
  const applied = result.status === "adjusted";

  return {
    id: result.event.id,
    status: "completed",
    ...(applied ? {} : { message: "Stock adjustment idempotency key was replayed." }),
    affected: {
      stockItems: applied ? 1 : 0,
      movements: applied ? 1 : 0,
    },
  };
}

function updateOrderAfterRefund(
  order: OrderDocument,
  refundInput: OrderRefundInput,
  now: ISODateTime,
): OrderDocument {
  return applyOrderRefund(order, refundInput, now);
}

function updateOrderAfterCancel(
  order: OrderDocument,
  cancelInput: OrderCancelInput,
  now: ISODateTime,
): OrderDocument {
  return applyOrderCancel(order, cancelInput, now);
}
