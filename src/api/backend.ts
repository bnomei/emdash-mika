import type {
  MikaProviderLineItem,
  MikaProviderPaymentEvent,
  MikaProviderOrderCancelInput,
  MikaProviderRegistry,
  MikaProviderRefundInput,
  MikaProviderSubscriptionActionInput,
  MikaProviderSubscriptionEvent,
  MikaProviderWebhookEvent,
  MikaVerifiedWebhookPayload,
} from "../provider";
import type {
  AdjustStockRepositoryResult,
  ConsumeReservedStockRepositoryResult,
  MikaRepositories,
  ReleaseExpiredReservationsRepositoryResult,
  ReleaseReservedStockRepositoryResult,
  ReserveStockRepositoryResult,
} from "../storage/repositories";
import {
  cartToDTO,
  cartWithItems,
  cartWithCoupon,
  cartWithoutCoupon,
  catalogSellablesToDTO,
  createCartAggregate,
  createCheckoutAggregate,
  createOrderAggregate,
  createSubscriptionAggregate,
  createWishlistAggregate,
  orderLineFromCheckoutLine,
  snapshotPrice,
  stockAvailabilityToDTO,
  wishlistToDTO,
} from "../model/builders";
import { renderMikaEmail } from "../email";
import { mikaPluginRoute } from "./routes";
import type {
  CartLine,
  CheckoutLine,
  CouponSnapshot,
  CustomerSnapshot,
  OrderLine,
  PriceDefinition,
  SellableDefinition,
  WishlistItem,
} from "../types/aggregates";
import type {
  CartDocument,
  CheckoutDocument,
  AccountDeleteRequestDocument,
  AccountExportDocument,
  AdminAuditDocument,
  CustomerDocument,
  EmailDocument,
  EntitlementDocument,
  LicenseDocument,
  OrderDocument,
  SessionDocument,
  SubscriptionDocument,
  WebhookDocument,
  WishlistDocument,
} from "../types/documents";
import { createCurrencyCode, createISODateTime, createMikaId } from "../types/primitives";
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
import { createMikaApi, type MikaApi, type MikaApiOverrides } from "./server";
import type {
  AddCartItemInput,
  AccountDTO,
  AccountExportDTO,
  AccountExportDownloadDTO,
  AdminActionResultDTO,
  CartDTO,
  CartQuoteDTO,
  CartQuoteInput,
  CartQuoteLineDTO,
  CheckoutPreviewDTO,
  CheckoutPreviewInput,
  CheckoutSessionDTO,
  MikaError,
  MikaApiResult,
  MoneyDTO,
  DownloadDTO,
  DownloadIssueInput,
  DownloadResolutionDTO,
  EntitlementDTO,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  EmailResendInput,
  LicenseRevokeInput,
  OrderCancelInput,
  OrderRefundInput,
  OrderSummaryDTO,
  ProviderHealthDTO,
  ProviderHealthInput,
  ProviderSyncInput,
  StartCheckoutInput,
  StockAdjustInput,
  SubscriptionDTO,
  WishlistDTO,
  WishlistItemInput,
  WebhookReceiveDTO,
  WebhookReceiveInput,
  WebhookReplayInput,
} from "./types";

type MikaApiFailure = Extract<MikaApiResult<never>, { readonly ok: false }>;

const DEFAULT_BACKEND_CURRENCY = createCurrencyCode("EUR");
const CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "checkoutIdempotencyInputHash";
const CHECKOUT_INTERNAL_METADATA_KEYS = new Set<string>([
  "checkoutIdempotencyKey",
  CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY,
  "checkoutProviderStatus",
  "checkoutRedirectUrl",
  "checkoutPersistenceFailed",
  "checkoutOrderId",
]);

function defaultBackendCurrency(input: { readonly defaults?: MikaBackendDefaults }): CurrencyCode {
  return input.defaults?.currency ?? DEFAULT_BACKEND_CURRENCY;
}

type PublicContract<TValue> = Pick<TValue, keyof TValue>;

export type MikaBackendRepositories = {
  readonly [K in keyof MikaRepositories]: PublicContract<MikaRepositories[K]>;
};

export type MikaBackendNow = () => Date;
export type MikaBackendISODateTime = () => ISODateTime;
export type MikaBackendIdFactory = (namespace: string) => MikaId;
export type MikaBackendHashInput = string | Uint8Array;
export type MikaBackendHashHelper = (input: MikaBackendHashInput) => Promise<string> | string;

export interface MikaBackendDefaults {
  readonly currency?: CurrencyCode;
  readonly locale?: string;
  readonly provider?: ProviderName;
}

export interface MikaBackendConfig {
  readonly accountExport?: {
    readonly ttlMs?: number;
  };
  readonly cart?: {
    readonly ttlMs?: number;
  };
  readonly checkout?: {
    readonly cancelUrl?: string;
    readonly successUrl?: string;
    readonly ttlMs?: number;
  };
  readonly download?: {
    readonly tokenTtlMs?: number;
  };
  readonly magicLink?: {
    readonly ttlMs?: number;
  };
  readonly metadata?: JsonObject;
  readonly wishlist?: {
    readonly ttlMs?: number;
  };
}

export interface MikaBackendDependencies {
  readonly config?: MikaBackendConfig;
  readonly createId: MikaBackendIdFactory;
  readonly defaults?: MikaBackendDefaults;
  readonly hash: MikaBackendHashHelper;
  readonly isoNow?: MikaBackendISODateTime;
  readonly now: MikaBackendNow;
  readonly providers: MikaProviderRegistry;
  readonly repositories: MikaBackendRepositories;
}

export interface CreateMikaBackendApiInput extends MikaBackendDependencies {
  readonly overrides?: MikaApiOverrides;
}

type MikaCartWishlistBackendRepositories = Pick<
  MikaBackendRepositories,
  "catalog" | "session" | "stock"
>;
type MikaCartWishlistBackendInput = Omit<CreateMikaBackendApiInput, "repositories"> & {
  readonly repositories: MikaCartWishlistBackendRepositories;
};

