import type { MikaProviderRegistry } from "../provider";
import type {
  ConsumeReservedStockRepositoryResult,
  MikaRepositories,
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
  createWishlistAggregate,
  snapshotPrice,
  stockAvailabilityToDTO,
  wishlistToDTO,
} from "../model/builders";
import type {
  CartLine,
  CouponSnapshot,
  PriceDefinition,
  SellableDefinition,
  WishlistItem,
} from "../types/aggregates";
import type { CartDocument, SessionDocument, WishlistDocument } from "../types/documents";
import { createCurrencyCode, createISODateTime, createMikaId } from "../types/primitives";
import type {
  CurrencyCode,
  ISODateTime,
  JsonObject,
  MikaId,
  ProviderName,
} from "../types/primitives";
import type { StockItemRecord } from "../types/operational";
import type { MikaRequestContext } from "./context";
import { createMikaApi, type MikaApi, type MikaApiOverrides } from "./server";
import type {
  AddCartItemInput,
  CartDTO,
  MikaApiResult,
  WishlistDTO,
  WishlistItemInput,
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

export interface MikaStockLifecycleService {
  reserve(input: ReserveStockInput): Promise<ReserveStockResult>;
  release(input: ReleaseReservedStockInput): Promise<ReleaseReservedStockResult>;
  consume(input: ConsumeReservedStockInput): Promise<ConsumeReservedStockResult>;
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
    cart: {
      get: async (ctx) => {
        const cart = await findOrCreateOpenCart(input, ctx);

        return { ok: true, status: 200, data: await cartDocumentToDTO(input, cart) };
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
  });
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

function currentBackendISODateTime(input: MikaBackendDependencies): ISODateTime {
  return input.isoNow?.() ?? createISODateTime(input.now().toISOString());
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
