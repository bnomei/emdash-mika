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
  WishlistDocument,
} from "../types/documents";
import type { EphemeralRecord, StockEventRecord, StockItemRecord } from "../types/operational";
import {
  createISODateTime,
  createMikaId,
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
  consumeReservedStockStatement,
  releaseStockStatement,
  reserveStockStatement,
} from "./statements";

export type MikaDb = Kysely<MikaDatabase>;
export type MikaTransaction = Transaction<MikaDatabase>;
export type MikaDbExecutor = MikaDb | MikaTransaction;

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
      readonly status: "insufficient_stock";
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "not_found";
    };

export interface ReleaseReservedStockRepositoryInput {
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
}

export interface ConsumeReservedStockRepositoryInput {
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
}

export interface ReleaseExpiredReservationsRepositoryInput {
  readonly now: ISODateTime;
}

export interface ReleaseExpiredReservationsRepositoryResult {
  readonly scannedCount: number;
  readonly releasedCount: number;
  readonly stockItemsAffected: number;
}

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
      readonly status: "would_go_negative";
      readonly stock: StockItemRecord;
    }
  | {
      readonly status: "not_found";
    };

type ReservationEventMutationRepositoryResult<TStatus extends "released" | "consumed"> =
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

export type ReleaseReservedStockRepositoryResult =
  ReservationEventMutationRepositoryResult<"released">;
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

export class CatalogRepository {
  private readonly collection: StorageCollection<CatalogDocument>;

  constructor(collection: StorageCollection<CatalogDocument>) {
    this.collection = collection;
  }

  async findItemByContent(content: ContentRef): Promise<CatalogItemDocument | null> {
    return findOneByType(this.collection, "catalogItem", {
      contentCollection: content.collection,
      contentId: content.id,
    });
  }

  async findItemBySellableId(sellableId: MikaId): Promise<CatalogItemDocument | null> {
    const result = await listByType(this.collection, "catalogItem");

    return (
      result.items.find((item) =>
        item.data.aggregate.sellables.some((sellable) => sellable.id === sellableId),
      )?.data ?? null
    );
  }

  async put(document: CatalogDocument): Promise<void> {
    await putByDocumentId(this.collection, document);
  }
}

export class SessionRepository {
  private readonly collection: StorageCollection<SessionDocument>;

  constructor(collection: StorageCollection<SessionDocument>) {
    this.collection = collection;
  }

  async findById(id: MikaId): Promise<SessionDocument | null> {
    return this.collection.get(id);
  }

  async findOpenCartBySession(sessionId: string, currency: string): Promise<CartDocument | null> {
    return findOneByType(this.collection, "cart", {
      sessionId,
      status: "open",
      currency,
    });
  }

  async findOpenCartByCustomer(customerId: MikaId, currency: string): Promise<CartDocument | null> {
    return findOneByType(this.collection, "cart", {
      customerId,
      status: "open",
      currency,
    });
  }

  async findWishlistBySession(sessionId: string): Promise<WishlistDocument | null> {
    return findOneByType(this.collection, "wishlist", {
      sessionId,
      status: "active",
    });
  }

  async findWishlistByCustomer(customerId: MikaId): Promise<WishlistDocument | null> {
    return findOneByType(this.collection, "wishlist", {
      customerId,
      status: "active",
    });
  }

  async findCheckoutByProvider(
    provider: string,
    providerCheckoutId: string,
  ): Promise<CheckoutDocument | null> {
    return findOneByType(this.collection, "checkout", {
      provider,
      providerCheckoutId,
    });
  }

  async put(document: SessionDocument): Promise<void> {
    await putByDocumentId(this.collection, document);
  }
}

export class AccountRepository {
  private readonly collection: StorageCollection<AccountDocument>;

  constructor(collection: StorageCollection<AccountDocument>) {
    this.collection = collection;
  }

  async findCustomerById(customerId: MikaId): Promise<CustomerDocument | null> {
    return findOneByType(this.collection, "customer", { customerId });
  }

  async findCustomerByUserId(userId: string): Promise<CustomerDocument | null> {
    return findOneByType(this.collection, "customer", { userId });
  }

  async findCustomerByEmailHash(emailHash: string): Promise<CustomerDocument | null> {
    return findOneByType(this.collection, "customer", { emailHash });
  }

  async findProviderAccount(
    provider: string,
    providerCustomerId: string,
  ): Promise<ProviderAccountDocument | null> {
    return findOneByType(this.collection, "providerAccount", {
      provider,
      providerCustomerId,
    });
  }