export interface ReserveStockInput {
  readonly stockItemId: MikaId;
  readonly quantity: number;
  readonly expiresAt: ISODateTime;
  readonly now?: ISODateTime;
  readonly cartId?: MikaId;
  readonly checkoutSessionId?: MikaId;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

export type ReserveStockResult = ReserveStockRepositoryResult;

export interface ReleaseReservedStockInput {
  readonly reservationEventId: MikaId;
  readonly now?: ISODateTime;
}

export type ReleaseReservedStockResult = ReleaseReservedStockRepositoryResult;

export interface ConsumeReservedStockInput {
  readonly reservationEventId: MikaId;
  readonly now?: ISODateTime;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
}

export type ConsumeReservedStockResult = ConsumeReservedStockRepositoryResult;

export interface ReleaseExpiredReservationsInput {
  readonly now?: ISODateTime;
}

export type ReleaseExpiredReservationsResult = ReleaseExpiredReservationsRepositoryResult;

export interface AdjustStockInput extends StockAdjustInput {
  readonly now?: ISODateTime;
}

export type AdjustStockResult = AdjustStockRepositoryResult;

export interface MikaStockLifecycleService {
  reserve(input: ReserveStockInput): Promise<ReserveStockResult>;
  release(input: ReleaseReservedStockInput): Promise<ReleaseReservedStockResult>;
  consume(input: ConsumeReservedStockInput): Promise<ConsumeReservedStockResult>;
  releaseExpiredReservations(
    input?: ReleaseExpiredReservationsInput,
  ): Promise<ReleaseExpiredReservationsResult>;
  adjust(input: AdjustStockInput): Promise<AdjustStockResult>;
}

export function createMikaStockLifecycleService(
  input: MikaBackendDependencies,
): MikaStockLifecycleService {
  return {
    reserve: async (reservation) =>
      input.repositories.stock.reserve({
        ...reservation,
        reservationEventId: input.createId("stock_event"),
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    release: async (reservation) =>
      input.repositories.stock.release({
        ...reservation,
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    consume: async (reservation) =>
      input.repositories.stock.consume({
        ...reservation,
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    releaseExpiredReservations: async (reservation = {}) =>
      input.repositories.stock.releaseExpiredReservations({
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    adjust: async (adjustment) =>
      input.repositories.stock.adjustStock({
        ...adjustment,
        movementEventId: input.createId("stock_event"),
        now: adjustment.now ?? currentBackendISODateTime(input),
      }),
  };
}

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
        const stock = await input.repositories.stock.findBySellableId(createMikaId(sellableId));
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

        const availability = stockAvailabilityToDTO(
          {
            id: stock.sellableId,
            active: true,
            sortOrder: 0,
            variantOptions: [],
            prices: [],
          },
          stock,
        );

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
    admin: {
      providerHealth: async (healthInput) => providerHealth(input, healthInput),
      providerSync: async (syncInput) => providerSync(input, syncInput),
      stockAdjust: async (adjustment) => {
        if (!Number.isInteger(adjustment.quantityDelta) || adjustment.quantityDelta === 0) {
          return validationFailed(
            "quantityDelta",
            "Quantity delta must be a non-zero whole number.",
          );
        }

        const result = await input.repositories.stock.adjustStock({
          ...adjustment,
          movementEventId: input.createId("stock_event"),
          now: currentBackendISODateTime(input),
        });

        if (result.status === "not_found") {
          return {
            ok: false,
            status: 404,
            error: {
              code: "VALIDATION_FAILED",
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

        return {
          ok: true,
          status: 200,
          data: adminStockAdjustmentResult(result),
        };
      },
      releaseExpiredReservations: async (releaseInput = {}) => {
        const result = await input.repositories.stock.releaseExpiredReservations({
          now: releaseInput.now ?? currentBackendISODateTime(input),
        });

        return {
          ok: true,
          status: 200,
          data: {
            status: "completed",
            affected: {
              reservationsScanned: result.scannedCount,
              reservationsReleased: result.releasedCount,
              stockItems: result.stockItemsAffected,
            },
          },
        };
      },
      webhookReplay: async (replayInput) => replayWebhook(input, replayInput),
      orderRefund: async (refundInput) => refundOrder(input, refundInput),
      orderCancel: async (cancelInput) => cancelOrder(input, cancelInput),
      entitlementGrant: async (grantInput) => grantEntitlement(input, grantInput),
      entitlementRevoke: async (revokeInput) => revokeEntitlement(input, revokeInput),
      emailResend: async (resendInput) => resendEmail(input, resendInput),
      licenseRevoke: async (revokeInput) => revokeLicense(input, revokeInput),
      downloadIssue: async (issueInput) => issueDownload(input, issueInput),
      ...input.overrides?.admin,
    },
    cart: createCartBackend(input),
    wishlist: createWishlistBackend(input),
    checkout: {
      start: async (ctx, checkoutInput) => startCheckout(input, ctx, checkoutInput),
      status: async (statusInput) => checkoutStatus(input, createMikaId(statusInput.checkoutId)),
      preview: async (ctx, previewInput) => {
        const preview = await createCheckoutPreview(input, ctx, previewInput);

        return { ok: true, status: 200, data: preview };
      },
      ...input.overrides?.checkout,
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
      resolve: async (downloadInput) => resolveDownload(input, downloadInput),
      ...input.overrides?.download,
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
      const currentItems = existing?.aggregate.items ?? [];
      const existingLine = currentItems.find((line) => isEquivalentCartLine(line, resolved.line));
      const nextQuantity = (existingLine?.quantity ?? 0) + resolved.line.quantity;
      const quantityError = validateQuantityLimit(resolved.sellable, resolved.stock, nextQuantity);
      if (quantityError) return quantityError;

      const document = existing ?? createCartDocument(input, ctx, currency);
      const items = existingLine
        ? currentItems.map((line) =>
            line.id === existingLine.id ? { ...line, quantity: nextQuantity } : line,
          )
        : [...currentItems, resolved.line];
      const updated = updateCartDocument(document, items, ctx.now);

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
    },
    update: async (ctx, itemInput) => {
      if (!Number.isInteger(itemInput.quantity) || itemInput.quantity < 1) {
        return validationFailed("quantity", "Quantity must be a positive whole number.");
      }

      const document = await findOrCreateOpenCart(input, ctx);
      const line = document.aggregate.items.find((item) => item.id === itemInput.lineId);
      if (!line) {
        return cartLineNotFound(itemInput.lineId);
      }

      const catalog = await input.repositories.catalog.findItemBySellableId(line.item.sellableId);
      const sellable = catalog?.aggregate.sellables.find(
        (item) => item.id === line.item.sellableId,
      );
      const stock = await input.repositories.stock.findBySellableId(line.item.sellableId);
      if (sellable) {
        const quantityError = validateQuantityLimit(sellable, stock, itemInput.quantity);
        if (quantityError) return quantityError;
      }

      const updated = updateCartDocument(
        document,
        document.aggregate.items.map((item) =>
          item.id === itemInput.lineId ? { ...item, quantity: itemInput.quantity } : item,
        ),
        ctx.now,
      );

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
    },
    remove: async (ctx, itemInput) => {
      const document = await findOrCreateOpenCart(input, ctx);
      if (!document.aggregate.items.some((item) => item.id === itemInput.lineId)) {
        return cartLineNotFound(itemInput.lineId);
      }

      const updated = updateCartDocument(
        document,
        document.aggregate.items.filter((item) => item.id !== itemInput.lineId),
        ctx.now,
      );

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
    },
    merge: async (ctx, mergeInput) => {
      const currency = defaultBackendCurrency(input);
      const targetResult = mergeInput.targetCartId
        ? await findOwnedOpenCartById(input, ctx, mergeInput.targetCartId, "targetCartId")
        : { ok: true as const, cart: await findOrCreateOpenCart(input, ctx) };
      if (!targetResult.ok) return targetResult;
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
      if (!source || source.id === targetResult.cart.id) {
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
      const abandonedSource: CartDocument = {
        ...source,
        status: "abandoned",
        updatedAt: ctx.now,
      };

      await input.repositories.session.put(updated);
      await input.repositories.session.put(abandonedSource);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
    },
    applyCoupon: async (ctx, couponInput) => {
      const cartResult = couponInput.cartId
        ? await findOwnedOpenCartById(input, ctx, couponInput.cartId, "cartId")
        : { ok: true as const, cart: await findOrCreateOpenCart(input, ctx) };
      if (!cartResult.ok) return cartResult;

      const code = couponInput.code.trim();
      if (!code) {
        return validationFailed("code", "Coupon code is required.");
      }

      const updated: CartDocument = {
        ...cartResult.cart,
        updatedAt: ctx.now,
        aggregate: cartWithCoupon({
          cart: cartResult.cart.aggregate,
          coupon: await createCouponSnapshot(input, cartResult.cart, code),
        }),
      };

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
    },
    removeCoupon: async (ctx, couponInput) => {
      const cartResult = couponInput.cartId
        ? await findOwnedOpenCartById(input, ctx, couponInput.cartId, "cartId")
        : { ok: true as const, cart: await findOrCreateOpenCart(input, ctx) };
      if (!cartResult.ok) return cartResult;

      const updated: CartDocument = {
        ...cartResult.cart,
        updatedAt: ctx.now,
        aggregate: cartWithoutCoupon({ cart: cartResult.cart.aggregate }),
      };

      await input.repositories.session.put(updated);

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
    },
  } satisfies MikaApi["cart"];

  return { ...cart, ...input.overrides?.cart };
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
      if (!source || source.id === targetResult.wishlist.id) {
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

  return { ...wishlist, ...input.overrides?.wishlist };
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
    return { ok: true, status: 200, data: await accountDTOForCustomer(input, identity.customer) };
  }

  return {
    ok: true,
    status: 200,
    data: {
      orders: [],
      subscriptions: [],
      entitlements: identity.entitlements.map((item) => entitlementDTO(item.data)),
      downloads: [],
    },
  };
}

async function resolveAccountIdentity(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<
  | {
      readonly customer: CustomerDocument;
      readonly entitlements: Awaited<
        ReturnType<MikaBackendRepositories["account"]["listEntitlementsByCustomer"]>
      >["items"];
      readonly userId?: string;
      readonly emailHash?: string;
    }
  | {
      readonly customer: null;
      readonly entitlements: Awaited<
        ReturnType<MikaBackendRepositories["account"]["listEntitlementsByUser"]>
      >["items"];
      readonly userId?: string;
      readonly emailHash?: string;
    }
  | null
> {
  const sessionCustomerId = await ctx.session?.get<MikaId>("mika.customerId");
  const sessionUserId = await ctx.session?.get<string>("mika.userId");
  const sessionEmailHash = await ctx.session?.get<string>("mika.emailHash");
  const customerId = ctx.customerId ?? sessionCustomerId;
  const userId = ctx.userId ?? sessionUserId;

  if (customerId) {
    const customer = await input.repositories.account.findCustomerById(customerId);
    if (!customer || (userId && customer.userId && customer.userId !== userId)) return null;

    return {
      customer,
      entitlements: (await input.repositories.account.listEntitlementsByCustomer(customerId)).items,
      userId: customer.userId,
      emailHash: customer.emailHash,
    };
  }

  if (userId) {
    const customer = await input.repositories.account.findCustomerByUserId(userId);
    if (customer) {
      return {
        customer,
        entitlements: (
          await input.repositories.account.listEntitlementsByCustomer(customer.customerId)
        ).items,
      };
    }

    const entitlements = await input.repositories.account.listEntitlementsByUser(userId);
    if (entitlements.items.length > 0) {
      return { customer: null, entitlements: entitlements.items, userId };
    }
  }

  if (sessionEmailHash) {
    const customer = await input.repositories.account.findCustomerByEmailHash(sessionEmailHash);
    if (customer) {
      return {
        customer,
        entitlements: (
          await input.repositories.account.listEntitlementsByCustomer(customer.customerId)
        ).items,
      };
    }

    const entitlements =
      await input.repositories.account.listEntitlementsByEmailHash(sessionEmailHash);
    if (entitlements.items.length > 0) {
      return { customer: null, entitlements: entitlements.items, emailHash: sessionEmailHash };
    }
  }

  return null;
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
    ? await accountDTOForCustomer(input, identity.customer)
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

  const record = {
    id: exportId,
    customerId: identity.customer?.customerId,
    userId: identity.customer?.userId ?? identity.userId,
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

  return { ok: true, status: 202, data: accountExportDTO(document, ctx, token) };
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
  downloadInput: { readonly exportId: MikaId; readonly token?: string },
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

  return { ok: true, status: 202, data: { requested: true } };
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

  const provider = input.providers.get(providerAccount.provider);
  if (!provider?.createPortalSession) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: `Provider '${providerAccount.provider}' does not support portal sessions.`,
      },
    };
  }

  try {
    const session = await provider.createPortalSession({
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
        code: "VALIDATION_FAILED",
        message: `Subscription '${actionInput.subscriptionId}' was not found.`,
        fieldErrors: { subscriptionId: "Subscription was not found." },
      },
    };
  }

  const provider = input.providers.get(subscription.provider);
  const methodName = subscriptionActionMethods[action];
  const method = provider?.[methodName];
  if (!provider || !method) {
    return providerUnsupportedForAction(
      provider
        ? `Provider '${subscription.provider}' does not support subscription ${action}.`
        : `Provider '${subscription.provider}' is not configured.`,
    );
  }

  const priceMatch =
    action === "change" && actionInput.priceId
      ? await input.repositories.catalog.findPriceById(actionInput.priceId)
      : null;
  if (action === "change" && actionInput.priceId && !priceMatch) {
    return validationFailed("priceId", `Price '${actionInput.priceId}' was not found.`);
  }

  const providerPriceId =
    priceMatch?.price.providerRefs.find((ref) => ref.provider === subscription.provider)?.priceId ??
    (action === "change" ? undefined : subscription.aggregate.providerRef.priceId);
  if (action === "change" && actionInput.priceId && !providerPriceId) {
    return providerUnsupportedForAction(
      `Price '${actionInput.priceId}' is not mapped for provider '${subscription.provider}'.`,
    );
  }

  const now = currentBackendISODateTime(input);
  const providerSubscriptionId =
    subscription.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId;
  const audit = createAdminAuditDocument(input, {
    action: `subscription.${action}`,
    targetType: "subscription",
    targetId: subscription.id,
    status: "started",
    createdAt: now,
    metadata: {
      provider: subscription.provider,
      subscriptionId: subscription.id,
      ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
      ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
      ...(providerPriceId ? { providerPriceId } : {}),
    },
  });
  await input.repositories.ops.writeAudit(audit);

  const providerInput: MikaProviderSubscriptionActionInput = {
    subscriptionId: subscription.id,
    ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
    ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
    ...(providerPriceId ? { providerPriceId } : {}),
  };

  try {
    await method.call(provider, providerInput);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Provider subscription ${action} failed.`;
    await failAdminAudit(input, audit, message);

    return providerFailed(message);
  }

  await updateSubscriptionAfterAction(input, ctx, subscription, action, priceMatch);
  await completeAdminAudit(input, audit);

  return {
    ok: true,
    status: 200,
    data: await accountDTOForCustomer(input, identity.customer),
  };
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
  const status: SubscriptionStatus =
    action === "cancel"
      ? "cancel_at_period_end"
      : action === "renew"
        ? "active"
        : subscription.status;
  const cancelAtPeriodEnd =
    action === "cancel"
      ? true
      : action === "renew"
        ? false
        : subscription.aggregate.cancelAtPeriodEnd;
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
  return updateSubscriptionEntitlement(input, ctx, updated);
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
  const providerName = syncInput.provider ?? input.defaults?.provider;
  if (!providerName) return providerUnsupportedForAction("No provider is configured.");

  const provider = input.providers.get(providerName);
  if (!provider?.syncCatalog) {
    return providerUnsupportedForAction(
      provider
        ? `Provider '${providerName}' does not support catalog sync.`
        : `Provider '${providerName}' is not configured.`,
    );
  }

  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: "provider.syncCatalog",
    status: "started",
    createdAt: now,
    metadata: {
      provider: providerName,
      mode: syncInput.mode ?? "dry_run",
    },
  });
  await input.repositories.ops.writeAudit(audit);

  try {
    const result = await provider.syncCatalog({
      mode: syncInput.mode ?? "dry_run",
    });
    await completeAdminAudit(input, audit);

    return { ok: true, status: 200, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider catalog sync failed.";
    await failAdminAudit(input, audit, message);

    return providerFailed(message);
  }
}

async function refundOrder(
  input: CreateMikaBackendApiInput,
  refundInput: OrderRefundInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const order = await input.repositories.ledger.findOrderById(refundInput.orderId);
  if (!order) {
    return orderNotFound(refundInput.orderId);
  }

  const provider = input.providers.get(order.provider);
  if (!provider?.refundPayment) {
    return providerUnsupportedForAction(
      provider
        ? `Provider '${order.provider}' does not support order refunds.`
        : `Provider '${order.provider}' is not configured.`,
    );
  }

  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: "order.refund",
    targetType: "order",
    targetId: order.id,
    status: "started",
    createdAt: now,
    metadata: {
      provider: order.provider,
      orderId: order.id,
      ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
      ...(refundInput.amount !== undefined ? { amount: refundInput.amount } : {}),
      ...(refundInput.reason ? { reason: refundInput.reason } : {}),
    },
  });
  await input.repositories.ops.writeAudit(audit);

  const providerInput: MikaProviderRefundInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(refundInput.amount !== undefined ? { amount: refundInput.amount } : {}),
    ...(refundInput.reason ? { reason: refundInput.reason } : {}),
  };

  try {
    const result = await provider.refundPayment(providerInput);
    const updated = updateOrderAfterRefund(order, refundInput, currentBackendISODateTime(input));
    await input.repositories.ledger.put(updated);
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        ...result,
        id: result.id ?? order.id,
        status: "completed",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider order refund failed.";
    await failAdminAudit(input, audit, message);

    return providerFailed(message);
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

  const provider = input.providers.get(order.provider);
  if (!provider?.cancelOrder) {
    return providerUnsupportedForAction(
      provider
        ? `Provider '${order.provider}' does not support order cancellation.`
        : `Provider '${order.provider}' is not configured.`,
    );
  }

  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: "order.cancel",
    targetType: "order",
    targetId: order.id,
    status: "started",
    createdAt: now,
    metadata: {
      provider: order.provider,
      orderId: order.id,
      ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
      ...(cancelInput.reason ? { reason: cancelInput.reason } : {}),
    },
  });
  await input.repositories.ops.writeAudit(audit);

  const providerInput: MikaProviderOrderCancelInput = {
    orderId: order.id,
    ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
    ...(cancelInput.reason ? { reason: cancelInput.reason } : {}),
  };

  try {
    const result = await provider.cancelOrder(providerInput);
    const updated = updateOrderAfterCancel(order, cancelInput, currentBackendISODateTime(input));
    await input.repositories.ledger.put(updated);
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        ...result,
        id: result.id ?? order.id,
        status: "completed",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider order cancellation failed.";
    await failAdminAudit(input, audit, message);

    return providerFailed(message);
  }
}

async function grantEntitlement(
  input: CreateMikaBackendApiInput,
  grantInput: EntitlementGrantInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const now = currentBackendISODateTime(input);
  const email = grantInput.email?.trim();
  const emailHash = email ? await input.hash(`email:${email.toLowerCase()}`) : undefined;
  const entitlementId = input.createId("entitlement");
  const audit = createAdminAuditDocument(input, {
    action: "entitlement.grant",
    targetType: "entitlement",
    targetId: entitlementId,
    status: "started",
    createdAt: now,
    metadata: {
      entitlementKey: grantInput.entitlementKey,
      ...(grantInput.customerId ? { customerId: grantInput.customerId } : {}),
      ...(grantInput.userId ? { userId: grantInput.userId } : {}),
      ...(emailHash ? { emailHash } : {}),
      ...(grantInput.expiresAt ? { expiresAt: grantInput.expiresAt } : {}),
    },
  });
  await input.repositories.ops.writeAudit(audit);

  try {
    const entitlement = createManualEntitlementDocument(entitlementId, grantInput, now, emailHash);
    await input.repositories.account.put(entitlement);
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        id: entitlement.id,
        status: "completed",
        affected: {
          entitlements: 1,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Entitlement grant failed.";
    await failAdminAudit(input, audit, message);
    return adminActionFailed(message);
  }
}

async function revokeEntitlement(
  input: CreateMikaBackendApiInput,
  revokeInput: EntitlementRevokeInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const entitlement = await findEntitlementForRevoke(input, revokeInput);
  if (!entitlement) {
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

  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: "entitlement.revoke",
    targetType: "entitlement",
    targetId: entitlement.id,
    status: "started",
    createdAt: now,
    metadata: {
      entitlementId: entitlement.id,
      entitlementKey: entitlement.entitlementKey,
      ...(entitlement.customerId ? { customerId: entitlement.customerId } : {}),
      ...(revokeInput.reason ? { reason: revokeInput.reason } : {}),
    },
  });
  await input.repositories.ops.writeAudit(audit);

  try {
    const updated: EntitlementDocument = {
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
    };
    await input.repositories.account.put(updated);
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        id: updated.id,
        status: "completed",
        affected: {
          entitlements: 1,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Entitlement revoke failed.";
    await failAdminAudit(input, audit, message);
    return adminActionFailed(message);
  }
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

  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: "email.resend",
    targetType: "email",
    targetId: email.id,
    status: "started",
    createdAt: now,
    metadata: {
      emailId: email.id,
      kind: email.kind,
    },
  });
  await input.repositories.ops.writeAudit(audit);

  try {
    await input.repositories.ops.put({
      ...email,
      status: "queued",
      nextAttemptAt: now,
      updatedAt: now,
      record: {
        ...email.record,
        status: "queued",
        nextAttemptAt: now,
        lastError: undefined,
        metadata: {
          ...email.record.metadata,
          resentAt: now,
          adminAuditId: audit.id,
        },
      },
    });
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        id: email.id,
        status: "completed",
        affected: {
          emails: 1,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email resend failed.";
    await failAdminAudit(input, audit, message);
    return adminActionFailed(message);
  }
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

  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: "license.revoke",
    targetType: "license",
    targetId: license.id,
    status: "started",
    createdAt: now,
    metadata: {
      licenseId: license.id,
      ...(license.customerId ? { customerId: license.customerId } : {}),
      ...(license.orderId ? { orderId: license.orderId } : {}),
      ...(license.orderLineId ? { orderLineId: license.orderLineId } : {}),
      ...(revokeInput.reason ? { reason: revokeInput.reason } : {}),
    },
  });
  await input.repositories.ops.writeAudit(audit);

  try {
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
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        id: updated.id,
        status: "completed",
        affected: {
          licenses: 1,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "License revoke failed.";
    await failAdminAudit(input, audit, message);
    return adminActionFailed(message);
  }
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
  const audit = createAdminAuditDocument(input, {
    action: "download.issue",
    targetType: "download",
    targetId: createMikaId(target.downloadRef),
    status: "started",
    createdAt: now,
    metadata: {
      orderId: target.order.id,
      orderLineId: target.line.id,
      downloadRef: target.downloadRef,
      ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
      ...(target.license?.id ? { licenseId: target.license.id } : {}),
      expiresAt,
    },
  });
  await input.repositories.ops.writeAudit(audit);

  try {
    if (!target.line.downloadRefs?.includes(target.downloadRef)) {
      await input.repositories.ledger.put(
        addDownloadRefToOrder(target.order, target.line.id, target.downloadRef, now),
      );
    }

    await input.repositories.ephemeral.put({
      key: downloadTokenHash,
      kind: "token",
      ...(target.order.customerId ? { subjectHash: target.order.customerId } : {}),
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
    await completeAdminAudit(input, audit);

    return {
      ok: true,
      status: 200,
      data: {
        id: createMikaId(target.downloadRef),
        status: "completed",
        affected: {
          downloads: 1,
          tokens: 1,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download issue failed.";
    await failAdminAudit(input, audit, message);
    return adminActionFailed(message);
  }
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

async function findEntitlementForRevoke(
  input: CreateMikaBackendApiInput,
  revokeInput: EntitlementRevokeInput,
): Promise<EntitlementDocument | null> {
  if (revokeInput.entitlementId) {
    return input.repositories.account.findEntitlementById(revokeInput.entitlementId);
  }

  if (!revokeInput.customerId || !revokeInput.entitlementKey) return null;

  const entitlements = await input.repositories.account.listEntitlementsByCustomer(
    revokeInput.customerId,
  );
  return (
    entitlements.items.find(
      (item) =>
        item.data.entitlementKey === revokeInput.entitlementKey && item.data.status === "active",
    )?.data ?? null
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

async function completeAdminAudit(
  input: CreateMikaBackendApiInput,
  audit: AdminAuditDocument,
): Promise<void> {
  await input.repositories.ops.writeAudit({
    ...audit,
    status: "completed",
    updatedAt: currentBackendISODateTime(input),
    record: {
      ...audit.record,
      status: "completed",
    },
  });
}

async function failAdminAudit(
  input: CreateMikaBackendApiInput,
  audit: AdminAuditDocument,
  message: string,
): Promise<void> {
  await input.repositories.ops.writeAudit({
    ...audit,
    status: "failed",
    updatedAt: currentBackendISODateTime(input),
    record: {
      ...audit.record,
      status: "failed",
      metadata: {
        ...audit.record.metadata,
        error: message,
      },
    },
  });
}

function missingTarget(targetType: string, field: string, value: string): MikaApiFailure {
  const label = targetType[0]?.toUpperCase() + targetType.slice(1);

  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `${label} '${value}' was not found.`,
      fieldErrors: { [field]: `${label} was not found.` },
    },
  };
}

async function missingTargetWithAudit(
  input: CreateMikaBackendApiInput,
  missing: {
    readonly action: string;
    readonly targetType: string;
    readonly field: string;
    readonly value: string;
    readonly targetId?: MikaId;
    readonly metadata?: JsonObject;
  },
): Promise<MikaApiFailure> {
  const failure = missingTarget(missing.targetType, missing.field, missing.value);
  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: missing.action,
    targetType: missing.targetType,
    ...(missing.targetId ? { targetId: missing.targetId } : {}),
    status: "failed",
    createdAt: now,
    metadata: {
      ...missing.metadata,
      error: failure.error.message,
      field: missing.field,
      value: missing.value,
    },
  });
  await input.repositories.ops.writeAudit(audit);

  return failure;
}

function adminActionFailed(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 500,
    error: {
      code: "CONFLICT",
      message,
    },
  };
}

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
      ...(requestInput.returnTo ? { returnTo: requestInput.returnTo } : {}),
    },
  });

  const link = magicLinkUrl(ctx, token, requestInput.returnTo);
  const rendered = renderMikaEmail("magic_link", {
    toEmail: email,
    url: link,
    purpose: "sign_in",
    expiresAt,
  });
  const emailId = input.createId("email");
  const emailRecord = {
    id: emailId,
    customerId: customer?.customerId,
    tokenId,
    kind: "magic_link" as const,
    toEmail: email,
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
      purpose: "sign_in",
      expiresAt,
      link,
      ...(requestInput.returnTo ? { returnTo: requestInput.returnTo } : {}),
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

  return { ok: true, status: 200, data: { sent: true } };
}

async function verifyMagicLink(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  verifyInput: { readonly token: string; readonly returnTo?: string },
): Promise<MikaApiResult<AccountDTO>> {
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

  const customer = record?.subjectHash
    ? await input.repositories.account.findCustomerByEmailHash(record.subjectHash)
    : null;
  if (customer) {
    await ctx.session?.set("mika.customerId", customer.customerId);
    if (customer.userId) await ctx.session?.set("mika.userId", customer.userId);

    return { ok: true, status: 200, data: await accountDTOForCustomer(input, customer) };
  }

  const email = record?.data ? stringChild(record.data, "email") : undefined;
  if (record?.subjectHash) await ctx.session?.set("mika.emailHash", record.subjectHash);

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
}

async function accountDTOForCustomer(
  input: CreateMikaBackendApiInput,
  customer: CustomerDocument,
): Promise<AccountDTO> {
  const [orders, subscriptions, entitlements] = await Promise.all([
    input.repositories.ledger.listOrdersByCustomer(customer.customerId),
    input.repositories.account.listSubscriptionsByCustomer(customer.customerId),
    input.repositories.account.listEntitlementsByCustomer(customer.customerId),
  ]);
  await Promise.all([
    input.repositories.account.listProviderAccountsByCustomer(customer.customerId),
    input.repositories.account.listLicensesByCustomer(customer.customerId),
  ]);

  const orderSummaries = orders.items.map((item) => orderSummaryDTO(item.data));

  return {
    customer: {
      id: customer.customerId,
      userId: customer.userId,
      email: customer.aggregate.email,
      name: customer.aggregate.name,
    },
    orders: orderSummaries,
    subscriptions: subscriptions.items.map((item) => subscriptionDTO(item.data)),
    entitlements: entitlements.items.map((item) => entitlementDTO(item.data)),
    downloads: orders.items.flatMap((item) => orderDownloadDTOs(item.data)),
  };
}

function orderSummaryDTO(order: OrderDocument): OrderSummaryDTO {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.aggregate.totals.total,
    createdAt: order.createdAt,
    invoiceUrl: order.aggregate.invoiceUrl,
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

function orderDownloadDTOs(order: OrderDocument): readonly DownloadDTO[] {
  return order.aggregate.lines.flatMap((line) =>
    (line.downloadRefs ?? []).map((downloadRef) => ({
      id: createMikaId(downloadRef),
      title: line.item.titleSnapshot,
      href: downloadRef,
    })),
  );
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

async function resolveDownload(
  input: CreateMikaBackendApiInput,
  downloadInput: { readonly token: string },
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

  const order = await input.repositories.ledger.findOrderByDownloadRef(downloadRef);
  const line = order?.aggregate.lines.find((candidate) =>
    candidate.downloadRefs?.includes(downloadRef),
  );
  if (!order || !line || order.status !== "paid" || order.paymentStatus !== "paid") {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }

  const orderId = stringChild(data, "orderId");
  const orderLineId = stringChild(data, "orderLineId");
  if ((orderId && order.id !== orderId) || (orderLineId && line.id !== orderLineId)) {
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

  const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, now);
  if (!consumed) {
    const current = await input.repositories.ephemeral.get(tokenHash);
    return (
      downloadTokenError(current, now) ?? tokenResult("TOKEN_INVALID", "Download token is invalid.")
    );
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

function accountExportArtifactRef(account: AccountDTO, exportedAt: ISODateTime): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(
    JSON.stringify({ exportedAt, account }),
  )}`;
}

function accountExportBelongsToIdentity(
  document: AccountExportDocument,
  identity: NonNullable<Awaited<ReturnType<typeof resolveAccountIdentity>>>,
): boolean {
  if (identity.customer && document.customerId === identity.customer.customerId) return true;
  return Boolean(identity.userId && document.userId === identity.userId);
}

function accountExportSubjectHash(
  identity: NonNullable<Awaited<ReturnType<typeof resolveAccountIdentity>>>,
): string | undefined {
  if (identity.customer?.customerId) return `customer:${identity.customer.customerId}`;
  if (identity.userId) return `user:${identity.userId}`;
  return identity.emailHash ? `email:${identity.emailHash}` : undefined;
}

async function hashAccountExportDownloadToken(
  input: CreateMikaBackendApiInput,
  token: string,
): Promise<string> {
  return input.hash(`account-export-download-token:${token}`);
}

async function hashDownloadToken(input: CreateMikaBackendApiInput, token: string): Promise<string> {
  return input.hash(`download-token:${token}`);
}

function accountExportDownloadTokenError(
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

function downloadTokenError(
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

async function hashMagicLinkToken(
  input: CreateMikaBackendApiInput,
  token: string,
): Promise<string> {
  return input.hash(`magic-link-token:${token}`);
}

function magicLinkUrl(ctx: MikaRequestContext, token: string, returnTo?: string): string {
  return mikaPluginRoute("magicLinkVerify", {
    origin: ctx.url?.origin,
    search: { token, returnTo },
  });
}

function accountPortalReturnUrl(ctx: MikaRequestContext, returnTo?: string): string {
  if (!returnTo) return ctx.url?.href ?? "/";
  if (!ctx.url) return returnTo;

  return new URL(returnTo, ctx.url.origin).toString();
}

function magicLinkTokenError(
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

function tokenResult(code: MikaError["code"], message: string): MikaApiFailure {
  return {
    ok: false,
    status: code === "TOKEN_INVALID" ? 400 : 410,
    error: { code, message },
  };
}

function authRequired(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 401,
    error: { code: "AUTH_REQUIRED", message },
  };
}

function forbidden(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 403,
    error: { code: "FORBIDDEN", message },
  };
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
  if (duplicate) return webhookDuplicateResult(duplicate);

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

  return {
    ok: true,
    status: 200,
    data: {
      id: processedWebhook.id,
      status: processedWebhook.status === "failed" ? "failed" : "received",
      replayable: true,
    },
  };
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
        code: "VALIDATION_FAILED",
        message: `Webhook '${replayInput.webhookId}' was not found.`,
        fieldErrors: { webhookId: "Webhook was not found." },
      },
    };
  }

  if (!isReplayableWebhookStatus(webhook.status)) {
    return {
      ok: true,
      status: 200,
      data: {
        id: webhook.id,
        status: "completed",
        message: `Webhook '${webhook.id}' is not eligible for replay.`,
        affected: {
          processed: 0,
          failed: 0,
        },
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
      ok: true,
      status: 200,
      data: {
        id: failed.id,
        status: "failed",
        message: "Webhook payload could not be reconstructed for replay.",
        affected: {
          processed: 0,
          failed: 1,
        },
      },
    };
  }

  const processed = await processStoredWebhook(
    input,
    { now: currentBackendISODateTime(input) },
    webhook,
    event,
  );
  const processedCount = processed.status === "failed" ? 0 : 1;
  const failedCount = processed.status === "failed" ? 1 : 0;

  return {
    ok: true,
    status: 200,
    data: {
      id: processed.id,
      status: processed.status === "failed" ? "failed" : "completed",
      affected: {
        processed: processedCount,
        failed: failedCount,
      },
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
    normalizedEvent: webhookEventToJson(event),
  });
}

function webhookEventToJson(event: MikaProviderWebhookEvent): JsonObject {
  switch (event.kind) {
    case "payment":
      return jsonObject({
        kind: event.kind,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        providerCheckoutId: event.providerCheckoutId,
        providerPaymentId: event.providerPaymentId,
        providerOrderId: event.providerOrderId,
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
        raw: event.raw,
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
        raw: event.raw,
      });
    case "unknown":
      return jsonObject({
        kind: event.kind,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        raw: event.raw,
      });
  }
}

function providerLineToJson(line: MikaProviderLineItem): JsonObject {
  return jsonObject({
    sellableId: line.sellableId,
    priceId: line.priceId,
    contentRef: jsonObject({
      collection: line.contentRef.collection,
      id: line.contentRef.id,
      locale: line.contentRef.locale,
    }),
    sku: line.sku,
    title: line.title,
    variantKey: line.variantKey,
    variantOptions: line.variantOptions?.map((option) =>
      jsonObject({
        option: option.option,
        value: option.value,
        label: option.label,
      }),
    ),
    providerProductId: line.providerProductId,
    providerPriceId: line.providerPriceId,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    currency: line.currency,
    mode: line.mode,
    fulfillmentKind: line.fulfillmentKind,
    entitlementKey: line.entitlementKey,
    metadata: line.metadata,
  });
}

function moneyToJson(money: MoneyDTO): JsonObject {
  return jsonObject({
    amount: money.amount,
    currency: money.currency,
  });
}

function jsonObject(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  ) as JsonObject;
}

function isReplayableWebhookStatus(status: WebhookDocument["status"]): boolean {
  return (
    status === "failed" ||
    status === "received" ||
    status === "processing" ||
    (status as string) === "queued"
  );
}

function storedWebhookEvent(webhook: WebhookDocument): MikaProviderWebhookEvent | null {
  const payload = webhook.record.rawPayloadJson;
  if (!payload) return null;

  const eventPayload =
    jsonChild(payload, "normalizedEvent") ?? (stringChild(payload, "kind") ? payload : null);
  if (!eventPayload) return null;

  const provider = stringChild(eventPayload, "provider");
  const type = stringChild(eventPayload, "type");
  if (provider !== webhook.provider || !type) return null;

  switch (stringChild(eventPayload, "kind")) {
    case "payment":
      return {
        kind: "payment",
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        providerCheckoutId: stringChild(eventPayload, "providerCheckoutId"),
        providerPaymentId: stringChild(eventPayload, "providerPaymentId"),
        providerOrderId: stringChild(eventPayload, "providerOrderId"),
        customer: customerChild(eventPayload, "customer"),
        lines: providerLineChildren(eventPayload, "lines"),
        totals: totalsChild(eventPayload, "totals"),
        invoiceUrl: stringChild(eventPayload, "invoiceUrl"),
        raw: jsonChild(eventPayload, "raw"),
      };
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

function jsonChild(input: JsonObject, key: string): JsonObject | undefined {
  const value = input[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringChild(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function booleanChild(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberChild(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function isoChild(input: JsonObject, key: string): ISODateTime | undefined {
  const value = stringChild(input, key);
  return value ? createISODateTime(value) : undefined;
}

function customerChild(
  input: JsonObject,
  key: string,
): MikaProviderPaymentEvent["customer"] | undefined {
  const value = jsonChild(input, key);
  if (!value) return undefined;

  return {
    email: stringChild(value, "email"),
    name: stringChild(value, "name"),
    company: stringChild(value, "company"),
    vatId: stringChild(value, "vatId"),
  };
}

function totalsChild(
  input: JsonObject,
  key: string,
): MikaProviderPaymentEvent["totals"] | undefined {
  const value = jsonChild(input, key);
  if (!value) return undefined;

  return {
    subtotal: moneyChild(value, "subtotal"),
    discount: moneyChild(value, "discount"),
    tax: moneyChild(value, "tax"),
    total: moneyChild(value, "total"),
  };
}

function moneyChild(input: JsonObject, key: string): MoneyDTO | undefined {
  const value = jsonChild(input, key);
  const amount = value ? numberChild(value, "amount") : undefined;
  const currency = value ? stringChild(value, "currency") : undefined;
  if (amount === undefined || !currency) return undefined;

  return { amount, currency: createCurrencyCode(currency) };
}

function providerLineChildren(input: JsonObject, key: string): readonly MikaProviderLineItem[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];

    const line = item as JsonObject;
    const sellableId = stringChild(line, "sellableId");
    const title = stringChild(line, "title");
    const quantity = numberChild(line, "quantity");
    const unitAmount = numberChild(line, "unitAmount");
    const currency = stringChild(line, "currency");
    const mode = stringChild(line, "mode");
    const fulfillmentKind = stringChild(line, "fulfillmentKind");
    if (
      !sellableId ||
      !title ||
      quantity === undefined ||
      unitAmount === undefined ||
      !currency ||
      (mode !== "payment" && mode !== "subscription") ||
      !isFulfillmentKind(fulfillmentKind)
    ) {
      return [];
    }

    return [
      {
        sellableId: createMikaId(sellableId),
        priceId: mikaIdChild(line, "priceId"),
        contentRef: contentRefChild(line, "contentRef") ?? { collection: "", id: "" },
        sku: stringChild(line, "sku"),
        title,
        variantKey: stringChild(line, "variantKey"),
        variantOptions: variantOptionChildren(line, "variantOptions"),
        providerProductId: stringChild(line, "providerProductId"),
        providerPriceId: stringChild(line, "providerPriceId"),
        quantity,
        unitAmount,
        currency: createCurrencyCode(currency),
        mode,
        fulfillmentKind,
        entitlementKey: stringChild(line, "entitlementKey"),
        metadata: jsonChild(line, "metadata"),
      },
    ];
  });
}

function contentRefChild(
  input: JsonObject,
  key: string,
): MikaProviderLineItem["contentRef"] | undefined {
  const value = jsonChild(input, key);
  const collection = value ? stringChild(value, "collection") : undefined;
  const id = value ? stringChild(value, "id") : undefined;
  if (!value || !collection || !id) return undefined;

  return { collection, id, locale: stringChild(value, "locale") };
}

function variantOptionChildren(
  input: JsonObject,
  key: string,
): MikaProviderLineItem["variantOptions"] {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];

    const option = item as JsonObject;
    const optionName = stringChild(option, "option");
    const optionValue = stringChild(option, "value");
    if (!optionName || !optionValue) return [];

    return [{ option: optionName, value: optionValue, label: stringChild(option, "label") }];
  });
}

function mikaIdChild(input: JsonObject, key: string): MikaId | undefined {
  const value = stringChild(input, key);
  return value ? createMikaId(value) : undefined;
}

function isSubscriptionStatus(value: string | undefined): value is SubscriptionStatus {
  return (
    value === "incomplete" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "cancel_at_period_end" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function isFulfillmentKind(
  value: string | undefined,
): value is MikaProviderLineItem["fulfillmentKind"] {
  return (
    value === "none" ||
    value === "download" ||
    value === "license" ||
    value === "entitlement" ||
    value === "physical"
  );
}

async function processStoredWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderWebhookEvent,
): Promise<WebhookDocument> {
  switch (event.kind) {
    case "payment":
      try {
        return await processPaymentWebhook(input, ctx, webhook, event);
      } catch {
        return markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment webhook could not be processed.",
        );
      }
    case "subscription":
      try {
        return await processSubscriptionWebhook(input, ctx, webhook, event);
      } catch {
        return markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Subscription webhook could not be processed.",
        );
      }
    case "unknown":
      return webhook;
  }
}

async function processPaymentWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  let existingOrder = await findExistingPaymentOrder(input, event);
  if (existingOrder) {
    const order = await updatePaymentOrderFromEvent(input, ctx, existingOrder, event);
    await completeCheckoutForPaymentOrder(input, ctx, order, event);
    const fulfilledOrder = await fulfillPaidOrder(input, ctx, order);

    return markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder);
  }

  const checkout = await findPaymentEventCheckout(input, event);
  if (!checkout) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Payment event could not be linked to a checkout.",
    );
  }

  existingOrder = await findExistingPaymentOrder(input, event, checkout.id);
  if (existingOrder) {
    const order = await updatePaymentOrderFromEvent(input, ctx, existingOrder, event);
    await completeCheckoutForPaymentOrder(input, ctx, order, event, checkout);
    const fulfilledOrder = await fulfillPaidOrder(input, ctx, order);

    return markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder);
  }

  const order = await persistNewPaymentOrder(
    input,
    ctx,
    await createPaymentOrderDocument(input, ctx, checkout, event),
    event,
    checkout,
  );
  await completeCheckoutForPaymentOrder(input, ctx, order, event, checkout);
  const fulfilledOrder = await fulfillPaidOrder(input, ctx, order);

  return markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder);
}

async function processSubscriptionWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderSubscriptionEvent,
): Promise<WebhookDocument> {
  const subscription = await findOrCreateSubscriptionFromEvent(input, ctx, event);
  if (!subscription) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Subscription event could not be linked to a subscription.",
    );
  }

