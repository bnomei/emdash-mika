/**
 * Wishlist API implementation and the wishlist-document helpers it builds on: creating/finding
 * the caller's active wishlist, and merging wishlist items for session-to-account wishlist
 * merges. Move-to-cart and save-for-later cross into the cart document helpers from ./cart.
 */
import { omitUndefined } from "../../internal/object";
import { createWishlistAggregate } from "../../model/builders";
import type { CartLine, WishlistItem } from "../../types/aggregates";
import type { WishlistDocument } from "../../types/documents";
import { createISODateTime } from "../../types/primitives";
import type { ISODateTime, MikaId } from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import type { MikaApi } from "../server";
import { cartWriteBlocked, createCartDocument, findOrCreateOpenCart, mergeCartLine } from "./cart";
import {
  cartLineNotFound,
  invalidWishlist,
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
  isEquivalentWishlistItem,
  resolveWishlistItem,
  updateCartDocument,
  wishlistDocumentToDTO,
} from "./quote";
import { defaultBackendCurrency } from "./shared";

export function createWishlistBackend(
  input: MikaCartWishlistBackendInput & Pick<CreateMikaBackendApiInput, "overrides">,
): MikaApi["wishlist"] {
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

      const line: CartLine = omitUndefined({
        id: input.createId("cart_line"),
        item: item.item,
        quantity,
        addedAt: ctx.now,
        metadata: item.metadata,
      });
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
    aggregate: createWishlistAggregate(),
    createdAt: now,
    updatedAt: now,
  });
}

function updateWishlistDocument(
  wishlist: WishlistDocument,
  items: readonly WishlistItem[],
  updatedAt: ISODateTime,
): WishlistDocument {
  return {
    ...wishlist,
    updatedAt,
    aggregate: createWishlistAggregate(
      omitUndefined({ items, metadata: wishlist.aggregate.metadata }),
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
