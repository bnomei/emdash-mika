/**
 * Persisted document envelopes for the commerce storage model.
 * Documents pair indexed top-level fields with either an aggregate payload or an operational record.
 */
import type {
  CartAggregate,
  CatalogCommerceAggregate,
  CheckoutAggregate,
  CouponAggregate,
  CustomerAggregate,
  OrderAggregate,
  SubscriptionAggregate,
  WishlistAggregate,
} from "./aggregates";
import type {
  AccountDeleteRequestRecord,
  AccountExportRecord,
  AdminAuditEventRecord,
  CustomerProviderAccountRecord,
  EmailMessageRecord,
  EntitlementRecord,
  LicenseKeyRecord,
  ProviderSyncRunRecord,
  WorkflowRecord,
  WebhookEventRecord,
} from "./operational";
import type {
  CartStatus,
  CheckoutStatus,
  CurrencyCode,
  ISODateTime,
  MikaId,
  OrderStatus,
  PaymentStatus,
  ProviderName,
  SubscriptionStatus,
  WishlistStatus,
} from "./primitives";

/** Base persisted document with branded id, type discriminator, and timestamps. */
export interface MikaStorageDocument {
  readonly id: MikaId;
  readonly type: string;
  readonly schemaVersion: 1;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Document narrowed to a fixed type discriminator before aggregate or record payload attachment. */
export type MikaBaseDocument<TType extends string> = MikaStorageDocument & {
  readonly type: TType;
};

/** Document embedding a versioned aggregate plus indexed query fields. */
export type AggregateDocument<
  TType extends string,
  TIndexed extends object,
  TAggregate,
> = MikaBaseDocument<TType> &
  TIndexed & {
    readonly aggregate: TAggregate;
  };

/** Document wrapping an operational record with selected indexed record fields. */
export type RecordBackedDocument<
  TType extends string,
  TRecord,
  TIndexedKeys extends keyof TRecord,
> = MikaBaseDocument<TType> &
  Pick<TRecord, TIndexedKeys> & {
    readonly record: TRecord;
  };

/** Catalog collection document for a commerce catalog item aggregate. */
export type CatalogItemDocument = AggregateDocument<
  "catalogItem",
  {
    readonly contentCollection: string;
    readonly contentId: string;
    readonly active: boolean;
    readonly titleSnapshot?: string;
  },
  CatalogCommerceAggregate
>;

/** Catalog collection document for a coupon aggregate. */
export type CouponDocument = AggregateDocument<
  "coupon",
  {
    readonly codeHash: string;
    readonly active: boolean;
    readonly startsAt?: ISODateTime;
    readonly endsAt?: ISODateTime;
  },
  CouponAggregate
>;

/** Session collection document for a cart aggregate. */
export type CartDocument = AggregateDocument<
  "cart",
  {
    readonly sessionId?: string;
    readonly customerId?: MikaId;
    readonly userId?: string;
    readonly status: CartStatus;
    readonly currency: CurrencyCode;
    readonly expiresAt?: ISODateTime;
  },
  CartAggregate
>;

/** Session collection document for a wishlist aggregate. */
export type WishlistDocument = AggregateDocument<
  "wishlist",
  {
    readonly sessionId?: string;
    readonly customerId?: MikaId;
    readonly userId?: string;
    readonly status: WishlistStatus;
    readonly expiresAt?: ISODateTime;
  },
  WishlistAggregate
>;

/** Session collection document for a checkout aggregate. */
export type CheckoutDocument = AggregateDocument<
  "checkout",
  {
    readonly cartId?: MikaId;
    readonly sessionId?: string;
    readonly customerId?: MikaId;
    readonly provider: ProviderName;
    readonly providerCheckoutId?: string;
    readonly checkoutIdempotencyKey?: string;
    readonly checkoutIdempotencyInputHash?: string;
    readonly providerStatus?: CheckoutStatus | "pending" | "binding_mismatch";
    readonly redirectUrl?: string;
    readonly orderId?: MikaId;
    readonly failureReason?: string;
    readonly status: CheckoutStatus;
    readonly expiresAt?: ISODateTime;
  },
  CheckoutAggregate
>;

/** Account collection document for a customer aggregate. */
export type CustomerDocument = AggregateDocument<
  "customer",
  {
    readonly customerId: MikaId;
    readonly userId?: string;
    readonly emailHash?: string;
  },
  CustomerAggregate
>;

/** Account collection document for a provider-linked customer record. */
export type ProviderAccountDocument = RecordBackedDocument<
  "providerAccount",
  CustomerProviderAccountRecord,
  "customerId" | "provider" | "providerCustomerId"
>;

/** Account collection document for a subscription aggregate. */
export type SubscriptionDocument = AggregateDocument<
  "subscription",
  {
    readonly customerId?: MikaId;
    readonly provider: ProviderName;
    readonly providerCustomerId?: string;
    readonly providerSubscriptionId?: string;
    readonly status: SubscriptionStatus;
    readonly currentPeriodEnd?: ISODateTime;
  },
  SubscriptionAggregate
>;

/** Account collection document for an entitlement record. */
export type EntitlementDocument = RecordBackedDocument<
  "entitlement",
  EntitlementRecord,
  "customerId" | "userId" | "emailHash" | "entitlementKey" | "status" | "subscriptionId" | "orderId"
>;

/** Account collection document for a license key record. */
export type LicenseDocument = RecordBackedDocument<
  "license",
  LicenseKeyRecord,
  "orderId" | "orderLineId" | "entitlementId" | "status"
> & {
  readonly customerId?: MikaId;
};

/** Ledger collection document for an order aggregate. */
export type OrderDocument = AggregateDocument<
  "order",
  {
    readonly orderNumber: string;
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly provider: ProviderName;
    readonly providerCheckoutId?: string;
    readonly providerPaymentId?: string;
    readonly providerOrderId?: string;
    readonly checkoutSessionId?: MikaId;
    readonly status: OrderStatus;
    readonly paymentStatus: PaymentStatus;
    readonly currency: CurrencyCode;
    readonly totalAmount: number;
    readonly paidAt?: ISODateTime;
  },
  OrderAggregate
>;

/** Ops collection document for a webhook event record. */
export type WebhookDocument = RecordBackedDocument<
  "webhook",
  WebhookEventRecord,
  | "provider"
  | "providerEventId"
  | "eventType"
  | "payloadHash"
  | "status"
  | "nextAttemptAt"
  | "receivedAt"
>;

/** Ops collection document for an email message record with lease fields. */
export type EmailDocument = RecordBackedDocument<
  "email",
  EmailMessageRecord,
  "status" | "nextAttemptAt" | "orderId" | "tokenId" | "kind"
>;

/** Ops collection document for a GDPR account export request record. */
export type AccountExportDocument = RecordBackedDocument<
  "accountExport",
  AccountExportRecord,
  "customerId" | "userId" | "status" | "expiresAt"
>;

/** Ops collection document for an account deletion request record. */
export type AccountDeleteRequestDocument = RecordBackedDocument<
  "accountDeleteRequest",
  AccountDeleteRequestRecord,
  "customerId" | "userId" | "emailHash" | "status" | "expiresAt"
>;

/** Ops collection document for a provider catalog sync run record. */
export type ProviderSyncRunDocument = RecordBackedDocument<
  "providerSyncRun",
  ProviderSyncRunRecord,
  "provider" | "status" | "startedAt"
>;

/** Ops collection document for a lease-backed workflow record. */
export type WorkflowDocument = RecordBackedDocument<
  "workflow",
  WorkflowRecord,
  | "kind"
  | "status"
  | "subjectType"
  | "subjectId"
  | "idempotencyKey"
  | "nextAttemptAt"
  | "leaseExpiresAt"
>;

/** Ops collection document for an admin audit event record. */
export type AdminAuditDocument = RecordBackedDocument<
  "adminAudit",
  AdminAuditEventRecord,
  "actorId" | "action" | "targetType" | "targetId" | "status" | "idempotencyKey"
>;

/** Partition of document unions by storage collection name. */
export interface MikaStorageDocuments {
  readonly catalog: CatalogItemDocument | CouponDocument;
  readonly session: CartDocument | WishlistDocument | CheckoutDocument;
  readonly account:
    | CustomerDocument
    | ProviderAccountDocument
    | SubscriptionDocument
    | EntitlementDocument
    | LicenseDocument;
  readonly ledger: OrderDocument;
  readonly ops:
    | WebhookDocument
    | EmailDocument
    | AccountExportDocument
    | AccountDeleteRequestDocument
    | ProviderSyncRunDocument
    | WorkflowDocument
    | AdminAuditDocument;
}

/** Union of catalog collection documents. */
export type CatalogDocument = MikaStorageDocuments["catalog"];
/** Union of session collection documents. */
export type SessionDocument = MikaStorageDocuments["session"];
/** Union of account collection documents. */
export type AccountDocument = MikaStorageDocuments["account"];
/** Union of ledger collection documents. */
export type LedgerDocument = MikaStorageDocuments["ledger"];
/** Union of ops collection documents. */
export type OpsDocument = MikaStorageDocuments["ops"];
/** Storage collection key for document partitioning. */
export type MikaStorageCollectionName = keyof MikaStorageDocuments;