  const updated = await updateSubscriptionFromEvent(input, ctx, subscription, event);
  const fulfilled = await updateSubscriptionEntitlement(input, ctx, updated);

  return markWebhookProcessedForSubscription(input, webhook, ctx.now, fulfilled);
}

async function findOrCreateSubscriptionFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  event: MikaProviderSubscriptionEvent,
): Promise<SubscriptionDocument | null> {
  if (event.providerSubscriptionId) {
    const existing = await input.repositories.account.findSubscriptionByProvider(
      event.provider,
      event.providerSubscriptionId,
    );
    if (existing) return existing;
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
  };
}

async function updateSubscriptionFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
  event: MikaProviderSubscriptionEvent,
): Promise<SubscriptionDocument> {
  const updated: SubscriptionDocument = {
    ...subscription,
    providerCustomerId: event.providerCustomerId ?? subscription.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId ?? subscription.providerSubscriptionId,
    status: event.status,
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
      status: event.status,
      cancelAtPeriodEnd:
        event.cancelAtPeriodEnd ?? subscription.aggregate.cancelAtPeriodEnd ?? false,
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
  const status = entitlementStatusForSubscription(subscription.status);
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
      return "active";
    case "cancelled":
    case "expired":
      return "expired";
    case "incomplete":
    case "past_due":
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
  event: MikaProviderPaymentEvent,
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

  return {
    id: orderId,
    type: "order",
    schemaVersion: 1,
    orderNumber: orderId,
    customerId: checkout.customerId,
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
      customer: await paymentCustomerSnapshot(input, checkout, event),
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
  const updated: OrderDocument = {
    ...order,
    providerPaymentId: order.providerPaymentId ?? event.providerPaymentId,
    providerOrderId: order.providerOrderId ?? event.providerOrderId,
    status: "paid",
    paymentStatus: "paid",
    paidAt: order.paidAt ?? ctx.now,
    updatedAt: ctx.now,
    aggregate: {
      ...order.aggregate,
      invoiceUrl: event.invoiceUrl ?? order.aggregate.invoiceUrl,
      providerRefs: mergePaymentProviderRefs(order.aggregate.providerRefs, order, event),
      metadata: {
        ...order.aggregate.metadata,
        ...paymentOrderMetadata(event, order.checkoutSessionId),
      },
    },
  };

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

  await input.repositories.session.put({
    ...document,
    status: "converted",
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
  const normalizedEmail = event.customer?.email?.trim().toLowerCase();

  return {
    customerId: checkout.customerId,
    email: event.customer?.email,
    emailHash: normalizedEmail ? await input.hash(`email:${normalizedEmail}`) : undefined,
    name: event.customer?.name,
    company: event.customer?.company,
    vatId: event.customer?.vatId,
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
  let changed = false;

  for (const line of order.aggregate.lines) {
    const fulfilled = await fulfillPaidOrderLine(input, ctx, order, line);
    fulfilledLines.push(fulfilled);
    changed = changed || fulfilled !== line;
  }

  await queueOrderConfirmationEmail(input, ctx, order, fulfilledLines);

  if (!changed) return order;

  const fulfilledOrder: OrderDocument = {
    ...order,
    updatedAt: ctx.now,
    aggregate: {
      ...order.aggregate,
      lines: fulfilledLines,
      metadata: {
        ...order.aggregate.metadata,
        fulfilledAt: ctx.now,
      },
    },
  };

  await input.repositories.ledger.put(fulfilledOrder);

  return fulfilledOrder;
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
  const toEmail = order.aggregate.customer.email?.trim();
  if (!toEmail) return;

  const id = fulfillmentDocumentId("email", order.id, "order_confirmation");
  const existing = await input.repositories.ops.findEmail(id);
  if (existing) return;

  const rendered = renderMikaEmail("order_confirmation", {
    toEmail,
    orderNumber: order.orderNumber,
    total: order.aggregate.totals.total,
    lines: lines.map((line) => ({
      title: line.item.titleSnapshot,
      quantity: line.quantity,
      total: { amount: line.totalAmount, currency: line.item.currency },
    })),
  });
  const record = {
    id,
    customerId: order.customerId ?? order.aggregate.customer.customerId,
    orderId: order.id,
    kind: "order_confirmation" as const,
    toEmail,
    subject: rendered.subject,
    status: "queued" as const,
    idempotencyKey: `order-confirmation:${order.id}`,
    templateKey: rendered.template,
    templateVersion: "1",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: ctx.now,
    createdAt: ctx.now,
    metadata: {
      orderLineIds: lines.map((line) => line.id),
      fulfillmentKinds: [...new Set(lines.map((line) => line.item.fulfillmentKind))],
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
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

  await input.repositories.ops.put(document);
}

function orderLineDownloadRef(order: OrderDocument, line: OrderLine): string {
  return `download:${order.id}:${line.id}`;
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
  return markWebhookProcessed(input, webhook, now, {
    relatedCustomerId: order.customerId,
    relatedOrderId: order.id,
  });
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

  return putWebhookBestEffort(input, processed);
}

async function markWebhookFailed(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  lastError: string,
): Promise<WebhookDocument> {
  const failed: WebhookDocument = {
    ...webhook,
    status: "failed",
    record: {
      ...webhook.record,
      status: "failed",
      attemptCount: webhook.record.attemptCount + 1,
      lastError,
    },
    updatedAt: now,
  };

  return putWebhookBestEffort(input, failed);
}

async function putWebhookBestEffort(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
): Promise<WebhookDocument> {
  try {
    await input.repositories.ops.put(webhook);
  } catch {
    // The webhook has already been accepted; callers still receive the in-memory state.
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

  if (ctx.customerId) {
    if (document.customerId !== ctx.customerId) {
      return invalidWishlist("targetWishlistId", wishlistId);
    }
  } else if (ctx.sessionId && document.sessionId !== ctx.sessionId) {
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

async function findOpenCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
): Promise<CartDocument | null> {
  if (ctx.customerId) {
    return input.repositories.session.findOpenCartByCustomer(ctx.customerId, currency);
  }

  return ctx.sessionId
    ? input.repositories.session.findOpenCartBySession(ctx.sessionId, currency)
    : null;
}

async function createCartQuote(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  quoteInput: CartQuoteInput,
): Promise<CartQuoteDTO> {
  const defaultCurrency = defaultBackendCurrency(input);
  const cartResult = await findQuoteCart(input, ctx, quoteInput.cartId, defaultCurrency);
  const currency = cartResult.cart?.aggregate.currency ?? defaultCurrency;
  const warnings: string[] = [];
  const errors: MikaError[] = [];
  const quoteLines: CartQuoteLineDTO[] = [];
  let changed = false;
  let unavailable = false;
  let coupon = cartResult.cart?.aggregate.coupon;
  let quotedCouponLabel: string | undefined;
  let quotedCouponCodeHash: string | undefined;

  if (quoteInput.couponCode !== undefined) {
    const normalizedCode = quoteInput.couponCode.trim();
    if (normalizedCode) {
      quotedCouponLabel = normalizedCode.toUpperCase();
      quotedCouponCodeHash = await input.hash(`coupon:${quotedCouponLabel}`);
      changed = !coupon || coupon.label !== quotedCouponLabel;
    } else if (coupon) {
      changed = true;
      coupon = undefined;
    }
  }

  if (cartResult.cart) {
    for (const line of cartResult.cart.aggregate.items) {
      const quoted = await quoteCartLine(input, line);
      quoteLines.push(quoted.line);
      changed = changed || quoted.changed;
      unavailable = unavailable || quoted.unavailable;
    }
  }

  if (quoteInput.sellableId) {
    const quoted = await quoteInputLine(input, quoteInput, currency);
    quoteLines.push(quoted.line);
    unavailable = unavailable || quoted.unavailable;
  }

  if (quoteLines.length === 0) {
    unavailable = true;
    warnings.push("Cart quote is empty.");
    errors.push({
      code: "CHECKOUT_EMPTY",
      message: "Cart quote is empty.",
    });
  }

  if (cartResult.expired) {
    warnings.push("Cart quote has expired.");
    errors.push({
      code: "CHECKOUT_EXPIRED",
      message: "Cart quote has expired.",
    });
  }

  const subtotalAmount = quoteLines.reduce((sum, line) => sum + (line.subtotal?.amount ?? 0), 0);
  const discountAmount =
    quotedCouponLabel !== undefined
      ? Math.floor(subtotalAmount * 0.1)
      : (coupon?.discountAmount ?? 0);
  if (quotedCouponLabel !== undefined) {
    coupon = {
      codeHash: quotedCouponCodeHash ?? "",
      label: quotedCouponLabel,
      discountAmount,
    };
  }
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);
  const status = cartResult.expired
    ? "expired"
    : unavailable
      ? "unavailable"
      : changed
        ? "changed"
        : "valid";

  return {
    id: input.createId("cart_quote"),
    cartId: cartResult.cart?.id,
    status,
    currency,
    items: quoteLines,
    subtotal: moneyDTO(subtotalAmount, currency),
    discount: discountAmount > 0 ? moneyDTO(discountAmount, currency) : undefined,
    total: moneyDTO(totalAmount, currency),
    adjustments:
      discountAmount > 0
        ? [
            {
              type: "discount",
              label: coupon?.label,
              amount: moneyDTO(discountAmount, currency),
            },
          ]
        : undefined,
    coupon: coupon
      ? {
          label: coupon.label,
          discount: discountAmount > 0 ? moneyDTO(discountAmount, currency) : undefined,
          providerCouponId: coupon.providerRef?.priceId,
        }
      : undefined,
    expiresAt: cartResult.cart?.expiresAt,
    inputHash: await input.hash(
      JSON.stringify({
        cartId: cartResult.cart?.id,
        sellableId: quoteInput.sellableId,
        priceId: quoteInput.priceId,
        quantity: quoteInput.quantity,
        couponCode: quoteInput.couponCode,
        currency,
      }),
    ),
    warnings: warnings.length > 0 ? warnings : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}

type CheckoutStartLineResolution = {
  readonly line: CheckoutLine;
  readonly stock: StockItemRecord | null;
};

type CheckoutStartResolution = {
  readonly cart: CartDocument | null;
  readonly currency: CurrencyCode;
  readonly mode: PurchaseMode;
  readonly coupon?: CouponSnapshot;
  readonly lines: readonly CheckoutStartLineResolution[];
};

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
    const replayedInputHash = checkoutStoredIdempotencyInputHash(replayedCheckout);
    if (replayedInputHash && idempotencyInputHash && replayedInputHash !== idempotencyInputHash) {
      return checkoutIdempotencyInputMismatch();
    }

    return checkoutDocumentResult(replayedCheckout);
  }

  const resolved = await resolveCheckoutStart(input, ctx, checkoutInput);
  if (!resolved.ok) return resolved;

  const providerName = checkoutInput.provider ?? input.defaults?.provider;
  if (!providerName) {
    return validationFailed("provider", "A checkout provider is required.");
  }

  const provider = input.providers.get(providerName);
  if (!provider) return providerUnsupported(providerName);

  try {
    const capabilities = await provider.capabilities();
    if (!capabilities.includes("hosted_checkout")) {
      return providerUnsupported(providerName);
    }
  } catch {
    return providerFailed("Checkout provider capabilities could not be verified.");
  }

  const checkoutId = input.createId("checkout");
  const expiresAt = checkoutExpiresAt(input, ctx);
  const reserved = await reserveCheckoutLines(input, ctx, checkoutId, resolved, expiresAt);
  if (!reserved.ok) return reserved;

  const providerSession = await (async () => {
    try {
      return await provider.createCheckoutSession({
        idempotencyKey: ctx.idempotencyKey,
        mode: resolved.mode,
        provider: providerName,
        customer: checkoutInput.customer,
        lines: reserved.lines.map((line) => checkoutLineToProviderLine(providerName, line)),
        successUrl: checkoutSuccessUrl(input, ctx, checkoutInput, checkoutId),
        cancelUrl: checkoutCancelUrl(input, ctx, checkoutInput),
        metadata: checkoutInput.customFields,
      });
    } catch {
      await releaseCheckoutReservations(input, reserved.reservationIds, ctx.now);
      return null;
    }
  })();
  if (!providerSession) {
    return providerFailed("Checkout provider failed to create a session.");
  }

  const providerCheckoutId = providerSession.providerCheckoutId ?? providerSession.id;
  const checkoutDocument: CheckoutDocument = {
    id: checkoutId,
    type: "checkout",
    schemaVersion: 1,
    cartId: resolved.cart?.id,
    sessionId: ctx.sessionId,
    customerId: ctx.customerId,
    provider: providerName,
    providerCheckoutId,
    status: checkoutDocumentStatus(providerSession.status),
    expiresAt: providerSession.expiresAt ?? expiresAt,
    aggregate: createCheckoutAggregate({
      mode: resolved.mode,
      currency: resolved.currency,
      lines: reserved.lines,
      coupon: resolved.coupon,
      binding: {
        provider: providerName,
        providerCheckoutId,
        providerCustomerId: providerSession.providerCustomerId,
        returnPath: checkoutInput.returnTo ?? ctx.url?.pathname ?? "/",
        cancelPath:
          checkoutInput.cancelPath ?? input.config?.checkout?.cancelUrl ?? "/checkout/cancel",
        successPath:
          checkoutInput.successPath ?? input.config?.checkout?.successUrl ?? "/checkout/success",
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
    resolved.cart,
    checkoutId,
    reserved.lines,
    reserved.reservationIds,
  );
  if (!persisted.ok) return persisted;

  return {
    ok: true,
    status: 200,
    data: {
      id: checkoutId,
      status: providerSession.status,
      mode: providerSession.mode,
      provider: providerSession.provider,
      redirectUrl: providerSession.redirectUrl,
      expiresAt: providerSession.expiresAt ?? checkoutDocument.expiresAt,
      paymentPending: providerSession.status === "pending" ? true : undefined,
    },
    effects: providerSession.redirectUrl
      ? [{ type: "redirect", url: providerSession.redirectUrl }]
      : undefined,
  };
}

async function resolveCheckoutStart(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): Promise<({ readonly ok: true } & CheckoutStartResolution) | MikaApiFailure> {
  const defaultCurrency = defaultBackendCurrency(input);
  const cartResult = await findCheckoutStartCart(input, ctx, checkoutInput.cartId, defaultCurrency);
  if (!cartResult.ok) return cartResult;
  if (cartResult.expired) return checkoutExpired();

  const lines: CheckoutStartLineResolution[] = [];
  const currency = cartResult.cart?.aggregate.currency ?? defaultCurrency;

  for (const cartLine of cartResult.cart?.aggregate.items ?? []) {
    const line = await resolveCheckoutStartLine(input, {
      sellableId: cartLine.item.sellableId,
      priceId: cartLine.item.priceId,
      quantity: cartLine.quantity,
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

  return {
    ok: true,
    cart: cartResult.cart,
    currency,
    mode: modes[0],
    coupon: cartResult.cart?.aggregate.coupon,
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
    return {
      ok: false,
      status: 409,
      error: {
        code: "PRICE_INACTIVE",
        message: `No active price is available for sellable '${sellable.id}'.`,
      },
    };
  }
  if (price.currency !== lineInput.currency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  const stock = await input.repositories.stock.findBySellableId(sellable.id);
  const quantityError = validateQuantityLimit(sellable, stock, lineInput.quantity);
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

    reservationIds.push(reservation.event.id);
    lines.push({ ...resolution.line, reservationId: reservation.event.id });
  }

  return { ok: true, lines, reservationIds };
}

async function persistCheckoutStart(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutDocument: CheckoutDocument,
  cart: CartDocument | null,
  checkoutId: MikaId,
  lines: readonly CheckoutLine[],
  reservationIds: readonly MikaId[],
): Promise<{ readonly ok: true } | MikaApiFailure> {
  let checkoutPersisted = false;

  try {
    await input.repositories.session.put(checkoutDocument);
    checkoutPersisted = true;
    if (cart) {
      await input.repositories.session.put(
        cartWithCheckoutReservations(cart, checkoutId, lines, ctx.now),
      );
    }
  } catch {
    await releaseCheckoutReservations(input, reservationIds, ctx.now);
    if (checkoutPersisted) {
      await markCheckoutPersistenceFailed(input, checkoutDocument, ctx.now);
    }

    return checkoutPersistenceFailed();
  }

  return { ok: true };
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
      updatedAt: now,
      aggregate: {
        ...checkoutDocument.aggregate,
        metadata: checkoutFailedMetadata(checkoutDocument.aggregate.metadata),
      },
    });
  } catch {
    // Best effort: if the local store is unavailable, stock release already compensated inventory.
  }
}

async function releaseCheckoutReservations(
  input: CreateMikaBackendApiInput,
  reservationIds: readonly MikaId[],
  now: ISODateTime,
): Promise<void> {
  const stock = createMikaStockLifecycleService(input);

  for (const reservationEventId of reservationIds) {
    await stock.release({ reservationEventId, now });
  }
}

function checkoutMetadata(input: {
  readonly customFields: JsonObject | undefined;
  readonly idempotencyInputHash?: string;
  readonly idempotencyKey: string | undefined;
  readonly providerSession: {
    readonly status: CheckoutSessionDTO["status"];
    readonly redirectUrl?: string;
  };
}): JsonObject {
  return {
    ...checkoutCustomMetadata(input.customFields),
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

function checkoutCustomMetadata(customFields: JsonObject | undefined): JsonObject {
  return Object.fromEntries(
    Object.entries(customFields ?? {}).filter(([key]) => !CHECKOUT_INTERNAL_METADATA_KEYS.has(key)),
  ) as JsonObject;
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
  return metadataString(document.aggregate.metadata, CHECKOUT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY);
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
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
  checkoutId: MikaId,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const bindingError = checkoutBindingError(document);
  if (bindingError) return bindingError;

  if (checkoutIsExpired(input, document)) return checkoutStatusExpired(document);

  return checkoutDocumentSuccessResult(document);
}

function checkoutDocumentSuccessResult(
  document: CheckoutDocument,
): MikaApiResult<CheckoutSessionDTO> {
  const redirectUrl = metadataString(document.aggregate.metadata, "checkoutRedirectUrl");
  const status =
    metadataString(document.aggregate.metadata, "checkoutProviderStatus") ??
    checkoutSessionStatus(document.status);
  const orderId = metadataMikaId(document.aggregate.metadata, "checkoutOrderId");

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      status: checkoutSessionStatus(status),
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

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

function metadataMikaId(metadata: JsonObject | undefined, key: string): MikaId | undefined {
  const value = metadataString(metadata, key);

  return value ? createMikaId(value) : undefined;
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

  return {
    ...updated,
    status: "checkout_pending",
    aggregate: {
      ...updated.aggregate,
      metadata: {
        ...updated.aggregate.metadata,
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
    metadata: line.metadata ?? line.item.metadata,
  };
}

function checkoutSuccessUrl(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
  checkoutId: MikaId,
): string {
  const url = new URL(
    checkoutInput.successPath ?? input.config?.checkout?.successUrl ?? "/checkout/success",
    ctx.url ?? "http://mika.local",
  );
  url.searchParams.set("checkoutId", checkoutId);

  return url.toString();
}

function checkoutCancelUrl(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  checkoutInput: StartCheckoutInput,
): string {
  return new URL(
    checkoutInput.cancelPath ?? input.config?.checkout?.cancelUrl ?? "/checkout/cancel",
    ctx.url ?? "http://mika.local",
  ).toString();
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
  const inputHash = await input.hash(
    JSON.stringify(checkoutPreviewProofProjection(previewInput, quote, mode, provider)),
  );
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

function checkoutPreviewProofProjection(
  previewInput: CheckoutPreviewInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
) {
  return {
    quoteId: previewInput.quoteId,
    provider,
    mode,
    customer: previewInput.customer,
    customFields: previewInput.customFields,
    successPath: previewInput.successPath,
    cancelPath: previewInput.cancelPath,
    returnTo: previewInput.returnTo,
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
  };
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

async function findQuoteCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  cartId: MikaId | undefined,
  currency: CurrencyCode,
): Promise<{ readonly cart: CartDocument | null; readonly expired: boolean }> {
  const cart = cartId
    ? await findOwnedCartById(input, ctx, cartId)
    : await findOpenCart(input, ctx, currency);
  if (!cart) return { cart: null, expired: false };

  const expired =
    cart.status === "expired" ||
    (cart.expiresAt !== undefined &&
      new Date(cart.expiresAt).getTime() <= new Date(ctx.now).getTime());

  return { cart, expired };
}

async function findOwnedCartById(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  cartId: MikaId,
): Promise<CartDocument | null> {
  const document = await input.repositories.session.findById(cartId);
  if (!document || document.type !== "cart") return null;
  if (document.customerId && document.customerId !== ctx.customerId) return null;
  if (!document.customerId && document.sessionId && document.sessionId !== ctx.sessionId)
    return null;

  return document;
}

async function quoteCartLine(
  input: MikaCartWishlistBackendInput,
  line: CartLine,
): Promise<{
  readonly line: CartQuoteLineDTO;
  readonly changed: boolean;
  readonly unavailable: boolean;
}> {
  const catalog = await input.repositories.catalog.findItemBySellableId(line.item.sellableId);
  const sellable = catalog?.aggregate.sellables.find((item) => item.id === line.item.sellableId);
  const stock = await input.repositories.stock.findBySellableId(line.item.sellableId);
  const availability = sellable ? stockAvailabilityToDTO(sellable, stock ?? undefined) : undefined;
  const warnings: string[] = [];
  let changed = false;
  let unavailable = false;
  let unitAmount = line.item.unitAmount;
  let title = line.item.titleSnapshot;
  let sku = line.item.sku;
  let variantOptions = line.item.variantOptions;

  if (!sellable?.active) {
    unavailable = true;
    warnings.push(`Sellable '${line.item.sellableId}' is unavailable.`);
  } else {
    const price = selectCartPrice(sellable, line.item.priceId, line.item.currency);
    if (!price) {
      unavailable = true;
      warnings.push(`Price for sellable '${sellable.id}' is unavailable.`);
    } else {
      title = price.titleSnapshot ?? sellable.titleSnapshot ?? title;
      sku = price.sku ?? sellable.sku;
      variantOptions = sellable.variantOptions;
      if (
        price.amount !== line.item.unitAmount ||
        title !== line.item.titleSnapshot ||
        sku !== line.item.sku
      ) {
        changed = true;
        warnings.push("Line details changed since it was added to the cart.");
      }
      unitAmount = price.amount;
    }

    const quantityError = validateQuantityLimit(sellable, stock, line.quantity);
    if (quantityError) {
      unavailable = true;
      warnings.push(quantityError.error.message);
    }
  }

  const subtotalAmount = unitAmount * line.quantity;

  return {
    line: {
      lineId: line.id,
      sellableId: line.item.sellableId,
      priceId: line.item.priceId,
      title,
      sku,
      variantOptions,
      quantity: line.quantity,
      unitAmount: moneyDTO(unitAmount, line.item.currency),
      subtotal: moneyDTO(subtotalAmount, line.item.currency),
      total: moneyDTO(subtotalAmount, line.item.currency),
      availability,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    changed,
    unavailable,
  };
}

async function quoteInputLine(
  input: MikaCartWishlistBackendInput,
  quoteInput: CartQuoteInput,
  currency: CurrencyCode,
): Promise<{
  readonly line: CartQuoteLineDTO;
  readonly unavailable: boolean;
}> {
  const quantity = quoteInput.quantity ?? 1;
  const catalog = quoteInput.sellableId
    ? await input.repositories.catalog.findItemBySellableId(quoteInput.sellableId)
    : null;
  const sellable = catalog?.aggregate.sellables.find((item) => item.id === quoteInput.sellableId);
  const stock = quoteInput.sellableId
    ? await input.repositories.stock.findBySellableId(quoteInput.sellableId)
    : null;
  const availability = sellable ? stockAvailabilityToDTO(sellable, stock ?? undefined) : undefined;
  const warnings: string[] = [];
  let unavailable = false;
  let price: PriceDefinition | null = null;

  if (!sellable?.active) {
    unavailable = true;
    warnings.push(`Sellable '${quoteInput.sellableId}' is unavailable.`);
  } else {
    price = selectCartPrice(sellable, quoteInput.priceId, currency);
    if (!price) {
      unavailable = true;
      warnings.push(`Price for sellable '${sellable.id}' is unavailable.`);
    }
    const quantityError = validateQuantityLimit(sellable, stock, quantity);
    if (quantityError) {
      unavailable = true;
      warnings.push(quantityError.error.message);
    }
  }

  const unitAmount = price?.amount ?? 0;
  const subtotalAmount = unitAmount * quantity;

  return {
    line: {
      sellableId: quoteInput.sellableId ?? createMikaId("sellable_missing"),
      priceId: price?.id ?? quoteInput.priceId,
      title: sellable?.titleSnapshot,
      sku: price?.sku ?? sellable?.sku,
      variantOptions: sellable?.variantOptions,
      quantity,
      unitAmount: price ? moneyDTO(unitAmount, currency) : undefined,
      subtotal: price ? moneyDTO(subtotalAmount, currency) : undefined,
      total: price ? moneyDTO(subtotalAmount, currency) : undefined,
      availability,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    unavailable,
  };
}

function moneyDTO(amount: number, currency: CurrencyCode): MoneyDTO {
  return { amount, currency };
}

async function findOpenCartBySessionAnyCurrency(
  input: MikaCartWishlistBackendInput,
  sessionId: string,
): Promise<CartDocument | null> {
  const collection = (
    input.repositories.session as unknown as {
      readonly collection?: {
        query(options: {
          readonly where: {
            readonly type: "cart";
            readonly sessionId: string;
            readonly status: "open";
          };
          readonly limit: number;
        }): Promise<{ readonly items: readonly { readonly data: SessionDocument }[] }>;
      };
    }
  ).collection;

  if (!collection) return null;

  const result = await collection.query({
    where: { type: "cart", sessionId, status: "open" },
    limit: 1,
  });
  const document = result.items[0]?.data;

  return document?.type === "cart" ? document : null;
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
    aggregate: createCartAggregate({ currency }),
    createdAt: now,
    updatedAt: now,
  };
}

function updateCartDocument(
  cart: CartDocument,
  items: readonly CartLine[],
  updatedAt: ISODateTime,
  coupon?: CouponSnapshot,
): CartDocument {
  return {
    ...cart,
    updatedAt,
    aggregate: cartWithItems({ cart: cart.aggregate, items, coupon }),
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

  if (ctx.customerId) {
    if (document.customerId !== ctx.customerId) {
      return invalidCart(field, cartId);
    }
  } else if (ctx.sessionId && document.sessionId !== ctx.sessionId) {
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
    const quantityError = await validateExistingLineQuantity(input, sourceLine, nextQuantity);
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
  const quantityError = await validateExistingLineQuantity(input, nextLine, nextQuantity);
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
  if (!sellable) return null;

  const stock = await input.repositories.stock.findBySellableId(line.item.sellableId);
  return validateQuantityLimit(sellable, stock, quantity);
}

async function createCouponSnapshot(
  input: MikaCartWishlistBackendInput,
  cart: CartDocument,
  code: string,
): Promise<CouponSnapshot> {
  const normalizedCode = code.toUpperCase();
  const subtotalAmount = cart.aggregate.items.reduce(
    (sum, line) => sum + line.item.unitAmount * line.quantity,
    0,
  );

  return {
    codeHash: await input.hash(`coupon:${normalizedCode}`),
    label: normalizedCode,
    discountAmount: Math.floor(subtotalAmount * 0.1),
  };
}

async function cartDocumentToDTO(
  input: MikaCartWishlistBackendInput,
  cart: CartDocument,
): Promise<CartDTO> {
  const stockRecords = await Promise.all(
    cart.aggregate.items.map(async (line) => ({
      sellableId: line.item.sellableId,
      stock: await input.repositories.stock.findBySellableId(line.item.sellableId),
    })),
  );
  const availabilityBySellableId = new Map(
    stockRecords
      .flatMap((record) =>
        record.stock
          ? [
              [
                record.sellableId,
                stockAvailabilityToDTO(
                  {
                    id: record.sellableId,
                    active: true,
                    sortOrder: 0,
                    variantOptions: [],
                    prices: [],
                  },
                  record.stock,
                ),
              ] as const,
            ]
          : [],
      )
      .filter((entry): entry is readonly [MikaId, NonNullable<(typeof entry)[1]>] =>
        Boolean(entry[1]),
      ),
  );

  return cartToDTO({
    id: cart.id,
    status: cart.status,
    cart: cart.aggregate,
    availabilityBySellableId,
  });
}

async function wishlistDocumentToDTO(
  input: MikaCartWishlistBackendInput,
  wishlist: WishlistDocument,
): Promise<WishlistDTO> {
  const stockRecords = await Promise.all(
    wishlist.aggregate.items.map(async (item) => ({
      sellableId: item.item.sellableId,
      stock: await input.repositories.stock.findBySellableId(item.item.sellableId),
    })),
  );
  const availabilityBySellableId = new Map(
    stockRecords
      .flatMap((record) =>
        record.stock
          ? [
              [
                record.sellableId,
                stockAvailabilityToDTO(
                  {
                    id: record.sellableId,
                    active: true,
                    sortOrder: 0,
                    variantOptions: [],
                    prices: [],
                  },
                  record.stock,
                ),
              ] as const,
            ]
          : [],
      )
      .filter((entry): entry is readonly [MikaId, NonNullable<(typeof entry)[1]>] =>
        Boolean(entry[1]),
      ),
  );

  return wishlistToDTO({
    id: wishlist.id,
    wishlist: wishlist.aggregate,
    availabilityBySellableId,
  });
}

async function resolveCartLine(
  input: MikaCartWishlistBackendInput,
  itemInput: AddCartItemInput,
  cartCurrency: CurrencyCode,
): Promise<
  | {
      readonly ok: true;
      readonly line: CartLine;
      readonly sellable: SellableDefinition;
      readonly stock: StockItemRecord | null;
    }
  | MikaApiFailure
> {
  const quantity = itemInput.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    return validationFailed("quantity", "Quantity must be a positive whole number.");
  }

  const catalog = await input.repositories.catalog.findItemBySellableId(itemInput.sellableId);
  if (!catalog) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: `Sellable '${itemInput.sellableId}' was not found.`,
      },
    };
  }

  const sellable = catalog.aggregate.sellables.find((item) => item.id === itemInput.sellableId);
  if (!sellable?.active) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELLABLE_INACTIVE",
        message: `Sellable '${itemInput.sellableId}' is inactive.`,
      },
    };
  }

  if (itemInput.variantKey && itemInput.variantKey !== sellable.variantKey) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VARIANT_INVALID",
        message: `Variant '${itemInput.variantKey}' is not valid for sellable '${sellable.id}'.`,
      },
    };
  }
  if (!variantOptionsMatch(sellable, itemInput.variantOptions)) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "VARIANT_INVALID",
        message: `Variant options are not valid for sellable '${sellable.id}'.`,
      },
    };
  }

  const price = selectCartPrice(sellable, itemInput.priceId, cartCurrency);
  if (!price) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PRICE_INACTIVE",
        message: `No active price is available for sellable '${sellable.id}'.`,
      },
    };
  }
  if (price.currency !== cartCurrency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  const stock = await input.repositories.stock.findBySellableId(sellable.id);
  const quantityError = validateQuantityLimit(sellable, stock, quantity);
  if (quantityError) return quantityError;

  return {
    ok: true,
    line: {
      id: input.createId("cart_line"),
      item: snapshotPrice({
        content: catalog.aggregate.content,
        sellable,
        price,
        fallbackTitle: catalog.aggregate.titleSnapshot ?? sellable.id,
      }),
      quantity,
      addedAt: currentBackendISODateTime(input),
    },
    sellable,
    stock,
  };
}

async function resolveWishlistItem(
  input: MikaCartWishlistBackendInput,
  itemInput: WishlistItemInput,
): Promise<
  | {
      readonly ok: true;
      readonly item: WishlistItem;
    }
  | MikaApiFailure
> {
  const currency = defaultBackendCurrency(input);
  const catalog = await input.repositories.catalog.findItemBySellableId(itemInput.sellableId);
  if (!catalog) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SELLABLE_NOT_FOUND",
        message: `Sellable '${itemInput.sellableId}' was not found.`,
      },
    };
  }

  const sellable = catalog.aggregate.sellables.find((item) => item.id === itemInput.sellableId);
  if (!sellable?.active) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELLABLE_INACTIVE",
        message: `Sellable '${itemInput.sellableId}' is inactive.`,
      },
    };
  }

  const price = selectCartPrice(sellable, itemInput.priceId, currency);
  if (!price) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PRICE_INACTIVE",
        message: `No active price is available for sellable '${sellable.id}'.`,
      },
    };
  }
  if (price.currency !== currency) {
    return validationFailed("priceId", `Price '${price.id}' uses currency '${price.currency}'.`);
  }

  return {
    ok: true,
    item: {
      id: input.createId("wishlist_item"),
      item: snapshotPrice({
        content: catalog.aggregate.content,
        sellable,
        price,
        fallbackTitle: catalog.aggregate.titleSnapshot ?? sellable.id,
      }),
      addedAt: currentBackendISODateTime(input),
    },
  };
}

