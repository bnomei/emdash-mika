/**
 * Document collection configuration and query contracts for indexed storage backends.
 * Defines per-collection indexes used to resolve documents by aggregate and record fields.
 */
import type { MikaStorageDocuments } from "../types/documents";

type KeysOfUnion<TValue> = TValue extends TValue ? keyof TValue : never;
type StorageField<TDocument> = Extract<KeysOfUnion<TDocument>, string>;

/** Single or compound index field path on a stored document. */
export type MikaIndex<TDocument = Record<string, unknown>> =
  | StorageField<TDocument>
  | readonly StorageField<TDocument>[];

/** Index and uniqueness configuration for one document collection. */
export interface MikaStorageCollectionConfig<TDocument = Record<string, unknown>> {
  readonly indexes: readonly MikaIndex<TDocument>[];
  readonly uniqueIndexes?: readonly MikaIndex<TDocument>[];
}

/** Index configuration keyed by storage collection name. */
export type MikaStorageConfig = {
  readonly [K in keyof MikaStorageDocuments]: MikaStorageCollectionConfig<MikaStorageDocuments[K]>;
};

/** Ordered list of document collection names in the storage partition. */
export const MIKA_STORAGE_COLLECTION_NAMES = [
  "catalog",
  "session",
  "account",
  "ledger",
  "ops",
] as const satisfies readonly (keyof MikaStorageDocuments)[];

/** Default index configuration for catalog, session, account, ledger, and ops documents. */
export const mikaStorageConfig = {
  catalog: {
    indexes: [
      "type",
      "active",
      "contentCollection",
      "contentId",
      "codeHash",
      ["type", "active"],
      ["contentCollection", "contentId"],
    ],
    uniqueIndexes: [["contentCollection", "contentId"], "codeHash"],
  },
  session: {
    indexes: [
      "type",
      "status",
      "sessionId",
      "customerId",
      "cartId",
      "currency",
      "provider",
      "providerCheckoutId",
      "checkoutIdempotencyKey",
      "providerStatus",
      "redirectUrl",
      "orderId",
      "expiresAt",
      ["type", "status"],
      ["type", "sessionId"],
      ["type", "sessionId", "currency"],
      ["type", "customerId"],
      ["type", "checkoutIdempotencyKey"],
      ["type", "orderId"],
      ["status", "expiresAt"],
    ],
    uniqueIndexes: [
      ["provider", "providerCheckoutId"],
      ["type", "provider", "providerCheckoutId"],
      ["type", "checkoutIdempotencyKey"],
    ],
  },
  account: {
    indexes: [
      "type",
      "customerId",
      "userId",
      "emailHash",
      "provider",
      "providerCustomerId",
      "providerSubscriptionId",
      "entitlementKey",
      "status",
      "currentPeriodEnd",
      ["type", "customerId"],
      ["type", "userId"],
      ["type", "customerId", "updatedAt"],
      ["type", "userId", "updatedAt"],
      ["type", "emailHash", "updatedAt"],
      ["type", "customerId", "currentPeriodEnd"],
      ["type", "provider", "providerCustomerId"],
      ["type", "provider", "providerSubscriptionId"],
      ["emailHash", "entitlementKey", "status"],
      ["customerId", "entitlementKey", "status"],
    ],
    uniqueIndexes: [
      ["type", "provider", "providerCustomerId"],
      ["type", "provider", "providerSubscriptionId"],
    ],
  },
  ledger: {
    indexes: [
      "type",
      "orderNumber",
      "customerId",
      "emailHash",
      "provider",
      "providerCheckoutId",
      "providerPaymentId",
      "providerOrderId",
      "checkoutSessionId",
      "status",
      "paymentStatus",
      "currency",
      "totalAmount",
      "paidAt",
      "createdAt",
      ["customerId", "createdAt"],
      ["emailHash", "createdAt"],
      ["status", "createdAt"],
      ["type", "customerId", "createdAt"],
      ["provider", "providerPaymentId"],
      ["provider", "providerOrderId"],
    ],
    uniqueIndexes: [
      "orderNumber",
      ["provider", "providerPaymentId"],
      ["provider", "providerOrderId"],
      "checkoutSessionId",
    ],
  },
  ops: {
    indexes: [
      "type",
      "status",
      "provider",
      "providerEventId",
      "eventType",
      "kind",
      "payloadHash",
      "nextAttemptAt",
      "receivedAt",
      "expiresAt",
      "customerId",
      "userId",
      "actorId",
      "targetType",
      "targetId",
      "subjectType",
      "subjectId",
      "idempotencyKey",
      "leaseExpiresAt",
      "createdAt",
      ["type", "status"],
      ["kind", "status"],
      ["type", "kind", "status", "nextAttemptAt"],
      ["type", "kind", "subjectType", "subjectId"],
      ["type", "kind", "idempotencyKey"],
      ["status", "leaseExpiresAt"],
      ["type", "customerId"],
      ["type", "userId"],
      ["type", "expiresAt"],
      ["status", "nextAttemptAt"],
      ["provider", "providerEventId"],
      ["provider", "payloadHash"],
      ["targetType", "targetId"],
      ["subjectType", "subjectId"],
    ],
    uniqueIndexes: [
      ["provider", "providerEventId"],
      ["provider", "payloadHash"],
      ["type", "kind", "idempotencyKey"],
      ["type", "kind", "subjectType", "subjectId"],
    ],
  },
} satisfies MikaStorageConfig;

