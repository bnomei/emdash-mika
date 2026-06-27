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

export interface MikaStorageDocument {
  readonly id: MikaId;
  readonly type: string;
  readonly schemaVersion: 1;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export type MikaBaseDocument<TType extends string> = MikaStorageDocument & {
  readonly type: TType;
};

export type AggregateDocument<
  TType extends string,
  TIndexed extends object,
  TAggregate,
> = MikaBaseDocument<TType> &
  TIndexed & {
    readonly aggregate: TAggregate;
  };

export type RecordBackedDocument<
  TType extends string,
  TRecord,
  TIndexedKeys extends keyof TRecord,
> = MikaBaseDocument<TType> &
  Pick<TRecord, TIndexedKeys> & {
    readonly record: TRecord;
  };

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

export type CustomerDocument = AggregateDocument<
  "customer",
  {
    readonly customerId: MikaId;
    readonly userId?: string;
    readonly emailHash?: string;
  },
  CustomerAggregate
>;

export type ProviderAccountDocument = RecordBackedDocument<
  "providerAccount",
  CustomerProviderAccountRecord,
  "customerId" | "provider" | "providerCustomerId"
>;

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

export type EntitlementDocument = RecordBackedDocument<
  "entitlement",
  EntitlementRecord,
  "customerId" | "userId" | "emailHash" | "entitlementKey" | "status" | "subscriptionId" | "orderId"
>;

export type LicenseDocument = RecordBackedDocument<
  "license",
  LicenseKeyRecord,
  "orderId" | "orderLineId" | "entitlementId" | "status"
> & {
  readonly customerId?: MikaId;
};

export type OrderDocument = AggregateDocument<
  "order",
  {
    readonly orderNumber: string;
    readonly customerId?: MikaId;
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

export type EmailDocument = RecordBackedDocument<
  "email",
  EmailMessageRecord,
  "status" | "nextAttemptAt" | "orderId" | "tokenId" | "kind"
>;

export type AccountExportDocument = RecordBackedDocument<
  "accountExport",
  AccountExportRecord,
  "customerId" | "userId" | "status" | "expiresAt"
>;

export type AccountDeleteRequestDocument = RecordBackedDocument<
  "accountDeleteRequest",
  AccountDeleteRequestRecord,
  "customerId" | "userId" | "emailHash" | "status" | "expiresAt"
>;

export type ProviderSyncRunDocument = RecordBackedDocument<
  "providerSyncRun",
  ProviderSyncRunRecord,
  "provider" | "status" | "startedAt"
>;

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

export type AdminAuditDocument = RecordBackedDocument<
  "adminAudit",
  AdminAuditEventRecord,
  "actorId" | "targetType" | "targetId" | "status" | "idempotencyKey"
>;

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

export type CatalogDocument = MikaStorageDocuments["catalog"];
export type SessionDocument = MikaStorageDocuments["session"];
export type AccountDocument = MikaStorageDocuments["account"];
export type LedgerDocument = MikaStorageDocuments["ledger"];
export type OpsDocument = MikaStorageDocuments["ops"];
export type MikaStorageCollectionName = keyof MikaStorageDocuments;