function selectCartPrice(
  sellable: SellableDefinition,
  priceId: MikaId | undefined,
  currency: CurrencyCode,
): PriceDefinition | null {
  const price = priceId
    ? sellable.prices.find((item) => item.id === priceId)
    : sellable.prices.find((item) => item.active && item.currency === currency);

  return price?.active ? price : null;
}

function validateQuantityLimit(
  sellable: SellableDefinition,
  stock: StockItemRecord | null,
  quantity: number,
): MikaApiFailure | null {
  if (sellable.maxPerOrder !== undefined && quantity > sellable.maxPerOrder) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "MAX_PER_ORDER_EXCEEDED",
        message: `Sellable '${sellable.id}' allows at most ${sellable.maxPerOrder} per order.`,
      },
    };
  }

  if (stock) {
    const availability = stockAvailabilityToDTO(sellable, stock);
    const availableQuantity =
      availability?.status === "available" || availability?.status === "low_stock"
        ? availability.availableQuantity
        : undefined;
    if (
      availability?.status === "out_of_stock" ||
      (availableQuantity !== undefined && quantity > availableQuantity)
    ) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "OUT_OF_STOCK",
          message: `Sellable '${sellable.id}' does not have enough stock.`,
        },
      };
    }
  }

  return null;
}

function isEquivalentCartLine(left: CartLine, right: CartLine): boolean {
  return (
    left.item.sellableId === right.item.sellableId &&
    left.item.priceId === right.item.priceId &&
    left.item.variantKey === right.item.variantKey
  );
}

