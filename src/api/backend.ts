import type {
  MikaProviderLineItem,
  MikaProviderRegistry,
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
  createWishlistAggregate,
  snapshotPrice,
  stockAvailabilityToDTO,
  wishlistToDTO,
} from "../model/builders";
import type {
  CartLine,
  CheckoutLine,
  CouponSnapshot,
  PriceDefinition,
  SellableDefinition,
  WishlistItem,
} from "../types/aggregates";
import type {
  CartDocument,
  CheckoutDocument,
  SessionDocument,
  WebhookDocument,
  WishlistDocument,
} from "../types/documents";
import { createCurrencyCode, createISODateTime, createMikaId } from "../types/primitives";
import type {
  CheckoutStatus,
  CurrencyCode,
  ISODateTime,
  JsonObject,
  MikaId,
  ProviderName,
  PurchaseMode,
} from "../types/primitives";
import type { StockItemRecord } from "../types/operational";
import type { MikaRequestContext } from "./context";
import { createMikaApi, type MikaApi, type MikaApiOverrides } from "./server";
import type {
  AddCartItemInput,
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
  StartCheckoutInput,
  StockAdjustInput,
  WishlistDTO,
  WishlistItemInput,
  WebhookReceiveDTO,
  WebhookReceiveInput,
} from "./types";

