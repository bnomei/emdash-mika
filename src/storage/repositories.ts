/**
 * Repository layer over document collections and operational SQLite tables.
 * Encapsulates typed queries, stock mutations, workflow leases, and ephemeral record access.
 */
import { sql, type Kysely, type Transaction } from "kysely";

import type {
  AccountDeleteRequestDocument,
  AccountDocument,
  AccountExportDocument,
  AdminAuditDocument,
  CartDocument,
  CatalogDocument,
  CatalogItemDocument,
  CheckoutDocument,
  CustomerDocument,
  EmailDocument,
  EntitlementDocument,
  LedgerDocument,
  LicenseDocument,
  OrderDocument,
  OpsDocument,
  ProviderAccountDocument,
  ProviderSyncRunDocument,
  SessionDocument,
  SubscriptionDocument,
  WebhookDocument,
  WorkflowDocument,
  WishlistDocument,
} from "../types/documents";
import type { PriceDefinition, SellableDefinition } from "../types/aggregates";
import type { EphemeralRecord, StockEventRecord, StockItemRecord } from "../types/operational";
import {
  createISODateTime,
  createMikaId,
  isJsonObject,
  type ContentRef,
  type ISODateTime,
  type JsonObject,
  type MikaId,
} from "../types/primitives";
import { decodeJsonObject, encodeJson } from "./json";
import type {
  MikaStorageCollections,
  PaginatedStorageResult,
  StorageCollection,
  StorageQueryOptions,
  StorageWhereClause,
} from "./collections";
import type { MikaDatabase, MikaInsertable, MikaSelectable, MikaUpdateable } from "./schema";
import {
  adjustStockStatement,
  consumeOnHandStatement,
  consumeReservedStockStatement,
  releaseStockStatement,
  reserveStockStatement,
} from "./statements";

/** Kysely database handle for operational SQLite tables. */
export type MikaDb = Kysely<MikaDatabase>;
/** Transaction scope for atomic stock and ephemeral mutations. */
export type MikaTransaction = Transaction<MikaDatabase>;
/** Database or transaction executor accepted by operational repositories. */
export type MikaDbExecutor = MikaDb | MikaTransaction;

/** Catalog item, sellable, and price tuple resolved from provider price lookup. */
export interface CatalogProviderPriceMatch {
  readonly catalog: CatalogItemDocument;
  readonly sellable: SellableDefinition;
  readonly price: PriceDefinition;
}

/** Input for creating a stock reservation event with optional idempotency key. */
export interface ReserveStockRepositoryInput {
  readonly reservationEventId: MikaId;
  readonly stockItemId: MikaId;
  readonly quantity: number;
  readonly expiresAt: ISODateTime;
  readonly now: ISODateTime;
  readonly cartId?: MikaId;
  readonly checkoutSessionId?: MikaId;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/** Discriminated result of a stock reservation attempt or idempotent replay. */
export type ReserveStockRepositoryResult =
  | {
      readonly status: "reserved";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "replayed";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: "idempotency_conflict";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: "insufficient_stock";
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "not_found";
    };

/** Input for releasing an active reservation event. */
export interface ReleaseReservedStockRepositoryInput {
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
}

/** Input for consuming a reservation into an order line fulfillment. */
export interface ConsumeReservedStockRepositoryInput {
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
}

/** Input for sweeping expired reservation events back to availability. */
export interface ReleaseExpiredReservationsRepositoryInput {
  readonly now: ISODateTime;
}

/** Summary counts from an expired reservation release sweep. */
export interface ReleaseExpiredReservationsRepositoryResult {
  readonly scannedCount: number;
  readonly releasedCount: number;
  readonly stockItemsAffected: number;
}

/** Input for releasing all active reservations owned by a customer. */
export interface ReleaseActiveReservationsByCustomerRepositoryInput {
  readonly customerId: MikaId;
  readonly now: ISODateTime;
}

/** Input for extending the expiry of active reservation events. */
export interface ExtendReservationsRepositoryInput {
  readonly reservationEventIds: readonly MikaId[];
  readonly expiresAt: ISODateTime;
  readonly now: ISODateTime;
}

/** Input for recording a manual or audited stock movement event. */
export interface AdjustStockRepositoryInput {
  readonly movementEventId: MikaId;
  readonly stockItemId: MikaId;
  readonly quantityDelta: number;
  readonly now: ISODateTime;
  readonly reason?: NonNullable<StockEventRecord["reason"]>;
  readonly adminAuditId?: MikaId;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/** Discriminated result of a stock adjustment attempt or idempotent replay. */
export type AdjustStockRepositoryResult =
  | {
      readonly status: "adjusted";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "replayed";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: "idempotency_conflict";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: "would_go_negative";
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "would_undercut_reserved";
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "not_found";
    };

/** Input for acquiring a workflow execution lease. */
export interface WorkflowLeaseRepositoryInput {
  readonly workflowId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly leaseExpiresAt: ISODateTime;
  readonly force?: boolean;
}

/** Input for advancing a leased workflow step. */
export interface WorkflowStepRepositoryInput {
  readonly workflowId: MikaId;
  readonly leaseKey: string;
  readonly stepName: string;
  readonly now: ISODateTime;
  readonly state?: JsonObject;
}

/** Input for failing a leased workflow or step with retry scheduling. */
export interface WorkflowFailureRepositoryInput {
  readonly workflowId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly lastError: string;
  readonly nextAttemptAt: ISODateTime;
  readonly stepName?: string;
}

/** Input for acquiring an email delivery lease. */
export interface EmailLeaseRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly leaseExpiresAt: ISODateTime;
  readonly force?: boolean;
}

/** Input for marking a leased email as successfully sent. */
export interface EmailCompleteRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly providerMessageId?: string;
}

/** Input for idempotently marking an email as delivered without an active lease. */
export interface EmailDeliveredRepositoryInput {
  readonly emailId: MikaId;
  readonly now: ISODateTime;
  readonly providerMessageId?: string;
}

/** Input for failing a leased email with optional retry scheduling. */
export interface EmailFailureRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly lastError: string;
  readonly nextAttemptAt?: ISODateTime;
}

/** Input for skipping a leased email without retry. */
export interface EmailSkipRepositoryInput {
  readonly emailId: MikaId;
  readonly leaseKey: string;
  readonly now: ISODateTime;
  readonly lastError: string;
}

/** Input for completing a queued account deletion request record. */
export interface AccountDeleteRequestCompletionRepositoryInput {
  readonly requestId: MikaId;
  readonly now: ISODateTime;
  readonly metadata?: JsonObject;
}

/** Input for failing a queued account deletion request record. */
export interface AccountDeleteRequestFailureRepositoryInput {
  readonly requestId: MikaId;
  readonly now: ISODateTime;
  readonly lastError: string;
}

/** Input for recording one completed account-delete maintenance step. */
export interface AccountDeleteMaintenanceStepRepositoryInput {
  readonly requestId: MikaId;
  readonly now: ISODateTime;
  readonly stepName: string;
  readonly result: JsonObject;
}

/** Identity selectors for redacting queued email records after account deletion. */
export interface AccountDeleteEmailRedactionRepositoryInput {
  readonly now: ISODateTime;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
}

/** Result of atomically claiming an admin action idempotency key. */
export type AdminAuditIdempotencyClaimResult =
  | { readonly status: "claimed"; readonly audit: AdminAuditDocument }
  | { readonly status: "existing"; readonly audit: AdminAuditDocument };

const ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "idempotencyInputHash";

type ReservationEventMutationRepositoryResult<
  TStatus extends "released" | "consumed" | "expired",
> =
  | {
      readonly status: TStatus;
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "not_active";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: "not_found";
    };

/** Result of releasing an active reservation event. */
export type ReleaseReservedStockRepositoryResult =
  ReservationEventMutationRepositoryResult<"released">;
/** Result of expiring an active reservation event (frees stock, stays consumable). */
export type ExpireReservedStockRepositoryResult =
  ReservationEventMutationRepositoryResult<"expired">;
/** Result of consuming a reservation event into fulfillment. */
export type ConsumeReservedStockRepositoryResult =
  ReservationEventMutationRepositoryResult<"consumed">;

type TypedDocument = {
  readonly type: string;
};

type DocumentType<TDocument extends TypedDocument> = TDocument["type"];
type DocumentOfType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
> = Extract<TDocument, { readonly type: TType }>;
type TypeScopedWhere<TDocument extends TypedDocument> = Omit<StorageWhereClause<TDocument>, "type">;
type TypeScopedQueryOptions<TDocument extends TypedDocument> = Omit<
  StorageQueryOptions<TDocument>,
  "where"
> & {
  readonly where?: TypeScopedWhere<TDocument>;
};
type StorageResultItem<TDocument> = {
  id: string;
  data: TDocument;
};
type DocumentList<TDocument> = PaginatedStorageResult<StorageResultItem<TDocument>>;
type DueOpsDocument = WebhookDocument | EmailDocument;
type StockMutationResult = {
  readonly numAffectedRows?: bigint | number;
  readonly numUpdatedRows?: bigint | number;
  readonly numChangedRows?: bigint | number;
};
type TypedCollectionFacade<TDocument extends TypedDocument & { readonly id: string }> = ReturnType<
  typeof typedCollection<TDocument>
>;
type SessionRepositoryInternals = {
  readonly findOpenCartBySessionAnyCurrency: (sessionId: string) => Promise<CartDocument | null>;
};
const sessionRepositoryInternals = new WeakMap<object, SessionRepositoryInternals>();

async function putByDocumentId<TDocument extends { readonly id: string }>(
  collection: StorageCollection<TDocument>,
  document: TDocument,
): Promise<void> {
  await collection.put(document.id, document);
}

