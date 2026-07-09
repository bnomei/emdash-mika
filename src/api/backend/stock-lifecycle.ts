/**
 * Stock reservation and adjustment service used by cart, checkout, and maintenance flows to
 * reserve, release, expire, consume, and adjust stock quantities with idempotent event tracking.
 */
import type {
  AdjustStockRepositoryResult,
  ConsumeReservedStockRepositoryResult,
  ExpireReservedStockRepositoryResult,
  ReleaseExpiredReservationsRepositoryResult,
  ReleaseReservedStockRepositoryResult,
  ReserveStockRepositoryResult,
} from "../../storage/repositories";
import type {
  CartId,
  CheckoutSessionId,
  ISODateTime,
  JsonObject,
  MikaId,
  OrderId,
} from "../../types/primitives";
import type { StockAdjustInput } from "../types";
import { currentBackendISODateTime } from "./shared";
import type { MikaBackendDependencies, MikaBackendRepositories } from "./ports";

export type MikaStockLifecycleDependencies = Pick<
  MikaBackendDependencies,
  "createId" | "isoNow" | "now"
> & {
  readonly repositories: Pick<MikaBackendRepositories, "stock">;
};

/** Input for creating a time-bounded stock reservation tied to cart or checkout. */
export interface ReserveStockInput {
  readonly stockItemId: MikaId;
  readonly quantity: number;
  readonly expiresAt: ISODateTime;
  readonly now?: ISODateTime;
  readonly cartId?: CartId;
  readonly checkoutSessionId?: CheckoutSessionId;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: JsonObject;
}

/** Outcome of creating or replaying a stock reservation event. */
export type ReserveStockResult = ReserveStockRepositoryResult;

/** Input for releasing a prior stock reservation by event id. */
export interface ReleaseReservedStockInput {
  readonly reservationEventId: MikaId;
  readonly now?: ISODateTime;
}

/** Outcome of releasing an active reservation back to available stock. */
export type ReleaseReservedStockResult = ReleaseReservedStockRepositoryResult;

/** Outcome of expiring a reservation while keeping it consumable for late fulfillment. */
export type ExpireReservedStockResult = ExpireReservedStockRepositoryResult;

/** Input for consuming a reservation at order fulfillment. */
export interface ConsumeReservedStockInput {
  readonly reservationEventId: MikaId;
  readonly now?: ISODateTime;
  readonly orderId?: OrderId;
  readonly orderLineId?: MikaId;
}

/** Outcome of fulfilling a reservation into a sale consumption event. */
export type ConsumeReservedStockResult = ConsumeReservedStockRepositoryResult;

/** Input for maintenance sweep of expired stock reservations. */
export interface ReleaseExpiredReservationsInput {
  readonly now?: ISODateTime;
}

/** Counts from sweeping expired reservations during maintenance. */
export type ReleaseExpiredReservationsResult = ReleaseExpiredReservationsRepositoryResult;

/** Input for extending active reservation expiry to match a longer checkout window. */
export interface ExtendReservationsInput {
  readonly reservationEventIds: readonly MikaId[];
  readonly expiresAt: ISODateTime;
  readonly now?: ISODateTime;
}

/** Admin stock adjustment with optional clock override. */
export interface AdjustStockInput extends StockAdjustInput {
  readonly now?: ISODateTime;
}

/** Outcome of an admin stock quantity adjustment or idempotent replay. */
export type AdjustStockResult = AdjustStockRepositoryResult;

/** Stock reservation and adjustment API used by cart, checkout, and maintenance. */
export interface MikaStockLifecycleService {
  reserve(input: ReserveStockInput): Promise<ReserveStockResult>;
  /** Returns reserved quantity to available stock when checkout is cancelled before payment. */
  release(input: ReleaseReservedStockInput): Promise<ReleaseReservedStockResult>;
  /**
   * Marks a reservation expired while keeping it consumable for late payment fulfillment
   * after checkout cancel or reservation TTL expiry.
   */
  expire(input: ReleaseReservedStockInput): Promise<ExpireReservedStockResult>;
  /** Finalizes a reservation into a sale consumption event at order fulfillment. */
  consume(input: ConsumeReservedStockInput): Promise<ConsumeReservedStockResult>;
  releaseExpiredReservations(
    input?: ReleaseExpiredReservationsInput,
  ): Promise<ReleaseExpiredReservationsResult>;
  extendReservations(input: ExtendReservationsInput): Promise<void>;
  adjust(input: AdjustStockInput): Promise<AdjustStockResult>;
}

/** Builds a stock lifecycle service bound to backend repositories and clocks. */
export function createMikaStockLifecycleService(
  input: MikaStockLifecycleDependencies,
): MikaStockLifecycleService {
  return {
    reserve: async (reservation) =>
      input.repositories.stock.reserve({
        ...reservation,
        reservationEventId: input.createId("stock_event"),
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    release: async (reservation) =>
      input.repositories.stock.release({
        ...reservation,
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    expire: async (reservation) =>
      input.repositories.stock.expire({
        ...reservation,
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    consume: async (reservation) =>
      input.repositories.stock.consume({
        ...reservation,
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    releaseExpiredReservations: async (reservation = {}) =>
      input.repositories.stock.releaseExpiredReservations({
        now: reservation.now ?? currentBackendISODateTime(input),
      }),
    extendReservations: async (extension) =>
      input.repositories.stock.extendReservations({
        ...extension,
        now: extension.now ?? currentBackendISODateTime(input),
      }),
    adjust: async (adjustment) =>
      input.repositories.stock.adjustStock({
        ...adjustment,
        movementEventId: input.createId("stock_event"),
        now: adjustment.now ?? currentBackendISODateTime(input),
      }),
  };
}

export async function expireCheckoutReservations(
  input: MikaStockLifecycleDependencies,
  reservationIds: readonly MikaId[],
  now: ISODateTime,
): Promise<void> {
  const stock = createMikaStockLifecycleService(input);

  for (const reservationEventId of reservationIds) {
    await stock.expire({ reservationEventId, now });
  }
}
