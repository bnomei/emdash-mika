/**
 * Wishlist API implementation and the wishlist-document helpers it builds on: creating/finding
 * the caller's active wishlist, and merging wishlist items for session-to-account wishlist
 * merges. Move-to-cart and save-for-later cross into the cart document helpers from ./cart.
 */
import { omitUndefined } from "../../internal/object";
import { createWishlistAggregate } from "../../model/builders";
import { nextWishlistVersion } from "../../model/wishlist-version";
import type { CartLine, WishlistItem } from "../../types/aggregates";
import type { CartDocument, WishlistDocument } from "../../types/documents";
import { createISODateTime } from "../../types/primitives";
import type { CurrencyCode, ISODateTime, MikaId } from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import type { MikaApi } from "../server";
import { cartWriteBlocked, createCartDocument, findOrCreateOpenCart, mergeCartLine } from "./cart";
import {
  apiFailure,
  cartLineNotFound,
  invalidWishlist,
  observeBackendError,
  validationFailed,
  wishlistItemNotFound,
} from "./errors";
import type { MikaApiFailure } from "./errors";
import { hydratedWishlistOverrides, withHydratedCustomerHandler } from "./identity";
import type { MikaCartWishlistBackendInput } from "./quote";
import type { CreateMikaBackendApiInput } from "./ports";
import {
  callerOwnsMergeSource,
  cartDocumentToDTO,
  findOpenCart,
  isEquivalentCartLine,
  isEquivalentWishlistItem,
  resolveWishlistItem,
  updateCartDocument,
  wishlistDocumentToDTO,
} from "./quote";
import { addMilliseconds, defaultBackendCurrency } from "./shared";

const WISHLIST_MOVE_IDS_METADATA_KEY = "mikaWishlistMoveIds";