type MikaApiFailure = Extract<MikaApiResult<never>, { readonly ok: false }>;

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
      ...input.overrides?.admin,
    },
    cart: {
      get: async (ctx) => {
        const cart = await findOrCreateOpenCart(input, ctx);

        return { ok: true, status: 200, data: await cartDocumentToDTO(input, cart) };
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
        const quantityError = validateQuantityLimit(
          resolved.sellable,
          resolved.stock,
          nextQuantity,
        );
        if (quantityError) return quantityError;

        const cart = existing ?? createCartDocument(input, ctx, currency);
        const items = existingLine
          ? currentItems.map((line) =>
              line.id === existingLine.id ? { ...line, quantity: nextQuantity } : line,
            )
          : [...currentItems, resolved.line];
        const updated = updateCartDocument(cart, items, ctx.now);

        await input.repositories.session.put(updated);

        return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
      },
      update: async (ctx, itemInput) => {
        if (!Number.isInteger(itemInput.quantity) || itemInput.quantity < 1) {
          return validationFailed("quantity", "Quantity must be a positive whole number.");
        }

        const cart = await findOrCreateOpenCart(input, ctx);
        const line = cart.aggregate.items.find((item) => item.id === itemInput.lineId);
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
          cart,
          cart.aggregate.items.map((item) =>
            item.id === itemInput.lineId ? { ...item, quantity: itemInput.quantity } : item,
          ),
          ctx.now,
        );

        await input.repositories.session.put(updated);

        return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
      },
      remove: async (ctx, itemInput) => {
        const cart = await findOrCreateOpenCart(input, ctx);
        if (!cart.aggregate.items.some((item) => item.id === itemInput.lineId)) {
          return cartLineNotFound(itemInput.lineId);
        }

        const updated = updateCartDocument(
          cart,
          cart.aggregate.items.filter((item) => item.id !== itemInput.lineId),
          ctx.now,
        );

        await input.repositories.session.put(updated);

        return { ok: true, status: 200, data: await cartDocumentToDTO(input, updated) };
      },
      merge: async (ctx, mergeInput) => {
        const currency = input.defaults?.currency ?? createCurrencyCode("EUR");
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
      ...input.overrides?.cart,
    },
    wishlist: {
      get: async (ctx) => {
        const wishlist = await findOrCreateActiveWishlist(input, ctx);

        return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, wishlist) };
      },
      add: async (ctx, itemInput) => {
        const resolved = await resolveWishlistItem(input, itemInput);
        if (!resolved.ok) return resolved;

        const wishlist = await findOrCreateActiveWishlist(input, ctx);
        const existingItem = wishlist.aggregate.items.find((item) =>
          isEquivalentWishlistItem(item, resolved.item),
        );
        const items = existingItem
          ? wishlist.aggregate.items
          : [...wishlist.aggregate.items, resolved.item];
        const updated = updateWishlistDocument(wishlist, items, ctx.now);

        await input.repositories.session.put(updated);

        return { ok: true, status: 200, data: await wishlistDocumentToDTO(input, updated) };
      },
      remove: async (ctx, itemInput) => {
        const wishlist = await findOrCreateActiveWishlist(input, ctx);
        if (!wishlist.aggregate.items.some((item) => item.id === itemInput.itemId)) {
          return wishlistItemNotFound(itemInput.itemId);
        }

        const updated = updateWishlistDocument(
          wishlist,
          wishlist.aggregate.items.filter((item) => item.id !== itemInput.itemId),
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

        const wishlist = await findOrCreateActiveWishlist(input, ctx);
        const item = wishlist.aggregate.items.find(
          (candidate) => candidate.id === itemInput.itemId,
        );
        if (!item) {
          return wishlistItemNotFound(itemInput.itemId);
        }

        const currency = input.defaults?.currency ?? createCurrencyCode("EUR");
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
          wishlist,
          wishlist.aggregate.items.filter((candidate) => candidate.id !== item.id),
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

        const wishlist = await findOrCreateActiveWishlist(input, ctx);
        const item: WishlistItem = {
          id: input.createId("wishlist_item"),
          item: line.item,
          addedAt: ctx.now,
          metadata: line.metadata,
        };
        const wishlistItems = mergeWishlistItems(wishlist.aggregate.items, [item]);
        const updatedWishlist = updateWishlistDocument(wishlist, wishlistItems, ctx.now);
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
      ...input.overrides?.wishlist,
    },
    checkout: {
      start: async (ctx, checkoutInput) => startCheckout(input, ctx, checkoutInput),
      status: async (statusInput) => checkoutStatus(input, createMikaId(statusInput.checkoutId)),
      preview: async (ctx, previewInput) => {
        const preview = await createCheckoutPreview(input, ctx, previewInput);

        return { ok: true, status: 200, data: preview };
      },
      ...input.overrides?.checkout,
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

  return {
    ok: true,
    status: 200,
    data: {
      id: webhook.id,
      status: "received",
      replayable: true,
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
    rawPayloadJson: verified.parsed ?? event.raw,
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
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<WishlistDocument> {
  const existing = await findActiveWishlist(input, ctx);
  if (existing) return existing;

  const wishlist = createWishlistDocument(input, ctx);
  await input.repositories.session.put(wishlist);

  return wishlist;
}

async function findActiveWishlist(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<WishlistDocument | null> {
  if (ctx.customerId) {
    return input.repositories.session.findWishlistByCustomer(ctx.customerId);
  }

  return ctx.sessionId ? input.repositories.session.findWishlistBySession(ctx.sessionId) : null;
}

async function findOwnedActiveWishlistById(
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
): Promise<CartDocument> {
  const currency = input.defaults?.currency ?? createCurrencyCode("EUR");
  const existing = await findOpenCart(input, ctx, currency);
  if (existing) return existing;

  const cart = createCartDocument(input, ctx, currency);
  await input.repositories.session.put(cart);

  return cart;
}

async function findOpenCart(
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  quoteInput: CartQuoteInput,
): Promise<CartQuoteDTO> {
  const defaultCurrency = input.defaults?.currency ?? createCurrencyCode("EUR");
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
  const replayedCheckout = ctx.idempotencyKey
    ? await input.repositories.session.findCheckoutByIdempotencyKey(ctx.idempotencyKey)
    : null;
  if (replayedCheckout) return checkoutDocumentResult(replayedCheckout);

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
      metadata: checkoutMetadata(checkoutInput.customFields, ctx.idempotencyKey, providerSession),
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
  const defaultCurrency = input.defaults?.currency ?? createCurrencyCode("EUR");
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

function checkoutMetadata(
  customFields: JsonObject | undefined,
  idempotencyKey: string | undefined,
  providerSession: {
    readonly status: CheckoutSessionDTO["status"];
    readonly redirectUrl?: string;
  },
): JsonObject {
  return {
    ...customFields,
    checkoutProviderStatus: providerSession.status,
    ...(idempotencyKey ? { checkoutIdempotencyKey: idempotencyKey } : {}),
    ...(providerSession.redirectUrl ? { checkoutRedirectUrl: providerSession.redirectUrl } : {}),
  };
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
      ? selectCartPrice(
          sellable,
          previewInput.priceId,
          input.defaults?.currency ?? createCurrencyCode("EUR"),
        )?.mode
      : undefined;
  }

  const cartResult = await findQuoteCart(
    input,
    ctx,
    previewInput.cartId,
    input.defaults?.currency ?? createCurrencyCode("EUR"),
  );
  const modes = new Set(cartResult.cart?.aggregate.items.map((line) => line.item.mode) ?? []);
  return modes.size === 1 ? modes.values().next().value : undefined;
}

async function findQuoteCart(
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
  itemInput: WishlistItemInput,
): Promise<
  | {
      readonly ok: true;
      readonly item: WishlistItem;
    }
  | MikaApiFailure
> {
  const currency = input.defaults?.currency ?? createCurrencyCode("EUR");
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

function currentBackendISODateTime(input: MikaBackendDependencies): ISODateTime {
  return input.isoNow?.() ?? createISODateTime(input.now().toISOString());
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