async function findOneByType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
>(
  collection: StorageCollection<TDocument>,
  type: TType,
  where?: TypeScopedWhere<DocumentOfType<TDocument, TType>>,
): Promise<DocumentOfType<TDocument, TType> | null> {
  const result = await collection.query({
    where: withDocumentType<TDocument, TType>(
      type,
      where ?? ({} as TypeScopedWhere<DocumentOfType<TDocument, TType>>),
    ),
    limit: 1,
  });

  return documentOfType(result.items[0]?.data, type);
}

async function findByIdOfType<
  TDocument extends TypedDocument,
  TType extends DocumentType<TDocument>,
>(
  collection: StorageCollection<TDocument>,
  id: string,
  type: TType,
): Promise<DocumentOfType<TDocument, TType> | null> {
  return documentOfType(await collection.get(id), type);
}

async function listByType<TDocument extends TypedDocument, TType extends DocumentType<TDocument>>(
  collection: StorageCollection<TDocument>,
  type: TType,
  options?: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
): Promise<DocumentList<DocumentOfType<TDocument, TType>>> {
  const { where, ...rest } = options ?? {};
  const result = await collection.query({
    ...rest,
    where: withDocumentType<TDocument, TType>(
      type,
      where ?? ({} as TypeScopedWhere<DocumentOfType<TDocument, TType>>),
    ),
  } as StorageQueryOptions<TDocument>);

  return result as DocumentList<DocumentOfType<TDocument, TType>>;
}

async function findFirstByTypeCandidate<
  TDocument extends TypedDocument & { readonly id: string },
  TType extends DocumentType<TDocument>,
  TResult,
>(
  documents: TypedCollectionFacade<TDocument>,
  type: TType,
  match: (item: StorageResultItem<DocumentOfType<TDocument, TType>>) => TResult | null | undefined,
  options: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>> = {},
): Promise<TResult | null> {
  let cursor = options.cursor;
  const limit = options.limit ?? 100;

  do {
    const page = await documents.listByType(type, {
      ...options,
      cursor,
      limit,
    });

    for (const item of page.items) {
      const candidate = match(item);
      if (candidate !== null && candidate !== undefined) return candidate;
    }

    cursor = page.cursor;
  } while (cursor);

  return null;
}

async function listByTypeCandidates<
  TDocument extends TypedDocument & { readonly id: string },
  TType extends DocumentType<TDocument>,
>(
  documents: TypedCollectionFacade<TDocument>,
  type: TType,
  target: number,
  options: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
  isCandidate: (document: DocumentOfType<TDocument, TType>) => boolean,
): Promise<DocumentList<DocumentOfType<TDocument, TType>>> {
  if (target <= 0) return { items: [], hasMore: false };

  const items: Array<StorageResultItem<DocumentOfType<TDocument, TType>>> = [];
  let cursor = options.cursor;
  let hasMore = false;
  const pageLimit = Math.max(target, options.limit ?? 50);

  do {
    const page = await documents.listByType(type, {
      ...options,
      cursor,
      limit: pageLimit,
    });

    for (const item of page.items) {
      if (isCandidate(item.data)) items.push(item);
    }

    cursor = page.cursor;
    hasMore = page.hasMore;
  } while (items.length < target && cursor);

  return {
    items,
    cursor: hasMore ? cursor : undefined,
    hasMore,
  };
}

function withDocumentType<TDocument extends TypedDocument, TType extends DocumentType<TDocument>>(
  type: TType,
  where: TypeScopedWhere<DocumentOfType<TDocument, TType>>,
): StorageWhereClause<TDocument> {
  return { ...where, type } as StorageWhereClause<TDocument>;
}

function documentOfType<TDocument extends TypedDocument, TType extends DocumentType<TDocument>>(
  document: TDocument | null | undefined,
  type: TType,
): DocumentOfType<TDocument, TType> | null {
  return document?.type === type ? (document as DocumentOfType<TDocument, TType>) : null;
}

function adminAuditInputHashMatches(
  current: AdminAuditDocument,
  next: AdminAuditDocument,
): boolean {
  const currentHash =
    current.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];
  const nextHash = next.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];

  return typeof currentHash === "string" && currentHash === nextHash;
}

function adminAuditHasTopLevelAction(document: AdminAuditDocument): boolean {
  return typeof (document as { readonly action?: unknown }).action === "string";
}

function adminAuditWithId(document: AdminAuditDocument, id: MikaId): AdminAuditDocument {
  return {
    ...document,
    id,
    record: {
      ...document.record,
      id,
    },
  };
}

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
  };
}

function typedCollection<TDocument extends TypedDocument & { readonly id: string }>(
  collection: StorageCollection<TDocument>,
) {
  return {
    get: (id: string) => collection.get(id),
    put: (document: TDocument) => putByDocumentId(collection, document),
    update: (id: string, updater: (current: TDocument | null) => TDocument | null) =>
      collection.update(id, updater),
    findOneByType: <TType extends DocumentType<TDocument>>(
      type: TType,
      where?: TypeScopedWhere<DocumentOfType<TDocument, TType>>,
    ) => findOneByType(collection, type, where),
    findByIdOfType: <TType extends DocumentType<TDocument>>(id: string, type: TType) =>
      findByIdOfType(collection, id, type),
    listByType: <TType extends DocumentType<TDocument>>(
      type: TType,
      options?: TypeScopedQueryOptions<DocumentOfType<TDocument, TType>>,
    ) => listByType(collection, type, options),
  };
}

/** Reads an open cart by session id across currencies via repository internals. */
export function findSessionRepositoryOpenCartBySessionAnyCurrency(
  repository: unknown,
  sessionId: string,
): Promise<CartDocument | null> {
  if (typeof repository !== "object" || repository === null) return Promise.resolve(null);
  return (
    sessionRepositoryInternals.get(repository)?.findOpenCartBySessionAnyCurrency(sessionId) ??
    Promise.resolve(null)
  );
}

/** Document repository for catalog item and coupon lookup by content and provider refs. */
export class CatalogRepository {
  private readonly documents: TypedCollectionFacade<CatalogDocument>;

  constructor(collection: StorageCollection<CatalogDocument>) {
    this.documents = typedCollection(collection);
  }

  async findItemByContent(content: ContentRef): Promise<CatalogItemDocument | null> {
    return this.documents.findOneByType("catalogItem", {
      contentCollection: content.collection,
      contentId: content.id,
    });
  }

  async findItemBySellableId(sellableId: MikaId): Promise<CatalogItemDocument | null> {
    return findFirstByTypeCandidate(this.documents, "catalogItem", (item) =>
      item.data.aggregate.sellables.some((sellable) => sellable.id === sellableId)
        ? item.data
        : null,
    );
  }

  async findItemByProviderPrice(
    provider: string,
    providerPriceId: string,
  ): Promise<CatalogProviderPriceMatch | null> {
    return findFirstByTypeCandidate(this.documents, "catalogItem", (item) => {
      for (const sellable of item.data.aggregate.sellables) {
        const price = sellable.prices.find((candidate) =>
          candidate.providerRefs.some(
            (ref) => ref.provider === provider && ref.priceId === providerPriceId,
          ),
        );
        if (price) {
          return { catalog: item.data, sellable, price };
        }
      }

      return null;
    });
  }

  async findPriceById(priceId: MikaId): Promise<CatalogProviderPriceMatch | null> {
    return findFirstByTypeCandidate(this.documents, "catalogItem", (item) => {
      for (const sellable of item.data.aggregate.sellables) {
        const price = sellable.prices.find((candidate) => candidate.id === priceId);
        if (price) {
          return { catalog: item.data, sellable, price };
        }
      }

      return null;
    });
  }

  async put(document: CatalogDocument): Promise<void> {
    await this.documents.put(document);
  }
}

/** Document repository for cart, wishlist, and checkout session documents. */
export class SessionRepository {
  private readonly documents: TypedCollectionFacade<SessionDocument>;