export function createWishlistBackend(
  input: MikaCartWishlistBackendInput & Pick<CreateMikaBackendApiInput, "overrides">,
): MikaApi["wishlist"] {
  const wishlist = {
    get: async (ctx) => {
      const documentResult = await findOrCreateActiveWishlist(input, ctx);
      if (!documentResult.ok) return documentResult;

      return {
        ok: true,
        status: 200,
        data: await wishlistDocumentToDTO(input, documentResult.wishlist),
      };
    },
    add: async (ctx, itemInput) => {
      const resolved = await resolveWishlistItem(input, itemInput);
      if (!resolved.ok) return resolved;

      const documentResult = await findOrCreateActiveWishlist(input, ctx);
      if (!documentResult.ok) return documentResult;
      const document = documentResult.wishlist;
      const existingItem = document.aggregate.items.find((item) =>
        isEquivalentWishlistItem(item, resolved.item),
      );
      const items = existingItem
        ? document.aggregate.items
        : [...document.aggregate.items, resolved.item];
      const updated = updateWishlistDocument(document, items, ctx.now);

      const persisted = await putWishlistOrConflict(input, updated, document.version);
      if (!persisted.ok) return persisted;

      return {
        ok: true,
        status: 200,
        data: await wishlistDocumentToDTO(input, persisted.wishlist),
      };
    },
    remove: async (ctx, itemInput) => {
      const documentResult = await findOrCreateActiveWishlist(input, ctx);
      if (!documentResult.ok) return documentResult;
      const document = documentResult.wishlist;
      if (!document.aggregate.items.some((item) => item.id === itemInput.itemId)) {
        return wishlistItemNotFound(itemInput.itemId);
      }

      const updated = updateWishlistDocument(
        document,
        document.aggregate.items.filter((item) => item.id !== itemInput.itemId),
        ctx.now,
      );

      const persisted = await putWishlistOrConflict(input, updated, document.version);
      if (!persisted.ok) return persisted;

      return {
        ok: true,
        status: 200,
        data: await wishlistDocumentToDTO(input, persisted.wishlist),
      };
    },
    moveToCart: async (ctx, itemInput) => {
      const quantity = itemInput.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        return validationFailed("quantity", "Quantity must be a positive whole number.");
      }

      const documentResult = await findOrCreateActiveWishlist(input, ctx);
      if (!documentResult.ok) return documentResult;
      const document = documentResult.wishlist;
      const item = document.aggregate.items.find((candidate) => candidate.id === itemInput.itemId);
      if (!item) {
        return wishlistItemNotFound(itemInput.itemId);
      }

      const currency = defaultBackendCurrency(input);
      if (item.item.currency !== currency) {
        return validationFailed(
          "itemId",
          `Wishlist item '${item.id}' uses currency '${item.item.currency}'.`,
        );
      }

      const line: CartLine = omitUndefined({
        id: input.createId("cart_line"),
        item: item.item,
        quantity,
        addedAt: ctx.now,
        metadata: {
          ...item.metadata,
          [WISHLIST_MOVE_IDS_METADATA_KEY]: Array.of<string>(item.id),
        },
      });
      const cartResult = await persistWishlistMoveToCart(input, ctx, currency, line, item.id);
      if (!cartResult.ok) return cartResult;
      const updatedWishlist = updateWishlistDocument(
        document,
        document.aggregate.items.filter((candidate) => candidate.id !== item.id),
        ctx.now,
      );

      // Cart first is deliberate: if the wishlist CAS loses a race, the item exists in both
      // places rather than neither. The move marker prevents a retry from adding quantity twice.
      const wishlistResult = await putWishlistOrConflict(input, updatedWishlist, document.version);
      if (!wishlistResult.ok) return wishlistResult;

      return { ok: true, status: 200, data: await cartDocumentToDTO(input, cartResult.cart) };
    },
    saveForLater: async (ctx, itemInput) => {
      const cart = await findOrCreateOpenCart(input, ctx);
      const writeBlocked = cartWriteBlocked(cart);
      if (writeBlocked) return writeBlocked;
      const line = cart.aggregate.items.find((candidate) => candidate.id === itemInput.lineId);
      if (!line) {
        return cartLineNotFound(itemInput.lineId);
      }

      const documentResult = await findOrCreateActiveWishlist(input, ctx);
      if (!documentResult.ok) return documentResult;
      const document = documentResult.wishlist;
      const item: WishlistItem = omitUndefined({
        id: input.createId("wishlist_item"),
        item: line.item,
        addedAt: ctx.now,
        metadata: line.metadata,
      });
      const wishlistItems = mergeWishlistItems(document.aggregate.items, [item]);
      const updatedWishlist = updateWishlistDocument(document, wishlistItems, ctx.now);
      const updatedCart = updateCartDocument(
        cart,
        cart.aggregate.items.filter((candidate) => candidate.id !== line.id),
        ctx.now,
      );

      // Wishlist first is deliberate: a cart CAS conflict leaves the item visible in both places,
      // and mergeWishlistItems makes a retry idempotent instead of creating duplicate entries.
      const wishlistResult = await putWishlistOrConflict(input, updatedWishlist, document.version);
      if (!wishlistResult.ok) return wishlistResult;
      const cartResult = await input.repositories.session.putCartIfUnchanged(
        updatedCart,
        cart.version,
      );
      if (!cartResult) return cartChanged(cart.id);

      return {
        ok: true,
        status: 200,
        data: await wishlistDocumentToDTO(input, wishlistResult.wishlist),
      };
    },
    merge: async (ctx, mergeInput) => {
      const targetResult = mergeInput.targetWishlistId
        ? await findOwnedActiveWishlistById(input, ctx, mergeInput.targetWishlistId)
        : await findOrCreateActiveWishlist(input, ctx);
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
        version: nextWishlistVersion(source.version),
      };

      const targetPersisted = await putWishlistOrConflict(
        input,
        updated,
        targetResult.wishlist.version,
      );
      if (!targetPersisted.ok) return targetPersisted;
      const sourcePersisted = await putWishlistOrConflict(input, mergedSource, source.version);
      if (!sourcePersisted.ok) return sourcePersisted;

      return {
        ok: true,
        status: 200,
        data: await wishlistDocumentToDTO(input, targetPersisted.wishlist),
      };
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

async function findOrCreateActiveWishlist(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
): Promise<{ readonly ok: true; readonly wishlist: WishlistDocument } | MikaApiFailure> {
  const existing = await findActiveWishlist(input, ctx);
  if (existing) return { ok: true, wishlist: existing };

  const lockIdentity = ctx.customerId ?? ctx.sessionId;
  if (!lockIdentity) {
    const wishlist = createWishlistDocument(input, ctx);
    await input.repositories.session.put(wishlist);

    return { ok: true, wishlist };
  }

  const lockKey = `wishlist-create-lock:${await input.hash(lockIdentity)}`;
  const owner = input.createId("wishlist_create_lock_owner");
  const lock = await input.repositories.ephemeral.tryAcquireLock({
    key: lockKey,
    owner,
    expiresAt: addMilliseconds(ctx.now, 30_000),
    now: ctx.now,
  });
  if (!lock) {
    const winner = await findActiveWishlist(input, ctx);
    if (winner) return { ok: true, wishlist: winner };

    return apiFailure(409, "CONFLICT", "Wishlist is being created by another request.", {
      wishlistId: "Wishlist is being created by another request. Reload and try again.",
    });
  }

  try {
    // Re-check after acquiring the lock: another creator may have completed between the initial
    // read and this acquisition if its lock was released before our attempt reached storage.
    const winner = await findActiveWishlist(input, ctx);
    if (winner) return { ok: true, wishlist: winner };

    const wishlist = createWishlistDocument(input, ctx);
    await input.repositories.session.put(wishlist);

    return { ok: true, wishlist };
  } finally {
    await input.repositories.ephemeral
      .releaseLock({ key: lockKey, owner, now: ctx.now })
      .catch((error: unknown) =>
        observeBackendError(input, "wishlist.createLock.release", error, { lockKey }),
      );
  }
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

  return omitUndefined({
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
    version: 1,
    aggregate: createWishlistAggregate(),
    createdAt: now,
    updatedAt: now,
  });
}

async function persistWishlistMoveToCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  currency: CurrencyCode,
  line: CartLine,
  wishlistItemId: MikaId,
): Promise<{ readonly ok: true; readonly cart: CartDocument } | MikaApiFailure> {
  const existing = await findOpenCart(input, ctx, currency);
  if (existing) {
    return appendWishlistMoveToCart(input, ctx, existing, line, wishlistItemId, true);
  }

  const lockIdentity = ctx.customerId ?? ctx.sessionId;
  if (!lockIdentity) {
    return appendWishlistMoveToCart(
      input,
      ctx,
      createCartDocument(input, ctx, currency),
      line,
      wishlistItemId,
      false,
    );
  }

  // Share cart.add's lock key so a first move and a first add cannot create separate open carts.
  const lockKey = `cart-create-lock:${await input.hash(`${lockIdentity}:${currency}`)}`;
  const owner = input.createId("cart_create_lock_owner");
  const lock = await input.repositories.ephemeral.tryAcquireLock({
    key: lockKey,
    owner,
    expiresAt: addMilliseconds(ctx.now, 30_000),
    now: ctx.now,
  });
  if (!lock) {
    const winner = await findOpenCart(input, ctx, currency);
    if (!winner) {
      return apiFailure(409, "CONFLICT", "Cart is being created by another request.", {
        cartId: "Cart is being created by another request. Reload the cart and try again.",
      });
    }

    return appendWishlistMoveToCart(input, ctx, winner, line, wishlistItemId, true);
  }

  try {
    const winner = await findOpenCart(input, ctx, currency);
    return appendWishlistMoveToCart(
      input,
      ctx,
      winner ?? createCartDocument(input, ctx, currency),
      line,
      wishlistItemId,
      Boolean(winner),
    );
  } finally {
    await input.repositories.ephemeral
      .releaseLock({ key: lockKey, owner, now: ctx.now })
      .catch((error: unknown) =>
        observeBackendError(input, "wishlist.moveToCart.createLock.release", error, { lockKey }),
      );
  }
}