function isEquivalentWishlistItem(left: WishlistItem, right: WishlistItem): boolean {
  return (
    left.item.sellableId === right.item.sellableId &&
    left.item.priceId === right.item.priceId &&
    left.item.variantKey === right.item.variantKey
  );
}

function variantOptionsMatch(
  sellable: SellableDefinition,
  variantOptions: Record<string, string> | undefined,
): boolean {
  if (!variantOptions || Object.keys(variantOptions).length === 0) return true;

  return Object.entries(variantOptions).every(([option, value]) =>
    sellable.variantOptions.some((item) => item.option === option && item.value === value),
  );
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
  const fullRefund = refundInput.amount === undefined || refundInput.amount >= order.totalAmount;
  const status = fullRefund ? "refunded" : "partially_refunded";

  return {
    ...order,
    status,
    paymentStatus: status,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      metadata: {
        ...order.aggregate.metadata,
        lastAdminAction: "order.refund",
        ...(refundInput.amount !== undefined ? { refundAmount: refundInput.amount } : {}),
        ...(refundInput.reason ? { refundReason: refundInput.reason } : {}),
      },
    },
  };
}

function updateOrderAfterCancel(
  order: OrderDocument,
  cancelInput: OrderCancelInput,
  now: ISODateTime,
): OrderDocument {
  return {
    ...order,
    status: "cancelled",
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      metadata: {
        ...order.aggregate.metadata,
        lastAdminAction: "order.cancel",
        ...(cancelInput.reason ? { cancelReason: cancelInput.reason } : {}),
      },
    },
  };
}