  constructor(collection: StorageCollection<SessionDocument>) {
    this.documents = typedCollection(collection);
    sessionRepositoryInternals.set(this, {
      findOpenCartBySessionAnyCurrency: (sessionId) =>
        this.documents.findOneByType("cart", {
          sessionId,
          status: "open",
        }),
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
    readonly expectedUpdatedAt: ISODateTime;
    readonly claimExpiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null> {
    const updated = await this.documents.update(input.cartId, (current) => {
      const cart = documentOfType(current, "cart");
      if (!cart || cart.status !== "open" || cart.updatedAt !== input.expectedUpdatedAt) {
        return null;
      }

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

/** Document repository for customer, entitlement, license, and subscription documents. */
export class AccountRepository {
  private readonly documents: TypedCollectionFacade<AccountDocument>;

  constructor(collection: StorageCollection<AccountDocument>) {
    this.documents = typedCollection(collection);
  }

  async findCustomerById(customerId: MikaId): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { customerId });
  }

  async findCustomerByUserId(userId: string): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { userId });
  }

  async findCustomerByEmailHash(emailHash: string): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { emailHash });
  }

  async findEntitlementById(entitlementId: MikaId): Promise<EntitlementDocument | null> {
    return this.documents.findByIdOfType(entitlementId, "entitlement");
  }

  async findLicenseById(licenseId: MikaId): Promise<LicenseDocument | null> {
    return this.documents.findByIdOfType(licenseId, "license");
  }

  async findProviderAccount(
    provider: string,
    providerCustomerId: string,
  ): Promise<ProviderAccountDocument | null> {
    return this.documents.findOneByType("providerAccount", {
      provider,
      providerCustomerId,
    });
  }

  async findSubscriptionByProvider(
    provider: string,
    providerSubscriptionId: string,
  ): Promise<SubscriptionDocument | null> {
    return this.documents.findOneByType("subscription", {
      provider,
      providerSubscriptionId,
    });
  }

  async findSubscriptionById(subscriptionId: MikaId): Promise<SubscriptionDocument | null> {
    return this.documents.findByIdOfType(subscriptionId, "subscription");
  }

  async listProviderAccountsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<ProviderAccountDocument>> {
    return this.documents.listByType("providerAccount", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listSubscriptionsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<SubscriptionDocument>> {
    return this.documents.listByType("subscription", {
      where: { customerId },
      orderBy: { currentPeriodEnd: "desc" },
      limit,
    });
  }

  async listEntitlementsByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listEntitlementsByUser(
    userId: string,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { userId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listEntitlementsByEmailHash(
    emailHash: string,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { emailHash },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listLicensesByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<LicenseDocument>> {
    return this.documents.listByType("license", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async put(document: AccountDocument): Promise<void> {
    await this.documents.put(document);
  }

  async anonymizeCustomerForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: boolean; readonly sentinel?: string }> {
    const customer =
      (input.customerId ? await this.findCustomerById(input.customerId) : null) ??
      (input.emailHash ? await this.findCustomerByEmailHash(input.emailHash) : null);
    if (!customer) return { anonymized: false };

    const sentinel = `account-deleted:${customer.customerId}`;
    const anonymized: CustomerDocument = {
      ...customer,
      emailHash: sentinel,
      userId: sentinel,
      aggregate: {
        ...customer.aggregate,
        email: undefined,
        emailHash: sentinel,
        name: undefined,
        company: undefined,
        vatId: undefined,
        metadata: {
          ...(customer.aggregate.metadata ?? {}),
          anonymizedAt: input.now,
        },
      },
      updatedAt: input.now,
    };

    await this.put(anonymized);

    return { anonymized: true, sentinel };
  }

  async anonymizeEntitlementsForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly userId?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const byId = new Map<MikaId, EntitlementDocument>();
    if (input.customerId) {
      for (const item of (
        await this.listEntitlementsByCustomer(input.customerId, Number.MAX_SAFE_INTEGER)
      ).items) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.emailHash) {
      for (const item of (
        await this.listEntitlementsByEmailHash(input.emailHash, Number.MAX_SAFE_INTEGER)
      ).items) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.userId) {
      for (const item of (
        await this.listEntitlementsByUser(input.userId, Number.MAX_SAFE_INTEGER)
      ).items) {
        byId.set(item.data.id, item.data);
      }
    }

    let anonymized = 0;
    for (const entitlement of byId.values()) {
      const redacted: EntitlementDocument = {
        ...entitlement,
        emailHash: input.sentinel,
        userId: input.sentinel,
        record: {
          ...entitlement.record,
          emailHash: input.sentinel,
          userId: input.sentinel,
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }

  async anonymizeLicensesForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const licenses = input.customerId
      ? await this.listLicensesByCustomer(input.customerId, Number.MAX_SAFE_INTEGER)
      : { items: [] };

    let anonymized = 0;
    for (const item of licenses.items) {
      const license = item.data;
      const redacted: LicenseDocument = {
        ...license,
        customerId: undefined,
        status: "revoked",
        record: {
          ...license.record,
          licenseKeyHash: `${input.sentinel}:license-redacted`,
          displayKeySuffix: "redacted",
          status: "revoked",
          revokedAt: license.record.revokedAt ?? input.now,
          metadata: {
            ...(license.record.metadata ?? {}),
            anonymizedAt: input.now,
          },
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }
}

/** Document repository for order ledger documents and provider payment lookup. */
export class LedgerRepository {
  private readonly documents: TypedCollectionFacade<LedgerDocument>;

  constructor(collection: StorageCollection<LedgerDocument>) {
    this.documents = typedCollection(collection);
  }

  async findOrderById(orderId: MikaId): Promise<OrderDocument | null> {
    return this.documents.findByIdOfType(orderId, "order");
  }

  async findOrderByNumber(orderNumber: string): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", { orderNumber });
  }

  async findOrderByProviderPayment(
    provider: string,
    providerPaymentId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerPaymentId,
    });
  }

  async findOrderByProviderCheckout(
    provider: string,
    providerCheckoutId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerCheckoutId,
    });
  }

  async findOrderByProviderOrder(
    provider: string,
    providerOrderId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerOrderId,
    });
  }

  async findOrderByCheckoutSession(checkoutSessionId: MikaId): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", { checkoutSessionId });
  }

  async findOrderByDownloadRef(downloadRef: string): Promise<OrderDocument | null> {
    return findFirstByTypeCandidate(this.documents, "order", (item) =>
      item.data.aggregate.lines.some((line) => line.downloadRefs?.includes(downloadRef))
        ? item.data
        : null,
    );
  }

  async listOrdersByCustomer(customerId: MikaId, limit = 50): Promise<DocumentList<OrderDocument>> {
    return this.documents.listByType("order", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listOrdersByEmailHash(
    emailHash: string,
    limit = 50,
  ): Promise<DocumentList<OrderDocument>> {
    return this.documents.listByType("order", {
      where: { emailHash },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async anonymizeOrdersForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const byId = new Map<MikaId, OrderDocument>();
    if (input.customerId) {
      for (const item of (
        await this.listOrdersByCustomer(input.customerId, Number.MAX_SAFE_INTEGER)
      ).items) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.emailHash) {
      for (const item of (
        await this.listOrdersByEmailHash(input.emailHash, Number.MAX_SAFE_INTEGER)
      ).items) {
        byId.set(item.data.id, item.data);
      }
    }

    let anonymized = 0;
    for (const order of byId.values()) {
      const redacted: OrderDocument = {
        ...order,
        emailHash: input.sentinel,
        aggregate: {
          ...order.aggregate,
          customer: {
            ...order.aggregate.customer,
            email: undefined,
            emailHash: input.sentinel,
            name: undefined,
            company: undefined,
            vatId: undefined,
          },
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }

  async put(document: LedgerDocument): Promise<void> {
    await this.documents.put(document);
  }
}

/** Document repository for webhooks, emails, workflows, audits, and account ops records. */
export class OpsRepository {
  private readonly documents: TypedCollectionFacade<OpsDocument>;
  private readonly dueDocuments: TypedCollectionFacade<DueOpsDocument>;

  constructor(collection: StorageCollection<OpsDocument>) {
    this.documents = typedCollection(collection);
    this.dueDocuments = typedCollection(collection as StorageCollection<DueOpsDocument>);
  }

  async findWebhookDuplicate(input: {
    readonly provider: string;
    readonly providerEventId?: string;
    readonly eventType: string;
    readonly payloadHash: string;
  }): Promise<WebhookDocument | null> {
    if (input.providerEventId !== undefined) {
      const duplicate = await this.documents.findOneByType("webhook", {
        provider: input.provider,
        providerEventId: input.providerEventId,
      });
      if (duplicate) return duplicate;
    }

    return this.documents.findOneByType("webhook", {
      provider: input.provider,
      payloadHash: input.payloadHash,
    });
  }

  async findWebhookById(webhookId: MikaId): Promise<WebhookDocument | null> {
    return this.documents.findByIdOfType(webhookId, "webhook");
  }

  async findAccountExport(exportId: MikaId): Promise<AccountExportDocument | null> {
    return this.documents.findByIdOfType(exportId, "accountExport");
  }

  async findAccountDeleteRequest(requestId: MikaId): Promise<AccountDeleteRequestDocument | null> {
    return this.documents.findByIdOfType(requestId, "accountDeleteRequest");
  }

  async listAccountExportsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountExportDocument>> {
    return this.documents.listByType("accountExport", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listAccountDeleteRequestsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return this.documents.listByType("accountDeleteRequest", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listQueuedAccountDeleteRequests(
    limit = 25,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return this.documents.listByType("accountDeleteRequest", {
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      limit,
    });
  }

  async completeAccountDeleteRequest(
    input: AccountDeleteRequestCompletionRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        status: "completed",
        completedAt: input.now,
        userId: undefined,
        emailHash: undefined,
        confirmTokenHash: undefined,
        lastError: undefined,
        metadata: {
          ...request.record.metadata,
          ...input.metadata,
        },
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async recordAccountDeleteMaintenanceStep(
    input: AccountDeleteMaintenanceStepRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        lastError: undefined,
        metadata: accountDeleteMaintenanceStepMetadata(request.record.metadata, input),
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async recordAccountDeleteRequestError(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async failAccountDeleteRequest(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        status: "failed",
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async findProviderSyncRun(runId: MikaId): Promise<ProviderSyncRunDocument | null> {
    return this.documents.findByIdOfType(runId, "providerSyncRun");
  }

  async findWorkflow(workflowId: MikaId): Promise<WorkflowDocument | null> {
    return this.documents.findByIdOfType(workflowId, "workflow");
  }

  async createWorkflow(document: WorkflowDocument): Promise<WorkflowDocument | null> {
    const created = await this.documents.update(document.id, (current) =>
      current === null ? document : null,
    );

    return documentOfType(created, "workflow");
  }

  async listDueWorkflows(
    now: ISODateTime,
    limit = 50,
    kind?: WorkflowDocument["kind"],
  ): Promise<DocumentList<WorkflowDocument>> {
    const target = limit + 1;
    const ready = await listLeaseableWorkflowCandidates(this.documents, now, target, {
      where: {
        ...(kind ? { kind } : {}),
        status: { in: ["queued", "failed"] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: "asc" },
    });
    const expiredRunning = await listLeaseableWorkflowCandidates(this.documents, now, target, {
      where: {
        ...(kind ? { kind } : {}),
        status: "running",
        leaseExpiresAt: { lte: now },
      },
      orderBy: { leaseExpiresAt: "asc" },
    });
    const workflows = Array.from(
      new Map(
        [...ready.items, ...expiredRunning.items].map((item) => [item.id, item] as const),
      ).values(),
    ).sort((left, right) =>
      workflowDueSortKey(left.data).localeCompare(workflowDueSortKey(right.data)),
    );
    const items = workflows.slice(0, limit);
    const hasMore = ready.hasMore || expiredRunning.hasMore || workflows.length > limit;

    return {
      items,
      cursor: hasMore ? String(items.length) : undefined,
      hasMore,
    };
  }

  async reclaimExhaustedWorkflows(
    now: ISODateTime,
    limit = 50,
    kind?: WorkflowDocument["kind"],
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "workflow",
      limit + 1,
      {
        where: {
          ...(kind ? { kind } : {}),
          status: "running",
          leaseExpiresAt: { lte: now },
        },
        orderBy: { leaseExpiresAt: "asc" },
      },
      (workflow) => workflowIsExhausted(workflow, now),
    );

    const stuck = candidates.items.slice(0, limit);
    let reclaimed = 0;
    for (const candidate of stuck) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const workflow = documentOfType(current, "workflow");
        if (!workflow || !workflowIsExhausted(workflow, now)) return null;

        return workflowDocumentWithRecord(workflow, now, {
          status: "failed",
          leaseKey: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          lastError:
            workflow.record.lastError ??
            "Workflow exhausted its lease attempts without completing; marked failed for replay.",
        });
      });
      if (documentOfType(updated, "workflow")) reclaimed += 1;
    }

    return { scanned: stuck.length, reclaimed };
  }

  async purgeWebhookRawPayloads(
    cutoff: ISODateTime,
    now: ISODateTime,
    limit = 50,
  ): Promise<{ readonly scanned: number; readonly purged: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "webhook",
      limit + 1,
      {
        where: { receivedAt: { lte: cutoff } },
        orderBy: { receivedAt: "asc" },
      },
      (webhook) => webhookRawPayloadIsPurgeable(webhook, cutoff),
    );

    const stale = candidates.items.slice(0, limit);
    let purged = 0;
    for (const candidate of stale) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const webhook = documentOfType(current, "webhook");
        if (!webhook || !webhookRawPayloadIsPurgeable(webhook, cutoff)) return null;

        return webhookDocumentWithRecord(webhook, now, {
          rawPayloadJson: undefined,
          rawPayloadPurgedAt: now,
        });
      });
      if (documentOfType(updated, "webhook")) purged += 1;
    }

    return { scanned: stale.length, purged };
  }

  async tryLeaseWorkflow(input: WorkflowLeaseRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (workflow.status === "completed") return null;
      if (!workflowIsDueForLease(workflow, input.now, input.force)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        attemptCount: workflow.record.attemptCount + 1,
        nextAttemptAt: undefined,
        leaseKey: input.leaseKey,
        leasedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async startWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) => {
        if (step.name !== input.stepName || step.status === "completed") return step;

        return {
          ...step,
          status: "running" as const,
          startedAt: input.now,
          failedAt: undefined,
          completedAt: undefined,
          attemptCount: step.attemptCount + 1,
          nextAttemptAt: undefined,
          lastError: undefined,
        };
      });

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        steps,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async completeWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) => {
        if (step.name !== input.stepName || step.status === "completed") return step;

        return {
          ...step,
          status: "completed" as const,
          startedAt: step.startedAt ?? input.now,
          completedAt: input.now,
          failedAt: undefined,
          nextAttemptAt: undefined,
          lastError: undefined,
          ...(input.state ? { state: { ...step.state, ...input.state } } : {}),
        };
      });

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        steps,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async failWorkflowStep(
    input: WorkflowFailureRepositoryInput & { readonly stepName: string },
  ): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) =>
        step.name === input.stepName && step.status !== "completed"
          ? {
              ...step,
              status: "failed" as const,
              failedAt: input.now,
              nextAttemptAt: input.nextAttemptAt,
              lastError: input.lastError,
            }
          : step,
      );

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "failed",
        steps,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async completeWorkflow(input: {
    readonly workflowId: MikaId;
    readonly leaseKey: string;
    readonly now: ISODateTime;
    readonly state?: JsonObject;
  }): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "completed",
        completedAt: input.now,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        resumeState: { ...workflow.record.resumeState, ...input.state },
        steps: workflow.record.steps.map((step) =>
          step.status === "queued"
            ? {
                ...step,
                status: "skipped" as const,
              }
            : step,
        ),
      });
    });

    return documentOfType(updated, "workflow");
  }

  async failWorkflow(input: WorkflowFailureRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "failed",
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        steps: workflow.record.steps.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: "failed",
                failedAt: input.now,
                nextAttemptAt: input.nextAttemptAt,
                lastError: input.lastError,
              }
            : step,
        ),
      });
    });

    return documentOfType(updated, "workflow");
  }

  async findAdminAudit(auditId: MikaId): Promise<AdminAuditDocument | null> {
    return this.documents.findByIdOfType(auditId, "adminAudit");
  }

  async findAdminAuditByIdempotencyKey(
    action: string,
    idempotencyKey: string,
  ): Promise<AdminAuditDocument | null> {
    return findFirstByTypeCandidate(
      this.documents,
      "adminAudit",
      (item) => (item.data.record.action === action ? item.data : null),
      { where: { idempotencyKey } },
    );
  }

  async claimAdminAuditIdempotency(
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult> {
    if (!document.record.idempotencyKey) {
      await this.writeAudit(document);

      return { status: "claimed", audit: document };
    }

    const legacy = await this.findAdminAuditByIdempotencyKey(
      document.record.action,
      document.record.idempotencyKey,
    );
    if (legacy && !adminAuditHasTopLevelAction(legacy)) {
      const reclaimed = await this.reclaimFailedAdminAuditIdempotency(legacy, document);

      return reclaimed ?? { status: "existing", audit: legacy };
    }

    try {
      await this.writeAudit(document);

      return { status: "claimed", audit: document };
    } catch (error) {
      const existing = await this.findAdminAuditByIdempotencyKey(
        document.record.action,
        document.record.idempotencyKey,
      );
      if (existing) {
        const reclaimed = await this.reclaimFailedAdminAuditIdempotency(existing, document);
        if (reclaimed) return reclaimed;
        return { status: "existing", audit: existing };
      }

      throw error;
    }
  }

  private async reclaimFailedAdminAuditIdempotency(
    existing: AdminAuditDocument,
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult | undefined> {
    if (existing.record.status !== "failed" || !adminAuditInputHashMatches(existing, document)) {
      return undefined;
    }

    let reclaimedByThisCall = false;
    const reclaimed = await this.documents.update(existing.id, (current) => {
      const currentAudit = documentOfType(current, "adminAudit");
      if (
        !currentAudit ||
        currentAudit.record.status !== "failed" ||
        !adminAuditInputHashMatches(currentAudit, document)
      ) {
        return current;
      }

      reclaimedByThisCall = true;

      return adminAuditWithId(document, currentAudit.id);
    });
    const audit = documentOfType(reclaimed, "adminAudit");
    if (reclaimedByThisCall && audit?.record.status === "started") {
      return { status: "claimed", audit };
    }
    if (audit) return { status: "existing", audit };

    return undefined;
  }

  async findEmail(emailId: MikaId): Promise<EmailDocument | null> {
    return this.documents.findByIdOfType(emailId, "email");
  }

  async listDueEmails(now: ISODateTime, limit = 50): Promise<DocumentList<EmailDocument>> {
    const target = limit + 1;
    const result = await listByTypeCandidates(
      this.documents,
      "email",
      target,
      {
        where: {
          status: { in: ["queued", "failed"] },
        },
        orderBy: { nextAttemptAt: "asc" },
      },
      (email) => emailIsDueForLease(email, now),
    );
    const items = result.items.slice(0, limit);
    const hasMore = result.hasMore || result.items.length > limit;

    return {
      items,
      cursor: hasMore ? String(items.length) : undefined,
      hasMore,
    };
  }

  async reclaimExhaustedEmails(
    now: ISODateTime,
    limit = 50,
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "email",
      limit + 1,
      {
        where: {
          status: "queued",
        },
        orderBy: { nextAttemptAt: "asc" },
      },
      (email) => emailIsExhaustedLeaseLoss(email, now),
    );

    const exhausted = candidates.items.slice(0, limit);
    let reclaimed = 0;
    for (const candidate of exhausted) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const email = documentOfType(current, "email");
        if (!email || !emailIsExhaustedLeaseLoss(email, now)) return null;

        return emailDocumentWithRecord(email, now, {
          status: "failed",
          nextAttemptAt: undefined,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError:
            email.record.lastError ??
            "Email exhausted its lease attempts without delivery; marked failed for review.",
        });
      });
      if (documentOfType(updated, "email")) reclaimed += 1;
    }

    return { scanned: exhausted.length, reclaimed };
  }

  async tryLeaseEmail(input: EmailLeaseRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailIsDueForLease(email, input.now, input.force)) return null;

      return emailDocumentWithRecord(email, input.now, {
        attemptCount: email.record.attemptCount + 1,
        nextAttemptAt: input.leaseExpiresAt,
        lastError: undefined,
        leaseKey: input.leaseKey,
        leasedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
      });
    });

    return documentOfType(updated, "email");
  }

  async completeEmail(input: EmailCompleteRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "sent",
        providerMessageId: input.providerMessageId,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        sentAt: input.now,
        metadata: emailSentMetadata(email, input.now),
      });
    });

    return documentOfType(updated, "email");
  }

  async markEmailDelivered(input: EmailDeliveredRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (email.record.status === "sent") return email;

      return emailDocumentWithRecord(email, input.now, {
        status: "sent",
        providerMessageId: input.providerMessageId,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        sentAt: input.now,
        metadata: emailSentMetadata(email, input.now),
      });
    });

    return documentOfType(updated, "email");
  }

  async failEmail(input: EmailFailureRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "failed",
        nextAttemptAt: input.nextAttemptAt,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "email");
  }

  async skipEmail(input: EmailSkipRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "skipped",
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "email");
  }

  async redactQueuedFailedEmailsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "email",
      1000,
      {
        where: { status: { in: ["queued", "failed"] } },
        orderBy: { createdAt: "asc" },
      },
      (email) => emailMatchesAccountDeleteIdentity(email, input),
    );
    let redacted = 0;

    for (const item of candidates.items) {
      const updated = await this.documents.update(item.id, (current) => {
        const email = documentOfType(current, "email");
        if (!email || !emailMatchesAccountDeleteIdentity(email, input)) return null;
        if (email.status !== "queued" && email.status !== "failed") return null;

        return emailDocumentWithRecord(email, input.now, {
          customerId: undefined,
          orderId: undefined,
          tokenId: undefined,
          toEmail: `redacted-${email.id}@redacted.invalid`,
          subject: "Redacted email",
          status: "skipped",
          nextAttemptAt: undefined,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError: "Redacted after account deletion.",
          metadata: {
            redactedAt: input.now,
          },
        });
      });

      if (updated) redacted += 1;
    }

    return redacted;
  }

  /** @deprecated Use workflow-specific leasing APIs for webhook fulfillment work. */
  async listWebhookFailures(now: string, limit = 50): Promise<DocumentList<WebhookDocument>> {
    return this.documents.listByType("webhook", {
      where: { status: "failed", nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: "asc" },
      limit,
    });
  }

  async writeAudit(document: AdminAuditDocument): Promise<void> {
    await this.put(document);
  }

  /** @deprecated Use listDueWorkflows for workflow-backed webhook fulfillment. */
  async listDue(
    type: WebhookDocument["type"],
    now: string,
    limit?: number,
  ): Promise<DocumentList<WebhookDocument>>;
  /** @deprecated Use email-specific processing infrastructure when available. */
  async listDue(
    type: EmailDocument["type"],
    now: string,
    limit?: number,
  ): Promise<DocumentList<EmailDocument>>;
  async listDue(
    type: DueOpsDocument["type"],
    now: string,
    limit = 50,
  ): Promise<DocumentList<DueOpsDocument>> {
    return this.dueDocuments.listByType(type, {
      where: { status: "queued", nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: "asc" },
      limit,
    });
  }

  async put(document: OpsDocument): Promise<void> {
    await this.documents.put(document);
  }
}

