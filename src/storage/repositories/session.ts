import {
  documentOfType,
  findFirstByTypeCandidate,
  typedCollection,
  type DocumentList,
  type TypedCollectionFacade,
} from "./kit";
import type { StorageCollection } from "../collections";
import type {
  CartDocument,
  CheckoutDocument,
  SessionDocument,
  WishlistDocument,
} from "../../types/documents";
import type { ISODateTime, MikaId } from "../../types/primitives";
import { nextCartVersion } from "../../model/cart-version";

function cartWithCheckoutClaim(
  cart: CartDocument,
  checkoutId: MikaId,
  claimExpiresAt: ISODateTime,
  now: ISODateTime,
): CartDocument {
  return {
    ...cart,
    status: "checkout_pending",
    aggregate: {
      ...cart.aggregate,
      metadata: {
        ...cart.aggregate.metadata,
        checkoutStartClaimId: checkoutId,
        checkoutStartClaimExpiresAt: claimExpiresAt,
      },
    },
    updatedAt: now,
    version: nextCartVersion(cart.version),
  };
}

function cartWithoutCheckoutClaim(cart: CartDocument, now: ISODateTime): CartDocument {
  const metadata = Object.fromEntries(
    Object.entries(cart.aggregate.metadata ?? {}).filter(
      ([key]) => key !== "checkoutStartClaimId" && key !== "checkoutStartClaimExpiresAt",
    ),
  );

  return {
    ...cart,
    status: "open",
    aggregate: {
      ...cart.aggregate,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
    updatedAt: now,
    version: nextCartVersion(cart.version),
  };
}

/**
 * Reads an open cart by session id across currencies without importing {@link SessionRepository}.
 * Structurally probes for the {@link SessionRepository.findOpenCartBySessionAnyCurrency} method,
 * so host-implemented ports and wrapped/proxied instances participate by simply exposing the
 * method — unlike the WeakMap registry this replaces, which silently missed for anything that was
 * not the identical constructor-registered instance.
 */
export function findSessionRepositoryOpenCartBySessionAnyCurrency(
  repository: unknown,
  sessionId: string,
): Promise<CartDocument | null> {
  if (typeof repository !== "object" || repository === null) return Promise.resolve(null);
  const candidate = repository as {
    readonly findOpenCartBySessionAnyCurrency?: (
      sessionId: string,
    ) => Promise<CartDocument | null>;
  };
  if (typeof candidate.findOpenCartBySessionAnyCurrency !== "function") {
    return Promise.resolve(null);
  }

  return candidate.findOpenCartBySessionAnyCurrency(sessionId);
}

/** Document repository for cart, wishlist, and checkout session documents. */
export class SessionRepository {
  private readonly documents: TypedCollectionFacade<SessionDocument>;

  constructor(collection: StorageCollection<SessionDocument>) {
    this.documents = typedCollection(collection);
  }

  /** Open cart for a session across currencies; used by cart.merge's any-currency fallback. */
  async findOpenCartBySessionAnyCurrency(sessionId: string): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      sessionId,
      status: "open",
    });
  }

  async findById(id: MikaId): Promise<SessionDocument | null> {
    return this.documents.get(id);
  }

  async findCheckoutById(id: MikaId): Promise<CheckoutDocument | null> {
    return this.documents.findByIdOfType(id, "checkout");
  }

  async findOpenCartBySession(sessionId: string, currency: string): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      sessionId,
      status: "open",
      currency,
    });
  }

  async findOpenCartByCustomer(customerId: MikaId, currency: string): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      customerId,
      status: "open",
      currency,
    });
  }

  async findCheckoutPendingCartBySession(
    sessionId: string,
    currency: string,
  ): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      sessionId,
      status: "checkout_pending",
      currency,
    });
  }

  async findCheckoutPendingCartByCustomer(
    customerId: MikaId,
    currency: string,
  ): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      customerId,
      status: "checkout_pending",
      currency,
    });
  }

  async listCheckoutPendingCartsBySession(
    sessionId: string,
    limit = 20,
  ): Promise<DocumentList<CartDocument>> {
    return this.documents.listByType("cart", {
      where: { sessionId, status: "checkout_pending" },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listCheckoutPendingCartsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<CartDocument>> {
    return this.documents.listByType("cart", {
      where: { customerId, status: "checkout_pending" },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async claimCartForCheckout(input: {
    readonly cartId: MikaId;
    readonly checkoutId: MikaId;
    readonly expectedVersion: number | undefined;
    readonly claimExpiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null> {
    const updated = await this.documents.update(input.cartId, (current) => {
      const cart = documentOfType(current, "cart");
      if (!cart || cart.status !== "open") return null;
      // A cart with no version (persisted before this field existed) has nothing to compare —
      // allow the write instead of vacuously matching (undefined !== expectedVersion is always
      // true, so a strict check would permanently 409 every such cart) or vacuously rejecting it.
      if (cart.version !== undefined && cart.version !== input.expectedVersion) return null;

      return cartWithCheckoutClaim(cart, input.checkoutId, input.claimExpiresAt, input.now);
    });

    return documentOfType(updated, "cart");
  }

  async releaseCartCheckoutClaim(input: {
    readonly cartId: MikaId;
    readonly checkoutId: MikaId;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null> {
    const updated = await this.documents.update(input.cartId, (current) => {
      const cart = documentOfType(current, "cart");
      if (!cart || cart.status !== "checkout_pending") return null;
      if (cart.aggregate.metadata?.["checkoutStartClaimId"] !== input.checkoutId) return null;

      return cartWithoutCheckoutClaim(cart, input.now);
    });

    return documentOfType(updated, "cart");
  }

  async putCartIfUnchanged(
    cart: CartDocument,
    expectedVersion: number | undefined,
  ): Promise<CartDocument | null> {
    const updated = await this.documents.update(cart.id, (current) => {
      const existing = documentOfType(current, "cart");
      if (!existing || existing.status !== "open") return null;
      // See claimCartForCheckout: a cart with no version (persisted before this field existed)
      // has nothing to compare — allow the write rather than permanently 409ing every such cart.
      if (existing.version !== undefined && existing.version !== expectedVersion) return null;

      return cart;
    });

    return documentOfType(updated, "cart");
  }

  async findWishlistBySession(sessionId: string): Promise<WishlistDocument | null> {
    return this.documents.findOneByType("wishlist", {
      sessionId,
      status: "active",
    });
  }

  async findWishlistByCustomer(customerId: MikaId): Promise<WishlistDocument | null> {
    return this.documents.findOneByType("wishlist", {
      customerId,
      status: "active",
    });
  }

  async findCheckoutByProvider(
    provider: string,
    providerCheckoutId: string,
  ): Promise<CheckoutDocument | null> {
    return this.documents.findOneByType("checkout", {
      provider,
      providerCheckoutId,
    });
  }

  async findCheckoutByIdempotencyKey(idempotencyKey: string): Promise<CheckoutDocument | null> {
    if (!idempotencyKey) return null;

    const indexed = await this.documents.findOneByType("checkout", {
      checkoutIdempotencyKey: idempotencyKey,
    });
    if (indexed) return indexed;

    return findFirstByTypeCandidate(this.documents, "checkout", (item) =>
      item.data.aggregate.metadata?.["checkoutIdempotencyKey"] === idempotencyKey
        ? item.data
        : null,
    );
  }

  async put(document: SessionDocument): Promise<void> {
    await this.documents.put(document);
  }
}
