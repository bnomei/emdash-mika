/**
 * Cart API implementation and the CAS-based cart-document mutation helpers it (and checkout
 * reservation flows) build on: creating/finding the caller's open cart, blind-write conflict
 * detection, cart-line merge for session-to-account cart merges, and the concurrency-safe
 * first-line cart creation used when adding to a cart that doesn't exist yet.
 */
import { omitUndefined } from "../../internal/object";
import { createCartAggregate, cartWithCoupon, cartWithoutCoupon } from "../../model/builders";
import { nextCartVersion } from "../../model/cart-version";
import { findSessionRepositoryOpenCartBySessionAnyCurrency } from "../../storage/repositories/session";
import type { CartLine, SellableDefinition } from "../../types/aggregates";
import type { CartDocument } from "../../types/documents";
import type { StockItemRecord } from "../../types/operational";
import { createISODateTime } from "../../types/primitives";
import type { CurrencyCode, MikaId } from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import type { MikaApi } from "../server";
import type { CartDTO, MikaApiResult } from "../types";
import {
  apiFailure,
  cartLineNotFound,
  invalidCart,
  observeBackendError,
  sellableNotFound,
  validationFailed,
} from "./errors";
import type { MikaApiFailure } from "./errors";
import { hydratedCartOverrides, withHydratedCustomerHandler } from "./identity";
import {
  callerOwnsMergeSource,
  cartDocumentToDTO,
  couponRejectionMessage,
  createCartQuote,
  createCouponSnapshot,
  findOpenCart,
  isEquivalentCartLine,
  resolveCartLine,
  siblingSellableQuantity,
  updateCartDocument,
  validateQuantityLimit,
} from "./quote";
import type { MikaCartWishlistBackendInput } from "./quote";
import type { CreateMikaBackendApiInput } from "./ports";
import { addMilliseconds, defaultBackendCurrency } from "./shared";

export function createCartBackend(
  input: MikaCartWishlistBackendInput & Pick<CreateMikaBackendApiInput, "overrides">,
): MikaApi["cart"] {
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

export async function findOrCreateOpenCart(
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

export function cartWriteBlocked(cart: CartDocument): MikaApiFailure | null {
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

async function findOpenCartBySessionAnyCurrency(
  input: MikaCartWishlistBackendInput,
  sessionId: string,
): Promise<CartDocument | null> {
  return findSessionRepositoryOpenCartBySessionAnyCurrency(input.repositories.session, sessionId);
}

export function createCartDocument(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
): CartDocument {
  const now = ctx.now;

  return omitUndefined({
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
  });
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

export async function mergeCartLine(
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