async function listLeaseableWorkflowCandidates(
  documents: TypedCollectionFacade<OpsDocument>,
  now: ISODateTime,
  target: number,
  options: TypeScopedQueryOptions<WorkflowDocument>,
): Promise<DocumentList<WorkflowDocument>> {
  return listByTypeCandidates(documents, "workflow", target, options, (workflow) =>
    workflowIsDueForLease(workflow, now),
  );
}

function workflowIsDueForLease(
  workflow: WorkflowDocument,
  now: ISODateTime,
  force = false,
): boolean {
  if (workflow.record.leaseExpiresAt && workflow.record.leaseExpiresAt > now) return false;
  if (workflow.status === "running" && !workflow.record.leaseExpiresAt) return false;
  if (force) return workflow.status !== "completed";
  if (workflow.record.attemptCount >= workflow.record.maxAttempts) return false;

  return !workflow.nextAttemptAt || workflow.nextAttemptAt <= now;
}

function workflowIsExhausted(workflow: WorkflowDocument, now: ISODateTime): boolean {
  return (
    workflow.status === "running" &&
    workflow.record.leaseExpiresAt !== undefined &&
    workflow.record.leaseExpiresAt <= now &&
    workflow.record.attemptCount >= workflow.record.maxAttempts
  );
}

function workflowDueSortKey(workflow: WorkflowDocument): ISODateTime {
  return (
    workflow.nextAttemptAt ??
    workflow.record.leaseExpiresAt ??
    workflow.leaseExpiresAt ??
    workflow.updatedAt
  );
}