/** Returns the default document collection index configuration. */
export function createMikaStorageConfig(): MikaStorageConfig {
  return mikaStorageConfig;
}

/** Runtime storage collection handles keyed by document partition. */
export type MikaStorageCollections = {
  readonly [K in keyof MikaStorageDocuments]: StorageCollection<MikaStorageDocuments[K]>;
};

/** Generic document collection port for CRUD and indexed query operations. */
export interface StorageCollection<TDocument> {
  get(id: string): Promise<TDocument | null>;
  put(id: string, data: TDocument): Promise<void>;
  update(
    id: string,
    updater: (current: TDocument | null) => TDocument | null,
  ): Promise<TDocument | null>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  getMany(ids: string[]): Promise<Map<string, TDocument>>;
  putMany(items: Array<{ id: string; data: TDocument }>): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  query(
    options?: StorageQueryOptions<TDocument>,
  ): Promise<PaginatedStorageResult<{ id: string; data: TDocument }>>;
  count(where?: StorageWhereClause<TDocument>): Promise<number>;
}

/** Query options for filtering, ordering, and paginating stored documents. */
export interface StorageQueryOptions<TDocument = Record<string, unknown>> {
  readonly where?: StorageWhereClause<TDocument>;
  readonly orderBy?: Partial<Record<StorageField<TDocument>, "asc" | "desc">>;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Range comparison filter for indexed document fields. */
export interface StorageRangeFilter {
  readonly gt?: number | string;
  readonly gte?: number | string;
  readonly lt?: number | string;
  readonly lte?: number | string;
}

/** Membership filter for indexed document fields. */
export interface StorageInFilter {
  readonly in: readonly (string | number)[];
}

/** Prefix filter for string indexed document fields. */
export interface StorageStartsWithFilter {
  readonly startsWith: string;
}

/** Allowed where-clause value shapes for document queries. */
export type StorageWhereValue =
  | string
  | number
  | boolean
  | null
  | StorageRangeFilter
  | StorageInFilter
  | StorageStartsWithFilter;

/** Partial equality and filter map over indexed document fields. */
export type StorageWhereClause<TDocument = Record<string, unknown>> = Partial<
  Record<StorageField<TDocument>, StorageWhereValue>
>;

/** Cursor-paginated query result from a document collection. */
export interface PaginatedStorageResult<TItem> {
  readonly items: TItem[];
  readonly cursor?: string;
  readonly hasMore: boolean;
}
