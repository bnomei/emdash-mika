import type {
  EmailStatus,
  EntitlementStatus,
  ISODateTime,
  JsonObject,
  MikaId,
  ProviderName,
  StockMovementReason,
  StockPolicy,
  StockReservationStatus,
  TokenPurpose,
  TokenStatus,
  WebhookStatus,
} from "./primitives";

export interface StockItemRecord {
  readonly id: MikaId;
  readonly sellableId: MikaId;
  readonly policy: StockPolicy;
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly lowStockThreshold?: number;
  readonly allowBackorder: boolean;
  readonly availableOverride?: boolean;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface StockReservationRecord {
  readonly id: MikaId;
  readonly stockItemId: MikaId;
  readonly cartId?: MikaId;
  readonly checkoutSessionId?: MikaId;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly quantity: number;
  readonly status: StockReservationStatus;
  readonly expiresAt: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly releasedAt?: ISODateTime;
  readonly consumedAt?: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface StockMovementRecord {
  readonly id: MikaId;
  readonly stockItemId: MikaId;
  readonly reservationId?: MikaId;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly adminAuditId?: MikaId;
  readonly idempotencyKey?: string;
  readonly quantityDelta: number;
  readonly reason: StockMovementReason;
  readonly createdAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export type StockEventKind = "reservation" | "movement";
export type StockEventStatus = "active" | "released" | "consumed" | "expired" | "recorded";

export interface StockEventRecord {
  readonly id: MikaId;
  readonly stockItemId: MikaId;
  readonly kind: StockEventKind;
  readonly status: StockEventStatus;
  readonly reason?: StockMovementReason;
  readonly reservationEventId?: MikaId;
  readonly cartId?: MikaId;
  readonly checkoutSessionId?: MikaId;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly adminAuditId?: MikaId;
  readonly idempotencyKey?: string;
  readonly quantityDelta: number;
  readonly expiresAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface EphemeralRecord {
  readonly key: string;
  readonly kind: "token" | "rate_limit" | "lock" | "nonce" | "cache_marker";
  readonly subjectHash?: string;
  readonly status: string;
  readonly count: number;
  readonly expiresAt: ISODateTime;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly data?: JsonObject;
}

export interface CustomerProviderAccountRecord {
  readonly id: MikaId;
  readonly customerId: MikaId;
  readonly provider: ProviderName;
  readonly providerCustomerId: string;
  readonly emailSnapshot?: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface EntitlementRecord {
  readonly id: MikaId;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
  readonly entitlementKey: string;
  readonly contentCollection?: string;
  readonly contentId?: string;
  readonly sellableId?: MikaId;
  readonly orderId?: MikaId;
  readonly subscriptionId?: MikaId;
  readonly status: EntitlementStatus;
  readonly sourceStatus?: string;
  readonly currentPeriodEnd?: ISODateTime;
  readonly grantedAt: ISODateTime;
  readonly revokedAt?: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface TokenRecord {
  readonly id: MikaId;
  readonly purpose: TokenPurpose;
  readonly tokenHash: string;
  readonly status: TokenStatus;
  readonly subjectHash?: string;
  readonly customerId?: MikaId;
  readonly sessionId?: string;
  readonly targetType?: string;
  readonly targetId?: MikaId;
  readonly returnPath?: string;
  readonly expiresAt: ISODateTime;
  readonly consumedAt?: ISODateTime;
  readonly revokedAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface AccountExportRecord {
  readonly id: MikaId;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly status: "queued" | "running" | "ready" | "expired" | "failed";
  readonly requestedAt: ISODateTime;
  readonly finishedAt?: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly downloadTokenHash?: string;
  readonly artifactRef?: string;
  readonly lastError?: string;
  readonly metadata?: JsonObject;
}

export interface AccountDeleteRequestRecord {
  readonly id: MikaId;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
  readonly status: "queued" | "confirmed" | "completed" | "cancelled" | "failed";
  readonly requestedAt: ISODateTime;
  readonly confirmedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly confirmTokenHash?: string;
  readonly lastError?: string;
  readonly metadata?: JsonObject;
}

export interface EmailMessageRecord {
  readonly id: MikaId;
  readonly customerId?: MikaId;
  readonly orderId?: MikaId;
  readonly tokenId?: MikaId;
  readonly kind: "magic_link" | "order_confirmation" | "download" | "admin_notification";
  readonly toEmail: string;
  readonly subject: string;
  readonly status: EmailStatus;
  readonly providerMessageId?: string;
  readonly idempotencyKey?: string;
  readonly templateKey?: string;
  readonly templateVersion?: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: ISODateTime;
  readonly lastError?: string;
  readonly createdAt: ISODateTime;
  readonly sentAt?: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface RateLimitBucketRecord {
  readonly id: MikaId;
  readonly scope: string;
  readonly subjectHash: string;
  readonly windowStart: ISODateTime;
  readonly windowSeconds: number;
  readonly count: number;
  readonly blockedUntil?: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface WebhookEventRecord {
  readonly id: MikaId;
  readonly provider: ProviderName;
  readonly providerEventId?: string;
  readonly eventType: string;
  readonly payloadHash: string;
  readonly status: WebhookStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt?: ISODateTime;
  readonly receivedAt: ISODateTime;
  readonly processedAt?: ISODateTime;
  readonly lastError?: string;
  readonly rawPayloadJson?: JsonObject;
  readonly rawPayloadPurgedAt?: ISODateTime;
  readonly relatedCustomerId?: MikaId;
  readonly relatedOrderId?: MikaId;
  readonly relatedSubscriptionId?: MikaId;
}

export interface LicenseKeyRecord {
  readonly id: MikaId;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly entitlementId?: MikaId;
  readonly licenseKeyHash: string;
  readonly displayKeySuffix: string;
  readonly status: "active" | "revoked";
  readonly createdAt: ISODateTime;
  readonly revokedAt?: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface ProviderSyncRunRecord {
  readonly id: MikaId;
  readonly provider: ProviderName;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly mode: "dry_run" | "apply";
  readonly leaseKey?: string;
  readonly startedAt: ISODateTime;
  readonly finishedAt?: ISODateTime;
  readonly summary?: JsonObject;
  readonly lastError?: string;
}

export type WorkflowStatus = "queued" | "running" | "completed" | "failed";
export type WorkflowStepStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface WorkflowStepRecord {
  readonly name: string;
  readonly status: WorkflowStepStatus;
  readonly startedAt?: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly failedAt?: ISODateTime;
  readonly attemptCount: number;
  readonly nextAttemptAt?: ISODateTime;
  readonly lastError?: string;
  readonly state?: JsonObject;
}

export interface WorkflowRecord {
  readonly id: MikaId;
  readonly kind: "payment_webhook_fulfillment" | (string & {});
  readonly status: WorkflowStatus;
  readonly subjectType?: string;
  readonly subjectId?: MikaId;
  readonly idempotencyKey?: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: ISODateTime;
  readonly leaseKey?: string;
  readonly leasedAt?: ISODateTime;
  readonly leaseExpiresAt?: ISODateTime;
  readonly steps: readonly WorkflowStepRecord[];
  readonly resumeState?: JsonObject;
  readonly lastError?: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly metadata?: JsonObject;
}

export interface AdminAuditEventRecord {
  readonly id: MikaId;
  readonly actorId?: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: MikaId;
  readonly status: "started" | "completed" | "failed";
  readonly correlationId?: string;
  readonly createdAt: ISODateTime;
  readonly metadata?: JsonObject;
}