function webhookRawPayloadIsPurgeable(webhook: WebhookDocument, cutoff: ISODateTime): boolean {
  return (
    webhook.record.receivedAt <= cutoff &&
    webhook.record.rawPayloadJson !== undefined &&
    webhook.record.rawPayloadPurgedAt === undefined &&
    (webhook.status === "processed" || webhook.record.normalizedPayloadJson !== undefined)
  );
}

function webhookDocumentWithRecord(
  webhook: WebhookDocument,
  now: ISODateTime,
  patch: Partial<WebhookDocument["record"]>,
): WebhookDocument {
  const record = {
    ...webhook.record,
    ...patch,
  };

  return {
    ...webhook,
    status: record.status,
    nextAttemptAt: record.nextAttemptAt,
    receivedAt: record.receivedAt,
    record,
    updatedAt: now,
  };
}

function workflowHasActiveLease(
  workflow: WorkflowDocument,
  input: { readonly leaseKey: string; readonly now: ISODateTime },
): boolean {
  if (workflow.status !== "running") return false;
  if (workflow.record.leaseKey !== input.leaseKey) return false;
  if (!workflow.record.leaseExpiresAt || workflow.record.leaseExpiresAt <= input.now) return false;

  return true;
}

function workflowDocumentWithRecord(
  workflow: WorkflowDocument,
  now: ISODateTime,
  patch: Partial<WorkflowDocument["record"]>,
): WorkflowDocument {
  const record = {
    ...workflow.record,
    ...patch,
    updatedAt: now,
  };

  return {
    ...workflow,
    kind: record.kind,
    status: record.status,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    idempotencyKey: record.idempotencyKey,
    nextAttemptAt: record.nextAttemptAt,
    leaseExpiresAt: record.leaseExpiresAt,
    record,
    updatedAt: now,
  };
}

function emailIsDueForLease(email: EmailDocument, now: ISODateTime, force = false): boolean {
  if (email.status === "sent" || email.status === "skipped") return false;
  const leaseExpiresAt = email.record.leaseExpiresAt;
  if (leaseExpiresAt && leaseExpiresAt > now) return false;
  if (force) return true;
  if (email.record.attemptCount >= email.record.maxAttempts) return false;

  return !email.nextAttemptAt || email.nextAttemptAt <= now;
}

function emailIsExhaustedLeaseLoss(email: EmailDocument, now: ISODateTime): boolean {
  if (email.status !== "queued") return false;
  const leaseExpiresAt = email.record.leaseExpiresAt;
  if (!leaseExpiresAt || leaseExpiresAt > now) return false;
  if (email.record.attemptCount < email.record.maxAttempts) return false;

  return !email.record.lastError;
}

function emailHasActiveLease(
  email: EmailDocument,
  input: { readonly leaseKey: string; readonly now: ISODateTime },
): boolean {
  const leaseKey = email.record.leaseKey;
  const leaseExpiresAt = email.record.leaseExpiresAt;

  return leaseKey === input.leaseKey && leaseExpiresAt !== undefined && leaseExpiresAt > input.now;
}

function emailDocumentWithRecord(
  email: EmailDocument,
  now: ISODateTime,
  patch: Partial<EmailDocument["record"]>,
): EmailDocument {
  const record = {
    ...email.record,
    ...patch,
  };

  return {
    ...email,
    status: record.status,
    nextAttemptAt: record.nextAttemptAt,
    orderId: record.orderId,
    tokenId: record.tokenId,
    kind: record.kind,
    record,
    updatedAt: now,
  };
}

function emailSentMetadata(email: EmailDocument, now: ISODateTime): JsonObject | undefined {
  const metadata = email.record.metadata;
  if (email.kind !== "magic_link" || !metadata) return metadata;
  if (metadata["link"] === undefined && metadata["url"] === undefined) return metadata;

  const { link: _link, url: _url, ...redacted } = metadata;
  return {
    ...redacted,
    linkRedactedAt: now,
  };
}

function emailMatchesAccountDeleteIdentity(
  email: EmailDocument,
  identity: AccountDeleteEmailRedactionRepositoryInput,
): boolean {
  const record = email.record;

  return Boolean(
    (identity.customerId && record.customerId === identity.customerId) ||
    (identity.userId && record.metadata?.["userId"] === identity.userId) ||
    (identity.emailHash && record.metadata?.["emailHash"] === identity.emailHash),
  );
}

function accountDeleteMaintenanceStepMetadata(
  metadata: JsonObject | undefined,
  input: AccountDeleteMaintenanceStepRepositoryInput,
): JsonObject {
  const maintenance = jsonObjectChild(metadata, "maintenance");
  const steps = jsonObjectChild(maintenance, "steps");

  return {
    ...metadata,
    maintenance: {
      ...maintenance,
      steps: {
        ...steps,
        [input.stepName]: {
          status: "completed",
          completedAt: input.now,
          result: input.result,
        },
      },
    },
  };
}

function jsonObjectChild(input: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = input?.[key];

  return isJsonObject(value) ? value : undefined;
}

function accountDeleteRequestDocumentWithRecord(
  request: AccountDeleteRequestDocument,
  now: ISODateTime,
  patch: Partial<AccountDeleteRequestDocument["record"]>,
): AccountDeleteRequestDocument {
  const record = {
    ...request.record,
    ...patch,
  };

  return {
    ...request,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    status: record.status,
    expiresAt: record.expiresAt,
    record,
    updatedAt: now,
  };
}

/** Operational repository for atomic stock items, reservations, and movement events. */
export class StockRepository {
  private readonly db: MikaDbExecutor;

  constructor(db: MikaDbExecutor) {
    this.db = db;
  }

  async findItemById(stockItemId: MikaId): Promise<StockItemRecord | null> {
    return findStockItemById(this.db, stockItemId);
  }

  async findBySellableId(sellableId: MikaId): Promise<StockItemRecord | null> {
    const row = await this.db
      .selectFrom("mika_stock_items")
      .selectAll()
      .where("sellable_id", "=", sellableId)
      .executeTakeFirst();

    return row ? mapStockItem(row) : null;
  }

  async findEventByIdempotencyKey(idempotencyKey: string): Promise<StockEventRecord | null> {
    return findStockEventByIdempotencyKey(this.db, idempotencyKey);
  }

  async findEventById(eventId: MikaId): Promise<StockEventRecord | null> {
    return findStockEventById(this.db, eventId);
  }