async function appendWishlistMoveToCart(
  input: MikaCartWishlistBackendInput,
  ctx: MikaRequestContext,
  cart: CartDocument,
  line: CartLine,
  wishlistItemId: MikaId,
  persisted: boolean,
): Promise<{ readonly ok: true; readonly cart: CartDocument } | MikaApiFailure> {
  const writeBlocked = cartWriteBlocked(cart);
  if (writeBlocked) return writeBlocked;
  const alreadyMoved = cart.aggregate.items.some((candidate) =>
    wishlistMoveIds(candidate).includes(wishlistItemId),
  );
  if (alreadyMoved) return { ok: true, cart };

  const itemsResult = await mergeCartLine(input, cart.aggregate.items, line);
  if (!itemsResult.ok) return itemsResult;
  const updated = updateCartDocument(
    cart,
    markWishlistMove(itemsResult.items, line, wishlistItemId),
    ctx.now,
  );
  if (!persisted) {
    await input.repositories.session.put(updated);
    return { ok: true, cart: updated };
  }

  const stored = await input.repositories.session.putCartIfUnchanged(updated, cart.version);
  return stored ? { ok: true, cart: stored } : cartChanged(cart.id);
}

function updateWishlistDocument(
  wishlist: WishlistDocument,
  items: readonly WishlistItem[],
  updatedAt: ISODateTime,
): WishlistDocument {
  return {
    ...wishlist,
    updatedAt,
    version: nextWishlistVersion(wishlist.version),
    aggregate: createWishlistAggregate(
      omitUndefined({ items, metadata: wishlist.aggregate.metadata }),
    ),
  };
}

async function putWishlistOrConflict(
  input: MikaCartWishlistBackendInput,
  wishlist: WishlistDocument,
  expectedVersion: number | undefined,
): Promise<{ readonly ok: true; readonly wishlist: WishlistDocument } | MikaApiFailure> {
  const persisted = await input.repositories.session.putWishlistIfUnchanged(
    wishlist,
    expectedVersion,
  );
  if (!persisted) {
    return apiWishlistChanged(wishlist.id);
  }

  return { ok: true, wishlist: persisted };
}

function apiWishlistChanged(wishlistId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: `Wishlist '${wishlistId}' was changed by another request.`,
      fieldErrors: {
        wishlistId: "Wishlist was changed by another request. Reload it and try again.",
      },
    },
  };
}

function cartChanged(cartId: MikaId): MikaApiFailure {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: `Cart '${cartId}' was changed by another request.`,
      fieldErrors: {
        cartId: "Cart was changed by another request. Reload it and try again.",
      },
    },
  };
}

function wishlistMoveIds(line: CartLine): readonly string[] {
  const value = line.metadata?.[WISHLIST_MOVE_IDS_METADATA_KEY];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function markWishlistMove(
  items: readonly CartLine[],
  movedLine: CartLine,
  wishlistItemId: MikaId,
): readonly CartLine[] {
  return items.map((line) => {
    if (!isEquivalentCartLine(line, movedLine)) return line;
    const moveIds = wishlistMoveIds(line);
    if (moveIds.includes(wishlistItemId)) return line;

    return {
      ...line,
      metadata: {
        ...line.metadata,
        [WISHLIST_MOVE_IDS_METADATA_KEY]: [...moveIds, wishlistItemId],
      },
    };
  });
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