function currentBackendISODateTime(
  input: Pick<MikaBackendDependencies, "isoNow" | "now">,
): ISODateTime {
  return input.isoNow?.() ?? createISODateTime(input.now().toISOString());
}

function addMilliseconds(value: ISODateTime, milliseconds: number): ISODateTime {
  return createISODateTime(new Date(Date.parse(value) + milliseconds).toISOString());
}

function checkoutEmpty(): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_EMPTY",
      message: "Checkout requires at least one cart line.",
    },
  };
}

function checkoutExpired(): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CHECKOUT_EXPIRED",
      message: "Checkout cannot start from an expired cart.",
    },
  };
}

function checkoutIdempotencyInProgress(): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: "Checkout idempotency replay is already in progress.",
    },
  };
}

function checkoutIdempotencyInputMismatch(): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: "Checkout idempotency key was reused with different input.",
    },
  };
}

function checkoutPersistenceFailed(): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: "Checkout could not be persisted after provider handoff.",
    },
  };
}

function checkoutFailedReplay(checkoutId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: `Checkout '${checkoutId}' failed and cannot be replayed.`,
    },
  };
}

function outOfStock(sellableId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "OUT_OF_STOCK",
      message: `Sellable '${sellableId}' does not have enough stock.`,
    },
  };
}

function providerUnsupported(provider: ProviderName): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "PROVIDER_UNSUPPORTED",
      message: `Provider '${provider}' does not support hosted checkout.`,
    },
  };
}

