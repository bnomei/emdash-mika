import type { MikaStorageDocuments } from "../types/documents";

type KeysOfUnion<TValue> = TValue extends TValue ? keyof TValue : never;
type StorageField<TDocument> = Extract<KeysOfUnion<TDocument>, string>;

export type MikaIndex<TDocument = Record<string, unknown>> =
  | StorageField<TDocument>
  | readonly StorageField<TDocument>[];

export interface MikaStorageCollectionConfig<TDocument = Record<string, unknown>> {
  readonly indexes: readonly MikaIndex<TDocument>[];
  readonly uniqueIndexes?: readonly MikaIndex<TDocument>[];
}

export type MikaStorageConfig = {
  readonly [K in keyof MikaStorageDocuments]: MikaStorageCollectionConfig<MikaStorageDocuments[K]>;
};

export const MIKA_STORAGE_COLLECTION_NAMES = [
  "catalog",
  "session",
  "account",
  "ledger",
  "ops",
] as const satisfies readonly (keyof MikaStorageDocuments)[];

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
      "expiresAt",
      ["type", "status"],
      ["type", "sessionId"],
      ["type", "sessionId", "currency"],
      ["type", "customerId"],
      ["status", "expiresAt"],
    ],
    uniqueIndexes: [["provider", "providerCheckoutId"]],
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
      ["provider", "providerCustomerId"],
      ["provider", "providerSubscriptionId"],
      ["emailHash", "entitlementKey", "status"],
      ["customerId", "entitlementKey", "status"],
    ],
    uniqueIndexes: [
      ["provider", "providerCustomerId"],
      ["provider", "providerSubscriptionId"],
    ],
  },
  ledger: {
    indexes: [
      "type",
      "orderNumber",
      "customerId",
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
      ["status", "createdAt"],
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
      "payloadHash",
      "nextAttemptAt",
      "receivedAt",
      "expiresAt",
      "customerId",
      "userId",
      "actorId",
      "targetType",
      "targetId",
      "createdAt",
      ["type", "status"],
      ["type", "customerId"],
      ["type", "userId"],
      ["type", "expiresAt"],
      ["status", "nextAttemptAt"],
      ["provider", "providerEventId"],
      ["provider", "eventType", "payloadHash"],
      ["targetType", "targetId"],
    ],
    uniqueIndexes: [
      ["provider", "providerEventId"],
      ["provider", "eventType", "payloadHash"],
    ],
  },
} satisfies MikaStorageConfig;

export function createMikaStorageConfig(): MikaStorageConfig {
  return mikaStorageConfig;
}

export type MikaStorageCollections = {
  readonly [K in keyof MikaStorageDocuments]: StorageCollection<MikaStorageDocuments[K]>;
};

export interface StorageCollection<TDocument> {
  get(id: string): Promise<TDocument | null>;
  put(id: string, data: TDocument): Promise<void>;
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

export interface StorageQueryOptions<TDocument = Record<string, unknown>> {
  readonly where?: StorageWhereClause<TDocument>;
  readonly orderBy?: Partial<Record<StorageField<TDocument>, "asc" | "desc">>;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface StorageRangeFilter {
  readonly gt?: number | string;
  readonly gte?: number | string;
  readonly lt?: number | string;
  readonly lte?: number | string;
}

export interface StorageInFilter {
  readonly in: readonly (string | number)[];
}

export interface StorageStartsWithFilter {
  readonly startsWith: string;
}

export type StorageWhereValue =
  | string
  | number
  | boolean
  | null
  | StorageRangeFilter
  | StorageInFilter
  | StorageStartsWithFilter;

export type StorageWhereClause<TDocument = Record<string, unknown>> = Partial<
  Record<StorageField<TDocument>, StorageWhereValue>
>;

export interface PaginatedStorageResult<TItem> {
  readonly items: TItem[];
  readonly cursor?: string;
  readonly hasMore: boolean;
}