  /** Upserts stock item including on-hand and reserved quantities on sellable_id conflict. */
  async putItem(record: StockItemRecord): Promise<void> {
    const row: MikaInsertable<"mika_stock_items"> = {
      id: record.id,
      sellable_id: record.sellableId,
      policy: record.policy,
      quantity_on_hand: record.quantityOnHand,
      quantity_reserved: record.quantityReserved,
      low_stock_threshold: record.lowStockThreshold ?? null,
      allow_backorder: record.allowBackorder ? 1 : 0,
      available_override:
        record.availableOverride === undefined ? null : record.availableOverride ? 1 : 0,
      metadata_json: record.metadata ? encodeJson(record.metadata) : null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };

    await this.db
      .insertInto("mika_stock_items")
      .values(row)
      .onConflict((oc) =>
        oc.column("sellable_id").doUpdateSet({
          policy: row.policy,
          quantity_on_hand: row.quantity_on_hand,
          quantity_reserved: row.quantity_reserved,
          low_stock_threshold: row.low_stock_threshold,
          allow_backorder: row.allow_backorder,
          available_override: row.available_override,
          metadata_json: row.metadata_json,
          updated_at: row.updated_at,
        }),
      )
      .execute();
  }

  /** Upserts stock definition only; does not overwrite quantity_on_hand or quantity_reserved. */
  async putItemDefinition(record: StockItemRecord): Promise<void> {
    const row: MikaInsertable<"mika_stock_items"> = {
      id: record.id,
      sellable_id: record.sellableId,
      policy: record.policy,
      quantity_on_hand: record.quantityOnHand,
      quantity_reserved: record.quantityReserved,
      low_stock_threshold: record.lowStockThreshold ?? null,
      allow_backorder: record.allowBackorder ? 1 : 0,
      available_override:
        record.availableOverride === undefined ? null : record.availableOverride ? 1 : 0,
      metadata_json: record.metadata ? encodeJson(record.metadata) : null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };

    await this.db
      .insertInto("mika_stock_items")
      .values(row)
      .onConflict((oc) =>
        oc.column("sellable_id").doUpdateSet({
          policy: row.policy,
          low_stock_threshold: row.low_stock_threshold,
          allow_backorder: row.allow_backorder,
          available_override: row.available_override,
          metadata_json: row.metadata_json,
          updated_at: row.updated_at,
        }),
      )
      .execute();
  }

  async insertEvent(record: StockEventRecord): Promise<void> {
    await insertStockEvent(this.db, record);
  }

  async reserve(input: ReserveStockRepositoryInput): Promise<ReserveStockRepositoryResult> {
    assertReservationQuantity(input.quantity);

    return withTransaction(this.db, (executor) =>
      mutateStockWithEvent({
        executor,
        stockItemId: input.stockItemId,
        idempotencyKey: input.idempotencyKey,
        successStatus: "reserved",
        failureStatus: "insufficient_stock",
        reloadError: `Reserved stock item '${input.stockItemId}' could not be reloaded.`,
        applyStockMutation: (executor) =>
          reserveStockStatement({
            stockItemId: input.stockItemId,
            quantity: input.quantity,
            now: input.now,
          }).execute(executor),
        createEvent: () => ({
          id: input.reservationEventId,
          stockItemId: input.stockItemId,
          kind: "reservation",
          status: "active",
          cartId: input.cartId,
          checkoutSessionId: input.checkoutSessionId,
          customerId: input.customerId,
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          quantityDelta: input.quantity,
          expiresAt: input.expiresAt,
          createdAt: input.now,
          updatedAt: input.now,
          metadata: input.metadata,
        }),
      }),
    );
  }

  async release(
    input: ReleaseReservedStockRepositoryInput,
  ): Promise<ReleaseReservedStockRepositoryResult> {
    return transitionActiveReservation({
      executor: this.db,
      reservationEventId: input.reservationEventId,
      now: input.now,
      targetStatus: "released",
    });
  }

  /**
   * Returns a reservation's held quantity to availability (like {@link release}) but marks the
   * event `expired` rather than `released`. Unlike a released reservation, an expired one can still
   * be consumed via the guarded on-hand path, so a provider payment that completes after a local
   * checkout cancel can still fulfill from available stock instead of failing outright.
   */
  async expire(
    input: ReleaseReservedStockRepositoryInput,
  ): Promise<ExpireReservedStockRepositoryResult> {
    return transitionActiveReservation({
      executor: this.db,
      reservationEventId: input.reservationEventId,
      now: input.now,
      targetStatus: "expired",
    });
  }

  async consume(
    input: ConsumeReservedStockRepositoryInput,
  ): Promise<ConsumeReservedStockRepositoryResult> {
    return withTransaction(this.db, async (executor) => {
      const current = await findStockEventById(executor, input.reservationEventId);
      if (!current || current.kind !== "reservation") {
        return { status: "not_found" };
      }

      if (current.status !== "active" && current.status !== "expired") {
        return {
          status: "not_active",
          event: current,
          stock: await findStockItemById(executor, current.stockItemId),
        };
      }

      const eventMutation = await executor
        .updateTable("mika_stock_events")
        .set({
          status: "consumed",
          updated_at: input.now,
          ...(input.orderId === undefined ? {} : { order_id: input.orderId }),
          ...(input.orderLineId === undefined ? {} : { order_line_id: input.orderLineId }),
        })
        .where("id", "=", input.reservationEventId)
        .where("kind", "=", "reservation")
        .where("status", "in", ["active", "expired"])
        .executeTakeFirst();

      if (!mutationAffected(eventMutation)) {
        const event = await findStockEventById(executor, input.reservationEventId);
        if (!event || event.kind !== "reservation") {
          return { status: "not_found" };
        }
        return {
          status: "not_active",
          event,
          stock: await findStockItemById(executor, event.stockItemId),
        };
      }

      const stockMutation =
        current.status === "active"
          ? await consumeReservedStockStatement({
              stockItemId: current.stockItemId,
              quantity: current.quantityDelta,
              now: input.now,
            }).execute(executor)
          : await consumeOnHandStatement({
              stockItemId: current.stockItemId,
              quantity: current.quantityDelta,
              now: input.now,
            }).execute(executor);
      if (!mutationAffected(stockMutation)) {
        if (current.status === "expired") {
          throw new Error(
            `Reservation event '${current.id}' cannot be consumed: insufficient available stock to fulfill the expired reservation without overselling.`,
          );
        }
        throw new Error(
          `Stock item '${current.stockItemId}' for reservation event '${current.id}' could not be updated.`,
        );
      }

      const event = await findStockEventById(executor, input.reservationEventId);
      const stock = await findStockItemById(executor, current.stockItemId);
      if (!event || !stock) {
        throw new Error(
          `Reservation event '${input.reservationEventId}' could not be reloaded after stock mutation.`,
        );
      }

      return { status: "consumed", event, stock };
    });
  }

  async releaseExpiredReservations(
    input: ReleaseExpiredReservationsRepositoryInput,
  ): Promise<ReleaseExpiredReservationsRepositoryResult> {
    return withTransaction(this.db, async (executor) => {
      const expiredRows = await executor
        .selectFrom("mika_stock_events")
        .selectAll()
        .where("kind", "=", "reservation")
        .where("status", "=", "active")
        .where("expires_at", "is not", null)
        .where("expires_at", "<=", input.now)
        .orderBy("id", "asc")
        .execute();
      let releasedCount = 0;
      const affectedStockItemIds = new Set<MikaId>();

      for (const row of expiredRows) {
        const event = mapStockEvent(row);
        const eventMutation = await executor
          .updateTable("mika_stock_events")
          .set({
            status: "expired",
            idempotency_key: null,
            updated_at: input.now,
          })
          .where("id", "=", event.id)
          .where("kind", "=", "reservation")
          .where("status", "=", "active")
          .where("expires_at", "is not", null)
          .where("expires_at", "<=", input.now)
          .executeTakeFirst();

        if (!mutationAffected(eventMutation)) continue;

        const stockMutation = await releaseStockStatement({
          stockItemId: event.stockItemId,
          quantity: event.quantityDelta,
          now: input.now,
        }).execute(executor);
        if (!mutationAffected(stockMutation)) {
          throw new Error(
            `Stock item '${event.stockItemId}' for expired reservation event '${event.id}' could not be updated.`,
          );
        }

        releasedCount += 1;
        affectedStockItemIds.add(event.stockItemId);
      }

      return {
        scannedCount: expiredRows.length,
        releasedCount,
        stockItemsAffected: affectedStockItemIds.size,
      };
    });
  }

  async extendReservations(input: ExtendReservationsRepositoryInput): Promise<void> {
    if (input.reservationEventIds.length === 0) return;

    await this.db
      .updateTable("mika_stock_events")
      .set({ expires_at: input.expiresAt, updated_at: input.now })
      .where("id", "in", [...input.reservationEventIds])
      .where("kind", "=", "reservation")
      .where("status", "=", "active")
      .where((eb) =>
        eb.or([eb("expires_at", "is", null), eb("expires_at", "<", input.expiresAt)]),
      )
      .execute();
  }