  async listProviderAccountsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<ProviderAccountDocument>> {
    return listByType(this.collection, "providerAccount", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listSubscriptionsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<SubscriptionDocument>> {
    return listByType(this.collection, "subscription", {
      where: { customerId },
      orderBy: { currentPeriodEnd: "desc" },
      limit,
    });
  }

  async listEntitlementsByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return listByType(this.collection, "entitlement", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listLicensesByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<LicenseDocument>> {
    return listByType(this.collection, "license", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async put(document: AccountDocument): Promise<void> {
    await putByDocumentId(this.collection, document);
  }
}

export class LedgerRepository {
  private readonly collection: StorageCollection<LedgerDocument>;

  constructor(collection: StorageCollection<LedgerDocument>) {
    this.collection = collection;
  }

  async findOrderById(orderId: MikaId): Promise<OrderDocument | null> {
    const document = await this.collection.get(orderId);
    return documentOfType(document, "order");
  }

  async findOrderByNumber(orderNumber: string): Promise<OrderDocument | null> {
    return findOneByType(this.collection, "order", { orderNumber });
  }

  async findOrderByProviderPayment(
    provider: string,
    providerPaymentId: string,
  ): Promise<OrderDocument | null> {
    return findOneByType(this.collection, "order", {
      provider,
      providerPaymentId,
    });
  }

  async findOrderByCheckoutSession(checkoutSessionId: MikaId): Promise<OrderDocument | null> {
    return findOneByType(this.collection, "order", { checkoutSessionId });
  }

  async listOrdersByCustomer(customerId: MikaId, limit = 50): Promise<DocumentList<OrderDocument>> {
    return listByType(this.collection, "order", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async put(document: LedgerDocument): Promise<void> {
    await putByDocumentId(this.collection, document);
  }
}

export class OpsRepository {
  private readonly collection: StorageCollection<OpsDocument>;

  constructor(collection: StorageCollection<OpsDocument>) {
    this.collection = collection;
  }

  async findWebhookDuplicate(input: {
    readonly provider: string;
    readonly providerEventId?: string;
    readonly eventType: string;
    readonly payloadHash: string;
  }): Promise<WebhookDocument | null> {
    const where: TypeScopedWhere<OpsDocument> =
      input.providerEventId !== undefined
        ? {
            provider: input.provider,
            providerEventId: input.providerEventId,
          }
        : {
            provider: input.provider,
            eventType: input.eventType,
            payloadHash: input.payloadHash,
          };

    return findOneByType(this.collection, "webhook", where);
  }

  async findAccountExport(exportId: MikaId): Promise<AccountExportDocument | null> {
    const document = await this.collection.get(exportId);
    return documentOfType(document, "accountExport");
  }

  async findAccountDeleteRequest(requestId: MikaId): Promise<AccountDeleteRequestDocument | null> {
    const document = await this.collection.get(requestId);
    return documentOfType(document, "accountDeleteRequest");
  }

  async listAccountExportsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountExportDocument>> {
    return listByType(this.collection, "accountExport", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listAccountDeleteRequestsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return listByType(this.collection, "accountDeleteRequest", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async findProviderSyncRun(runId: MikaId): Promise<ProviderSyncRunDocument | null> {
    const document = await this.collection.get(runId);
    return documentOfType(document, "providerSyncRun");
  }

  async findEmail(emailId: MikaId): Promise<EmailDocument | null> {
    const document = await this.collection.get(emailId);
    return documentOfType(document, "email");
  }

  async listWebhookFailures(now: string, limit = 50): Promise<DocumentList<WebhookDocument>> {
    return listByType(this.collection, "webhook", {
      where: { status: "failed", nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: "asc" },
      limit,
    });
  }

  async writeAudit(document: AdminAuditDocument): Promise<void> {
    await this.put(document);
  }

  async listDue(
    type: WebhookDocument["type"],
    now: string,
    limit?: number,
  ): Promise<DocumentList<WebhookDocument>>;
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
    return listByType(this.collection as StorageCollection<DueOpsDocument>, type, {
      where: { status: "queued", nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: "asc" },
      limit,
    });
  }

  async put(document: OpsDocument): Promise<void> {
    await putByDocumentId(this.collection, document);
  }
}

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

  async insertEvent(record: StockEventRecord): Promise<void> {
    await insertStockEvent(this.db, record);
  }

  async reserve(input: ReserveStockRepositoryInput): Promise<ReserveStockRepositoryResult> {
    assertReservationQuantity(input.quantity);

    return withTransaction(this.db, async (executor) => {
      const replayed =
        input.idempotencyKey === undefined
          ? null
          : await findStockEventByIdempotencyKey(executor, input.idempotencyKey);
      if (replayed) {
        return {
          status: "replayed",
          event: replayed,
          stock: await findStockItemById(executor, replayed.stockItemId),
        };
      }

      const current = await findStockItemById(executor, input.stockItemId);
      if (!current) {
        return { status: "not_found" };
      }

      const result = await reserveStockStatement({
        stockItemId: input.stockItemId,
        quantity: input.quantity,
        now: input.now,
      }).execute(executor);
      if (!mutationAffected(result)) {
        return { status: "insufficient_stock", stock: current };
      }

      const event: StockEventRecord = {
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
      };

      await insertStockEvent(executor, event);

      const stock = await findStockItemById(executor, input.stockItemId);
      if (!stock) {
        throw new Error(`Reserved stock item '${input.stockItemId}' could not be reloaded.`);
      }

      return { status: "reserved", event, stock };
    });
  }

  async release(
    input: ReleaseReservedStockRepositoryInput,
  ): Promise<ReleaseReservedStockRepositoryResult> {
    return mutateActiveReservationEvent({
      executor: this.db,
      reservationEventId: input.reservationEventId,
      now: input.now,
      targetStatus: "released",
      applyStockMutation: (executor, event) =>
        releaseStockStatement({
          stockItemId: event.stockItemId,
          quantity: event.quantityDelta,
          now: input.now,
        }).execute(executor),
    });
  }

  async consume(
    input: ConsumeReservedStockRepositoryInput,
  ): Promise<ConsumeReservedStockRepositoryResult> {
    return mutateActiveReservationEvent({
      executor: this.db,
      reservationEventId: input.reservationEventId,
      now: input.now,
      targetStatus: "consumed",
      eventPatch: {
        ...(input.orderId === undefined ? {} : { order_id: input.orderId }),
        ...(input.orderLineId === undefined ? {} : { order_line_id: input.orderLineId }),
      },
      applyStockMutation: (executor, event) =>
        consumeReservedStockStatement({
          stockItemId: event.stockItemId,
          quantity: event.quantityDelta,
          now: input.now,
        }).execute(executor),
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

  async adjustStock(input: AdjustStockRepositoryInput): Promise<AdjustStockRepositoryResult> {
    assertStockAdjustmentQuantity(input.quantityDelta);

    return withTransaction(this.db, async (executor) => {
      const replayed =
        input.idempotencyKey === undefined
          ? null
          : await findStockEventByIdempotencyKey(executor, input.idempotencyKey);
      if (replayed) {
        return {
          status: "replayed",
          event: replayed,
          stock: await findStockItemById(executor, replayed.stockItemId),
        };
      }

      const current = await findStockItemById(executor, input.stockItemId);
      if (!current) {
        return { status: "not_found" };
      }

      const stockMutation = await adjustStockStatement({
        stockItemId: input.stockItemId,
        quantityDelta: input.quantityDelta,
        now: input.now,
      }).execute(executor);
      if (!mutationAffected(stockMutation)) {
        return { status: "would_go_negative", stock: current };
      }

      const event: StockEventRecord = {
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
      };

      await insertStockEvent(executor, event);

      const stock = await findStockItemById(executor, input.stockItemId);
      if (!stock) {
        throw new Error(`Adjusted stock item '${input.stockItemId}' could not be reloaded.`);
      }

      return { status: "adjusted", event, stock };
    });
  }
}

async function mutateActiveReservationEvent<TStatus extends "released" | "consumed">(input: {
  readonly executor: MikaDbExecutor;
  readonly reservationEventId: MikaId;
  readonly now: ISODateTime;
  readonly targetStatus: TStatus;
  readonly eventPatch?: MikaUpdateable<"mika_stock_events">;
  readonly applyStockMutation: (
    executor: MikaDbExecutor,
    event: StockEventRecord,
  ) => Promise<{
    readonly numAffectedRows?: bigint | number;
    readonly numUpdatedRows?: bigint | number;
    readonly numChangedRows?: bigint | number;
  }>;
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
    readonly expiresAt: string;
    readonly now: string;
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

  async consumeToken(key: string, now: string): Promise<boolean> {
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

  async purgeExpired(now: string): Promise<number> {
    const result = await this.db
      .deleteFrom("mika_ephemeral_records")
      .where("expires_at", "<=", now)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }
}

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

function mutationAffected(result: {
  readonly numAffectedRows?: bigint | number;
  readonly numUpdatedRows?: bigint | number;
  readonly numChangedRows?: bigint | number;
}): boolean {
  return affected(result.numAffectedRows ?? result.numUpdatedRows ?? result.numChangedRows);
}

function affected(count: bigint | number | undefined): boolean {
  if (typeof count === "bigint") return count > 0n;
  return (count ?? 0) > 0;
}
