/**
 * Pure input/result contract types shared by the backend repository ports
 * (src/api/backend/ports.ts) and the storage adapters that implement them. A leaf module: the
 * port owns this vocabulary, the adapters implement it, and neither has to import the other's
 * implementation to talk about it.
 */
import type { AdminAuditDocument, CatalogItemDocument } from "../../types/documents";
import type { PriceDefinition, SellableDefinition } from "../../types/aggregates";
import type { StockEventRecord, StockItemRecord } from "../../types/operational";
import type { ISODateTime, JsonObject, MikaId } from "../../types/primitives";

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

/** Generic transition result underlying the release/expire/consume aliases below. */
export type ReservationEventMutationRepositoryResult<
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