function providerUnsupportedForAction(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "PROVIDER_UNSUPPORTED",
      message,
    },
  };
}

function providerFailed(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 502,
    error: {
      code: "PROVIDER_FAILED",
      message,
    },
  };
}

function orderNotFound(orderId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `Order '${orderId}' was not found.`,
      fieldErrors: { orderId: "Order was not found." },
    },
  };
}

function createAdminAuditDocument(
  input: CreateMikaBackendApiInput,
  record: Omit<AdminAuditDocument["record"], "id">,
): AdminAuditDocument {
  const id = input.createId("admin_audit");

  return {
    id,
    type: "adminAudit",
    schemaVersion: 1,
    actorId: record.actorId,
    targetType: record.targetType,
    targetId: record.targetId,
    status: record.status,
    record: {
      id,
      ...record,
    },
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  };
}

function webhookInvalid(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 400,
    error: {
      code: "WEBHOOK_INVALID",
      message,
    },
  };
}

function validationFailed(field: string, message: string): MikaApiFailure {
  return {
    ok: false,
    status: 422,
    error: {
      code: "VALIDATION_FAILED",
      message: "Mika input validation failed.",
      fieldErrors: { [field]: message },
    },
  };
}

function cartLineNotFound(lineId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `Cart line '${lineId}' was not found.`,
      fieldErrors: { lineId: "Cart line was not found." },
    },
  };
}

function wishlistItemNotFound(itemId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `Wishlist item '${itemId}' was not found.`,
      fieldErrors: { itemId: "Wishlist item was not found." },
    },
  };
}

function invalidCart(field: string, cartId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `Cart '${cartId}' was not found.`,
      fieldErrors: { [field]: "Open cart was not found." },
    },
  };
}

function invalidCheckout(field: string, checkoutId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `Checkout '${checkoutId}' was not found.`,
      fieldErrors: { [field]: "Checkout was not found." },
    },
  };
}

function invalidWishlist(field: string, wishlistId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 404,
    error: {
      code: "VALIDATION_FAILED",
      message: `Wishlist '${wishlistId}' was not found.`,
      fieldErrors: { [field]: "Active wishlist was not found." },
    },
  };
}