  async releaseActiveReservationsByCustomer(
    input: ReleaseActiveReservationsByCustomerRepositoryInput,
  ): Promise<ReleaseExpiredReservationsRepositoryResult> {
    return withTransaction(this.db, async (executor) => {
      const activeRows = await executor
        .selectFrom("mika_stock_events")
        .selectAll()
        .where("kind", "=", "reservation")
        .where("status", "=", "active")
        .where("customer_id", "=", input.customerId)
        .orderBy("id", "asc")
        .execute();
      let releasedCount = 0;
      const affectedStockItemIds = new Set<MikaId>();

      for (const row of activeRows) {
        const event = mapStockEvent(row);
        const eventMutation = await executor
          .updateTable("mika_stock_events")
          .set({
            status: "released",
            idempotency_key: null,
            updated_at: input.now,
          })
          .where("id", "=", event.id)
          .where("kind", "=", "reservation")
          .where("status", "=", "active")
          .where("customer_id", "=", input.customerId)
          .executeTakeFirst();

        if (!mutationAffected(eventMutation)) continue;

        const stockMutation = await releaseStockStatement({
          stockItemId: event.stockItemId,
          quantity: event.quantityDelta,
          now: input.now,
        }).execute(executor);
        if (!mutationAffected(stockMutation)) {
          throw new Error(
            `Stock item '${event.stockItemId}' for account-delete reservation event '${event.id}' could not be updated.`,
          );
        }

        releasedCount += 1;
        affectedStockItemIds.add(event.stockItemId);
      }

      return {
        scannedCount: activeRows.length,
        releasedCount,
        stockItemsAffected: affectedStockItemIds.size,
      };
    });
  }

  async adjustStock(input: AdjustStockRepositoryInput): Promise<AdjustStockRepositoryResult> {
    assertStockAdjustmentQuantity(input.quantityDelta);

    return withTransaction(this.db, (executor) =>
      mutateStockWithEvent({
        executor,
        stockItemId: input.stockItemId,
        idempotencyKey: input.idempotencyKey,
        successStatus: "adjusted",
        failureStatus: (stock) => stockAdjustmentFailureStatus(stock, input.quantityDelta),
        reloadError: `Adjusted stock item '${input.stockItemId}' could not be reloaded.`,
        applyStockMutation: (executor) =>
          adjustStockStatement({
            stockItemId: input.stockItemId,
            quantityDelta: input.quantityDelta,
            now: input.now,
          }).execute(executor),
        createEvent: () => ({
          id: input.movementEventId,
          stockItemId: input.stockItemId,
          kind: "movement",
          status: "recorded",
          reason: input.reason ?? "manual_adjustment",
          adminAuditId: input.adminAuditId,
          idempotencyKey: input.idempotencyKey,
          quantityDelta: input.quantityDelta,
          createdAt: input.now,
          updatedAt: input.now,
          metadata: input.metadata,
        }),
      }),
    );
  }
}

function stockAdjustmentFailureStatus(
  stock: StockItemRecord,
  quantityDelta: number,
): "would_go_negative" | "would_undercut_reserved" {
  const nextQuantityOnHand = stock.quantityOnHand + quantityDelta;
  if (nextQuantityOnHand < 0) return "would_go_negative";
  if (
    quantityDelta < 0 &&
    stock.policy === "finite" &&
    !stock.allowBackorder &&
    nextQuantityOnHand < stock.quantityReserved
  ) {
    return "would_undercut_reserved";
  }

  return "would_go_negative";
}

async function mutateStockWithEvent<
  TSuccessStatus extends string,
  TFailureStatus extends string,
>(input: {
  readonly executor: MikaDbExecutor;
  readonly stockItemId: MikaId;
  readonly idempotencyKey?: string;
  readonly successStatus: TSuccessStatus;
  readonly failureStatus: TFailureStatus | ((stock: StockItemRecord) => TFailureStatus);
  readonly reloadError: string;
  readonly applyStockMutation: (executor: MikaDbExecutor) => Promise<StockMutationResult>;
  readonly createEvent: () => StockEventRecord;
}): Promise<
  | {
      readonly status: TSuccessStatus;
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "replayed";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: "idempotency_conflict";
      readonly event: StockEventRecord;
      readonly stock: StockItemRecord | null;
    }
  | {
      readonly status: TFailureStatus;
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "not_found";
    }
> {
  const replayed =
    input.idempotencyKey === undefined
      ? null
      : await findStockEventByIdempotencyKey(input.executor, input.idempotencyKey);
  if (replayed) {
    const replayedStock = await findStockItemById(input.executor, replayed.stockItemId);
    if (replayed.stockItemId !== input.stockItemId) {
      return {
        status: "idempotency_conflict",
        event: replayed,
        stock: replayedStock,
      };
    }

    return {
      status: "replayed",
      event: replayed,
      stock: replayedStock,
    };
  }

  const current = await findStockItemById(input.executor, input.stockItemId);
  if (!current) {
    return { status: "not_found" };
  }

  const mutation = await input.applyStockMutation(input.executor);
  if (!mutationAffected(mutation)) {
    const failureStatus =
      typeof input.failureStatus === "function"
        ? input.failureStatus(current)
        : input.failureStatus;

    return { status: failureStatus, stock: current };
  }

  const event = input.createEvent();
  await insertStockEvent(input.executor, event);

  const stock = await findStockItemById(input.executor, input.stockItemId);
  if (!stock) {
    throw new Error(input.reloadError);
  }

  return { status: input.successStatus, event, stock };
}

async function transitionActiveReservation<TStatus extends "released" | "expired">(input: {
  readonly executor: MikaDbExecutor;
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
  readonly targetStatus: TStatus;
}): Promise<ReservationEventMutationRepositoryResult<TStatus>> {
  return mutateActiveReservationEvent({
    executor: input.executor,
    reservationEventId: input.reservationEventId,
    now: input.now,
    targetStatus: input.targetStatus,
    eventPatch: { idempotency_key: null },
    applyStockMutation: (executor, event) =>
      releaseStockStatement({
        stockItemId: event.stockItemId,
        quantity: event.quantityDelta,
        now: input.now,
      }).execute(executor),
  });
}

async function mutateActiveReservationEvent<TStatus extends "released" | "consumed" | "expired">(input: {
  readonly executor: MikaDbExecutor;
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
  readonly targetStatus: TStatus;
  readonly eventPatch?: MikaUpdateable<"mika_stock_events">;
  readonly applyStockMutation: (
    executor: MikaDbExecutor,
    event: StockEventRecord,
  ) => Promise<StockMutationResult>;
}): Promise<ReservationEventMutationRepositoryResult<TStatus>> {
  return withTransaction(input.executor, async (executor) => {
    const current = await findStockEventById(executor, input.reservationEventId);
    if (!current || current.kind !== "reservation") {
      return { status: "not_found" };
    }

    if (current.status !== "active") {
      return {
        status: "not_active",
        event: current,
        stock: await findStockItemById(executor, current.stockItemId),
      };
    }

    const eventMutation = await executor
      .updateTable("mika_stock_events")
      .set({
        status: input.targetStatus,
        updated_at: input.now,
        ...input.eventPatch,
      })
      .where("id", "=", input.reservationEventId)
      .where("kind", "=", "reservation")
      .where("status", "=", "active")
      .executeTakeFirst();

    if (!mutationAffected(eventMutation)) {
      const event = await findStockEventById(executor, input.reservationEventId);
      if (!event || event.kind !== "reservation") {
        return { status: "not_found" };
      }

      return {
        status: "not_active",
        event,
        stock: await findStockItemById(executor, event.stockItemId),
      };
    }

    const stockMutation = await input.applyStockMutation(executor, current);
    if (!mutationAffected(stockMutation)) {
      throw new Error(
        `Stock item '${current.stockItemId}' for reservation event '${current.id}' could not be updated.`,
      );
    }

    const event = await findStockEventById(executor, input.reservationEventId);
    const stock = await findStockItemById(executor, current.stockItemId);
    if (!event || !stock) {
      throw new Error(
        `Reservation event '${input.reservationEventId}' could not be reloaded after stock mutation.`,
      );
    }

    return { status: input.targetStatus, event, stock };
  });
}

async function insertStockEvent(executor: MikaDbExecutor, record: StockEventRecord): Promise<void> {
  await executor
    .insertInto("mika_stock_events")
    .values({
      id: record.id,
      stock_item_id: record.stockItemId,
      kind: record.kind,
      status: record.status,
      reason: record.reason ?? null,
      reservation_event_id: record.reservationEventId ?? null,
      cart_id: record.cartId ?? null,
      checkout_session_id: record.checkoutSessionId ?? null,
      customer_id: record.customerId ?? null,
      session_id: record.sessionId ?? null,
      order_id: record.orderId ?? null,
      order_line_id: record.orderLineId ?? null,
      admin_audit_id: record.adminAuditId ?? null,
      idempotency_key: record.idempotencyKey ?? null,
      quantity_delta: record.quantityDelta,
      expires_at: record.expiresAt ?? null,
      metadata_json: record.metadata ? encodeJson(record.metadata) : null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    })
    .execute();
}

/** Operational repository for TTL-bound ephemeral records and token consumption. */
export class EphemeralRepository {
  private readonly db: MikaDbExecutor;

  constructor(db: MikaDbExecutor) {
    this.db = db;
  }

  async get(key: string): Promise<EphemeralRecord | null> {
    const row = await this.db
      .selectFrom("mika_ephemeral_records")
      .selectAll()
      .where("key", "=", key)
      .executeTakeFirst();

    return row ? mapEphemeral(row) : null;
  }

