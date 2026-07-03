import {
  adjustStockStatement,
  consumeOnHandStatement,
  consumeReservedStockStatement,
  releaseStockStatement,
  reserveStockStatement,
} from "../statements";
import { encodeJson } from "../json";
import type { MikaInsertable, MikaSelectable, MikaUpdateable } from "../schema";
import type { StockEventRecord, StockItemRecord } from "../../types/operational";
import { createISODateTime, createMikaId } from "../../types/primitives";
import type { ISODateTime, MikaId } from "../../types/primitives";
import { affected, parseMetadata, undef, type MikaDbExecutor } from "./db-shared";
import type {
  AdjustStockRepositoryInput,
  AdjustStockRepositoryResult,
  ConsumeReservedStockRepositoryInput,
  ConsumeReservedStockRepositoryResult,
  ExpireReservedStockRepositoryResult,
  ExtendReservationsRepositoryInput,
  ReleaseActiveReservationsByCustomerRepositoryInput,
  ReleaseExpiredReservationsRepositoryInput,
  ReleaseExpiredReservationsRepositoryResult,
  ReleaseReservedStockRepositoryInput,
  ReleaseReservedStockRepositoryResult,
  ReservationEventMutationRepositoryResult,
  ReserveStockRepositoryInput,
  ReserveStockRepositoryResult,
} from "./contracts";


type StockMutationResult = {
  readonly numAffectedRows?: bigint | number;
  readonly numUpdatedRows?: bigint | number;
  readonly numChangedRows?: bigint | number;
};

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
    const row = stockItemInsertRow(record);

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
    const row = stockItemInsertRow(record);

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
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", "<", input.expiresAt)]))
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

async function mutateActiveReservationEvent<
  TStatus extends "released" | "consumed" | "expired",
>(input: {
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

/** Serializes a stock item record to its insertable row. Shared by putItem and putItemDefinition,
 * which differ only in their doUpdateSet clause. */
function stockItemInsertRow(record: StockItemRecord): MikaInsertable<"mika_stock_items"> {
  return {
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
    reason: undef(row.reason),
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
  // kysely transactions cannot nest; reuse an already-open transaction scope directly.
  if (executor.isTransaction) {
    return operation(executor);
  }

  return executor.transaction().execute(operation);
}

function mutationAffected(result: StockMutationResult): boolean {
  return affected(result.numAffectedRows ?? result.numUpdatedRows ?? result.numChangedRows);
}
