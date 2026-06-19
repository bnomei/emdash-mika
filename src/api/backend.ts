import type { MikaProviderRegistry } from "../provider";
import type { MikaRepositories } from "../storage/repositories";
import {
  cartToDTO,
  cartWithItems,
  catalogSellablesToDTO,
  createCartAggregate,
  snapshotPrice,
  stockAvailabilityToDTO,
} from "../model/builders";
import type { CartLine, PriceDefinition, SellableDefinition } from "../types/aggregates";
import type { CartDocument } from "../types/documents";
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
import type { AddCartItemInput, CartDTO, MikaApiResult } from "./types";

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
      ...input.overrides?.cart,
    },
  });
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
): CartDocument {
  return {
    ...cart,
    updatedAt,
    aggregate: cartWithItems({ cart: cart.aggregate, items }),
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
      addedAt: input.isoNow?.() ?? createISODateTime(input.now().toISOString()),
    },
    sellable,
    stock,
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

function variantOptionsMatch(
  sellable: SellableDefinition,
  variantOptions: Record<string, string> | undefined,
): boolean {
  if (!variantOptions || Object.keys(variantOptions).length === 0) return true;

  return Object.entries(variantOptions).every(([option, value]) =>
    sellable.variantOptions.some((item) => item.option === option && item.value === value),
  );
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