  async put(record: EphemeralRecord): Promise<void> {
    await this.db
      .insertInto("mika_ephemeral_records")
      .values({
        key: record.key,
        kind: record.kind,
        subject_hash: record.subjectHash ?? null,
        status: record.status,
        count: record.count,
        expires_at: record.expiresAt,
        version: record.version,
        data_json: record.data ? encodeJson(record.data) : null,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          kind: record.kind,
          subject_hash: record.subjectHash ?? null,
          status: record.status,
          count: record.count,
          expires_at: record.expiresAt,
          version: record.version,
          data_json: record.data ? encodeJson(record.data) : null,
          updated_at: record.updatedAt,
        }),
      )
      .execute();
  }

  async incrementCounter(input: {
    readonly key: string;
    readonly kind: EphemeralRecord["kind"];
    readonly subjectHash?: string;
    readonly status?: string;
    readonly expiresAt: ISODateTime;
    readonly now: ISODateTime;
    readonly data?: JsonObject;
  }): Promise<EphemeralRecord> {
    await this.db
      .insertInto("mika_ephemeral_records")
      .values({
        key: input.key,
        kind: input.kind,
        subject_hash: input.subjectHash ?? null,
        status: input.status ?? "active",
        count: 1,
        expires_at: input.expiresAt,
        version: 1,
        data_json: input.data ? encodeJson(input.data) : null,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          kind: input.kind,
          subject_hash: input.subjectHash ?? null,
          status: input.status ?? "active",
          count: sql<number>`count + 1`,
          version: sql<number>`version + 1`,
          expires_at: input.expiresAt,
          data_json: input.data ? encodeJson(input.data) : null,
          updated_at: input.now,
        }),
      )
      .execute();

    const record = await this.get(input.key);
    if (!record) {
      throw new Error(`Failed to increment ephemeral record '${input.key}'.`);
    }

    return record;
  }

  async tryAcquireLock(input: {
    readonly key: string;
    readonly owner: string;
    readonly subjectHash?: string;
    readonly expiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<EphemeralRecord | null> {
    const ownerData = ephemeralLockOwnerData(input.owner);
    const updated = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        subject_hash: input.subjectHash ?? null,
        status: "held",
        count: eb("count", "+", 1),
        expires_at: input.expiresAt,
        version: eb("version", "+", 1),
        data_json: ownerData,
        updated_at: input.now,
      }))
      .where("key", "=", input.key)
      .where("kind", "=", "lock")
      .where((eb) =>
        eb.or([
          eb("status", "!=", "held"),
          eb("expires_at", "<=", input.now),
          eb("data_json", "=", ownerData),
        ]),
      )
      .executeTakeFirst();
    if (affected(updated.numUpdatedRows)) return this.get(input.key);

    const inserted = await this.db
      .insertInto("mika_ephemeral_records")
      .values({
        key: input.key,
        kind: "lock",
        subject_hash: input.subjectHash ?? null,
        status: "held",
        count: 1,
        expires_at: input.expiresAt,
        version: 1,
        data_json: ownerData,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflict((oc) => oc.column("key").doNothing())
      .executeTakeFirst();

    return affected(inserted.numInsertedOrUpdatedRows) ? this.get(input.key) : null;
  }

  async releaseLock(input: {
    readonly key: string;
    readonly owner: string;
    readonly now: ISODateTime;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        status: "released",
        expires_at: input.now,
        version: eb("version", "+", 1),
        updated_at: input.now,
      }))
      .where("key", "=", input.key)
      .where("kind", "=", "lock")
      .where("status", "=", "held")
      .where("data_json", "=", ephemeralLockOwnerData(input.owner))
      .executeTakeFirst();

    return affected(result.numUpdatedRows);
  }

  async consumeToken(key: string, now: ISODateTime): Promise<boolean> {
    const result = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        status: "consumed",
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("key", "=", key)
      .where("kind", "=", "token")
      .where("status", "=", "pending")
      .where("expires_at", ">", now)
      .executeTakeFirst();

    return affected(result.numUpdatedRows);
  }

  async restoreToken(key: string, now: ISODateTime): Promise<boolean> {
    const result = await this.db
      .updateTable("mika_ephemeral_records")
      .set((eb) => ({
        status: "pending",
        version: eb("version", "+", 1),
        updated_at: now,
      }))
      .where("key", "=", key)
      .where("kind", "=", "token")
      .where("status", "=", "consumed")
      .executeTakeFirst();

    return affected(result.numUpdatedRows);
  }

  async purgeExpired(now: ISODateTime): Promise<number> {
    const result = await this.db
      .deleteFrom("mika_ephemeral_records")
      .where("expires_at", "<=", now)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  async deleteTokensBySubjectHashes(subjectHashes: readonly string[]): Promise<number> {
    if (subjectHashes.length === 0) return 0;

    const result = await this.db
      .deleteFrom("mika_ephemeral_records")
      .where("kind", "=", "token")
      .where("subject_hash", "in", [...new Set(subjectHashes)])
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }
}

/** Facade wiring document and operational repositories for the commerce storage model. */
export class MikaRepositories {
  readonly catalog: CatalogRepository;
  readonly session: SessionRepository;
  readonly account: AccountRepository;
  readonly ledger: LedgerRepository;
  readonly ops: OpsRepository;
  readonly stock: StockRepository;
  readonly ephemeral: EphemeralRepository;

  constructor(storage: MikaStorageCollections, db: MikaDbExecutor) {
    this.catalog = new CatalogRepository(storage.catalog);
    this.session = new SessionRepository(storage.session);
    this.account = new AccountRepository(storage.account);
    this.ledger = new LedgerRepository(storage.ledger);
    this.ops = new OpsRepository(storage.ops);
    this.stock = new StockRepository(db);
    this.ephemeral = new EphemeralRepository(db);
  }
}

/** Constructs the full repository facade from storage collections and a db executor. */
export function createMikaRepositories(input: {
  readonly storage: MikaStorageCollections;
  readonly db: MikaDbExecutor;
}): MikaRepositories {
  return new MikaRepositories(input.storage, input.db);
}

function mapStockItem(row: MikaSelectable<"mika_stock_items">): StockItemRecord {
  return {
    id: createMikaId(row.id),
    sellableId: createMikaId(row.sellable_id),
    policy: row.policy,
    quantityOnHand: row.quantity_on_hand,
    quantityReserved: row.quantity_reserved,
    lowStockThreshold: undef(row.low_stock_threshold),
    allowBackorder: row.allow_backorder === 1,
    availableOverride: boolOrUndefined(row.available_override),
    createdAt: createISODateTime(row.created_at),
    updatedAt: createISODateTime(row.updated_at),
    metadata: parseMetadata(row.metadata_json),
  };
}

async function findStockItemById(
  executor: MikaDbExecutor,
  stockItemId: MikaId,
): Promise<StockItemRecord | null> {
  const row = await executor
    .selectFrom("mika_stock_items")
    .selectAll()
    .where("id", "=", stockItemId)
    .executeTakeFirst();

  return row ? mapStockItem(row) : null;
}

async function findStockEventByIdempotencyKey(
  executor: MikaDbExecutor,
  idempotencyKey: string,
): Promise<StockEventRecord | null> {
  const row = await executor
    .selectFrom("mika_stock_events")
    .selectAll()
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();

  return row ? mapStockEvent(row) : null;
}

async function findStockEventById(
  executor: MikaDbExecutor,
  eventId: MikaId,
): Promise<StockEventRecord | null> {
  const row = await executor
    .selectFrom("mika_stock_events")
    .selectAll()
    .where("id", "=", eventId)
    .executeTakeFirst();

  return row ? mapStockEvent(row) : null;
}

function mapStockEvent(row: MikaSelectable<"mika_stock_events">): StockEventRecord {
  return {
    id: createMikaId(row.id),
    stockItemId: createMikaId(row.stock_item_id),
    kind: row.kind,
    status: row.status,
    reason: row.reason ? (row.reason as NonNullable<StockEventRecord["reason"]>) : undefined,
    reservationEventId: mikaIdOrUndefined(row.reservation_event_id),
    cartId: mikaIdOrUndefined(row.cart_id),
    checkoutSessionId: mikaIdOrUndefined(row.checkout_session_id),
    customerId: mikaIdOrUndefined(row.customer_id),
    sessionId: undef(row.session_id),
    orderId: mikaIdOrUndefined(row.order_id),
    orderLineId: mikaIdOrUndefined(row.order_line_id),
    adminAuditId: mikaIdOrUndefined(row.admin_audit_id),
    idempotencyKey: undef(row.idempotency_key),
    quantityDelta: row.quantity_delta,
    expiresAt: isoOrUndefined(row.expires_at),
    createdAt: createISODateTime(row.created_at),
    updatedAt: createISODateTime(row.updated_at),
    metadata: parseMetadata(row.metadata_json),
  };
}

function mapEphemeral(row: MikaSelectable<"mika_ephemeral_records">): EphemeralRecord {
  return {
    key: row.key,
    kind: row.kind,
    subjectHash: undef(row.subject_hash),
    status: row.status,
    count: row.count,
    expiresAt: createISODateTime(row.expires_at),
    version: row.version,
    createdAt: createISODateTime(row.created_at),
    updatedAt: createISODateTime(row.updated_at),
    data: parseMetadata(row.data_json),
  };
}

function ephemeralLockOwnerData(owner: string): string {
  return encodeJson({ owner });
}

function parseMetadata(text: string | null): JsonObject | undefined {
  if (!text) return undefined;
  return decodeJsonObject(text, "Mika metadata");
}

function undef<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

function isoOrUndefined(value: string | null): ReturnType<typeof createISODateTime> | undefined {
  return value === null ? undefined : createISODateTime(value);
}

function mikaIdOrUndefined(value: string | null): MikaId | undefined {
  return value === null ? undefined : createMikaId(value);
}

function boolOrUndefined(value: 0 | 1 | null): boolean | undefined {
  if (value === null) return undefined;
  return value === 1;
}

function assertReservationQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError("Stock reservation quantity must be a positive whole number.");
  }
}

function assertStockAdjustmentQuantity(quantityDelta: number): void {
  if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
    throw new RangeError("Stock adjustment quantity must be a non-zero whole number.");
  }
}

async function withTransaction<T>(
  executor: MikaDbExecutor,
  operation: (executor: MikaDbExecutor) => Promise<T>,
): Promise<T> {
  if (hasTransaction(executor)) {
    return executor.transaction().execute(operation);
  }

  return operation(executor);
}

function hasTransaction(executor: MikaDbExecutor): executor is MikaDb {
  return typeof (executor as { readonly transaction?: unknown }).transaction === "function";
}

function mutationAffected(result: StockMutationResult): boolean {
  return affected(result.numAffectedRows ?? result.numUpdatedRows ?? result.numChangedRows);
}

function affected(count: bigint | number | undefined): boolean {
  if (typeof count === "bigint") return count > 0n;
  return (count ?? 0) > 0;
}
