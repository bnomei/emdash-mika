/**
 * Repository port interfaces and shared backend configuration/dependency types required by
 * {@link createMikaBackendApi}.
 */
import type {
  AccountDeleteEmailRedactionRepositoryInput,
  AccountDeleteMaintenanceStepRepositoryInput,
  AccountDeleteRequestCompletionRepositoryInput,
  AccountDeleteRequestFailureRepositoryInput,
  AdjustStockRepositoryInput,
  AdjustStockRepositoryResult,
  AdminAuditIdempotencyClaimResult,
  CatalogProviderPriceMatch,
  ConsumeReservedStockRepositoryInput,
  ConsumeReservedStockRepositoryResult,
  EmailCompleteRepositoryInput,
  EmailDeliveredRepositoryInput,
  EmailFailureRepositoryInput,
  EmailLeaseRepositoryInput,
  EmailSkipRepositoryInput,
  ExpireReservedStockRepositoryResult,
  ExtendReservationsRepositoryInput,
  ReleaseActiveReservationsByCustomerRepositoryInput,
  ReleaseExpiredReservationsRepositoryInput,
  ReleaseExpiredReservationsRepositoryResult,
  ReleaseReservedStockRepositoryInput,
  ReleaseReservedStockRepositoryResult,
  ReserveStockRepositoryInput,
  ReserveStockRepositoryResult,
  WorkflowFailureRepositoryInput,
  WorkflowLeaseRepositoryInput,
  WorkflowStepRepositoryInput,
} from "../../storage/repositories/contracts";
import type { PaginatedStorageResult } from "../../storage/collections";
import type { MikaProviderRegistry } from "../../provider";
import type {
  AccountDeleteRequestDocument,
  AccountExportDocument,
  AccountDocument,
  AdminAuditDocument,
  CatalogDocument,
  CatalogItemDocument,
  CartDocument,
  CheckoutDocument,
  CustomerDocument,
  EmailDocument,
  EntitlementDocument,
  LedgerDocument,
  LicenseDocument,
  OpsDocument,
  OrderDocument,
  ProviderAccountDocument,
  SessionDocument,
  SubscriptionDocument,
  WebhookDocument,
  WishlistDocument,
  WorkflowDocument,
} from "../../types/documents";
import type {
  CheckoutStatus,
  ContentRef,
  CurrencyCode,
  ISODateTime,
  JsonObject,
  MikaId,
  ProviderName,
} from "../../types/primitives";
import type { EphemeralRecord, StockEventRecord, StockItemRecord } from "../../types/operational";
import type { MikaNotificationHook } from "../notifications";
import type { MikaApiOverrides } from "../server";

/** Paginated id/data page returned by repository-port list methods. */
export type MikaDocumentList<TDocument> = PaginatedStorageResult<{
  readonly id: string;
  readonly data: TDocument;
}>;

/** Catalog persistence boundary for sellables, prices, and content refs. */
export interface MikaCatalogRepositoryPort {
  findItemByContent(content: ContentRef): Promise<CatalogItemDocument | null>;
  findItemBySellableId(sellableId: MikaId): Promise<CatalogItemDocument | null>;
  findItemByProviderPrice(
    provider: string,
    providerPriceId: string,
  ): Promise<CatalogProviderPriceMatch | null>;
  findPriceById(priceId: MikaId): Promise<CatalogProviderPriceMatch | null>;
  put(document: CatalogDocument): Promise<void>;
}

/** Session-scoped cart, checkout, and wishlist persistence. */
export interface MikaSessionRepositoryPort {
  findById(id: MikaId): Promise<SessionDocument | null>;
  findCheckoutById(id: MikaId): Promise<CheckoutDocument | null>;
  findOpenCartBySession(sessionId: string, currency: string): Promise<CartDocument | null>;
  findOpenCartByCustomer(customerId: MikaId, currency: string): Promise<CartDocument | null>;
  findCheckoutPendingCartBySession(
    sessionId: string,
    currency: string,
  ): Promise<CartDocument | null>;
  findCheckoutPendingCartByCustomer(
    customerId: MikaId,
    currency: string,
  ): Promise<CartDocument | null>;
  listCheckoutPendingCartsBySession(
    sessionId: string,
    limit?: number,
  ): Promise<MikaDocumentList<CartDocument>>;
  listCheckoutPendingCartsByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<CartDocument>>;
  /**
   * Optimistic checkout claim: succeeds only when `expectedVersion` matches the cart row's
   * `version`. Serializes concurrent checkout starts against the same open cart. Compares
   * `version` (a monotonic counter) rather than `updatedAt`, since two genuinely concurrent
   * writers can share the same millisecond-resolution wall-clock timestamp — a stale writer's CAS
   * check against `updatedAt` alone can then vacuously pass against a value that never changed.
   * `expectedVersion` is `undefined` when the caller read a cart persisted before `version`
   * existed; implementations must allow the claim in that case (nothing to compare against)
   * rather than always rejecting it.
   */
  claimCartForCheckout(input: {
    readonly cartId: MikaId;
    readonly checkoutId: MikaId;
    readonly expectedVersion: number | undefined;
    readonly claimExpiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null>;
  /** Clears a checkout claim when start fails or the session is abandoned. */
  releaseCartCheckoutClaim(input: {
    readonly cartId: MikaId;
    readonly checkoutId: MikaId;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null>;
  /**
   * Optimistic-concurrency cart write for ordinary line/coupon mutations (add, update, remove,
   * apply/remove coupon): persists `cart` only when the stored cart is still `open` and its
   * `version` still equals `expectedVersion`. Returns null when another writer already changed
   * the cart since it was read (concurrent tab, concurrent checkout claim, etc.) — same CAS
   * pattern as {@link claimCartForCheckout}, so a blind `put` can never silently discard a
   * concurrent write. Callers surface a conflict rather than merge or retry server-side, so the
   * client re-fetches the current cart before resubmitting. `expectedVersion` is `undefined` when
   * the caller read a cart persisted before `version` existed; implementations must allow the
   * write in that case (nothing to compare against) rather than always rejecting it.
   */
  putCartIfUnchanged(
    cart: CartDocument,
    expectedVersion: number | undefined,
  ): Promise<CartDocument | null>;
  findWishlistBySession(sessionId: string): Promise<WishlistDocument | null>;
  findWishlistByCustomer(customerId: MikaId): Promise<WishlistDocument | null>;
  findCheckoutByProvider(
    provider: string,
    providerCheckoutId: string,
  ): Promise<CheckoutDocument | null>;
  findCheckoutByIdempotencyKey(idempotencyKey: string): Promise<CheckoutDocument | null>;
  /**
   * Optimistic conditional write for a not-yet-settled checkout: persists `checkout` only when the
   * stored checkout is still un-settled (not `completed`, no `orderId`) and its current status is
   * in `allowedFromStatuses`, returning the persisted document — or `null` when a concurrent writer
   * (typically a payment webhook completing the checkout) already moved it. cancelCheckout and
   * expireCheckoutDocument use this so a stale cancel/expire cannot clobber a checkout that just
   * completed. Optional: a host session port that omits it gets a blind `put` fallback with the
   * pre-existing narrow-the-race-with-re-reads behavior.
   */
  putCheckoutIfStatus?(
    checkout: CheckoutDocument,
    allowedFromStatuses: readonly CheckoutStatus[],
  ): Promise<CheckoutDocument | null>;
  put(document: SessionDocument): Promise<void>;
}

/** Customer, entitlement, license, and subscription account data. */
export interface MikaAccountRepositoryPort {
  findCustomerById(customerId: MikaId): Promise<CustomerDocument | null>;
  findCustomerByUserId(userId: string): Promise<CustomerDocument | null>;
  findCustomerByEmailHash(emailHash: string): Promise<CustomerDocument | null>;
  findEntitlementById(entitlementId: MikaId): Promise<EntitlementDocument | null>;
  findLicenseById(licenseId: MikaId): Promise<LicenseDocument | null>;
  findProviderAccount(
    provider: string,
    providerCustomerId: string,
  ): Promise<ProviderAccountDocument | null>;
  findSubscriptionByProvider(
    provider: string,
    providerSubscriptionId: string,
  ): Promise<SubscriptionDocument | null>;
  findSubscriptionById(subscriptionId: MikaId): Promise<SubscriptionDocument | null>;
  listProviderAccountsByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<ProviderAccountDocument>>;
  listSubscriptionsByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<SubscriptionDocument>>;
  listEntitlementsByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<EntitlementDocument>>;
  listEntitlementsByUser(
    userId: string,
    limit?: number,
  ): Promise<MikaDocumentList<EntitlementDocument>>;
  listEntitlementsByEmailHash(
    emailHash: string,
    limit?: number,
  ): Promise<MikaDocumentList<EntitlementDocument>>;
  listLicensesByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<LicenseDocument>>;
  put(document: AccountDocument): Promise<void>;
  anonymizeCustomerForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: boolean; readonly sentinel?: string }>;
  anonymizeEntitlementsForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly userId?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }>;
  anonymizeLicensesForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }>;
}

/** Order ledger and payment correlation lookups. */
export interface MikaLedgerRepositoryPort {
  findOrderById(orderId: MikaId): Promise<OrderDocument | null>;
  findOrderByNumber(orderNumber: string): Promise<OrderDocument | null>;
  findOrderByProviderPayment(
    provider: string,
    providerPaymentId: string,
  ): Promise<OrderDocument | null>;
  findOrderByProviderCheckout(
    provider: string,
    providerCheckoutId: string,
  ): Promise<OrderDocument | null>;
  findOrderByProviderOrder(
    provider: string,
    providerOrderId: string,
  ): Promise<OrderDocument | null>;
  findOrderByCheckoutSession(checkoutSessionId: MikaId): Promise<OrderDocument | null>;
  findOrderByDownloadRef(downloadRef: string): Promise<OrderDocument | null>;
  listOrdersByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<OrderDocument>>;
  listOrdersByEmailHash(
    emailHash: string,
    limit?: number,
  ): Promise<MikaDocumentList<OrderDocument>>;
  anonymizeOrdersForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }>;
  put(document: LedgerDocument): Promise<void>;
}

/** Webhook receipt dedup, lookup, and raw-payload retention. */
export interface MikaWebhookRepositoryPort {
  findWebhookDuplicate(input: {
    readonly provider: string;
    readonly providerEventId?: string;
    readonly eventType: string;
    readonly payloadHash: string;
  }): Promise<WebhookDocument | null>;
  findWebhookById(webhookId: MikaId): Promise<WebhookDocument | null>;
  purgeWebhookRawPayloads(
    cutoff: ISODateTime,
    now: ISODateTime,
    limit?: number,
  ): Promise<{ readonly scanned: number; readonly purged: number }>;
  put(document: WebhookDocument): Promise<void>;
}

/** Account data-export requests and account-delete job tracking. */
export interface MikaAccountDeleteJobRepositoryPort {
  findAccountExport(exportId: MikaId): Promise<AccountExportDocument | null>;
  findAccountDeleteRequest(requestId: MikaId): Promise<AccountDeleteRequestDocument | null>;
  listAccountExportsByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<AccountExportDocument>>;
  listAccountDeleteRequestsByCustomer(
    customerId: MikaId,
    limit?: number,
  ): Promise<MikaDocumentList<AccountDeleteRequestDocument>>;
  listQueuedAccountDeleteRequests(
    limit?: number,
  ): Promise<MikaDocumentList<AccountDeleteRequestDocument>>;
  completeAccountDeleteRequest(
    input: AccountDeleteRequestCompletionRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null>;
  recordAccountDeleteMaintenanceStep(
    input: AccountDeleteMaintenanceStepRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null>;
  recordAccountDeleteRequestError(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null>;
  failAccountDeleteRequest(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null>;
  redactAccountExportsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number>;
  put(document: AccountExportDocument | AccountDeleteRequestDocument): Promise<void>;
}

/** Durable multi-step workflow leases: webhook fulfillment, subscription renewal, and the like. */
export interface MikaWorkflowRepositoryPort {
  findWorkflow(workflowId: MikaId): Promise<WorkflowDocument | null>;
  createWorkflow(document: WorkflowDocument): Promise<WorkflowDocument | null>;
  listDueWorkflows(
    now: ISODateTime,
    limit?: number,
    kind?: WorkflowDocument["kind"],
  ): Promise<MikaDocumentList<WorkflowDocument>>;
  reclaimExhaustedWorkflows(
    now: ISODateTime,
    limit?: number,
    kind?: WorkflowDocument["kind"],
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }>;
  tryLeaseWorkflow(input: WorkflowLeaseRepositoryInput): Promise<WorkflowDocument | null>;
  startWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null>;
  completeWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null>;
  failWorkflowStep(
    input: WorkflowFailureRepositoryInput & { readonly stepName: string },
  ): Promise<WorkflowDocument | null>;
  completeWorkflow(input: {
    readonly workflowId: MikaId;
    readonly leaseKey: string;
    readonly now: ISODateTime;
    readonly state?: JsonObject;
  }): Promise<WorkflowDocument | null>;
  failWorkflow(input: WorkflowFailureRepositoryInput): Promise<WorkflowDocument | null>;
  put(document: WorkflowDocument): Promise<void>;
}

/** Admin action audit trail with idempotency claim and replay support. */
export interface MikaAdminAuditRepositoryPort {
  findAdminAudit(auditId: MikaId): Promise<AdminAuditDocument | null>;
  findAdminAuditByIdempotencyKey(
    action: string,
    idempotencyKey: string,
  ): Promise<AdminAuditDocument | null>;
  claimAdminAuditIdempotency(
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult>;
  writeAudit(document: AdminAuditDocument): Promise<void>;
  put(document: AdminAuditDocument): Promise<void>;
}

/** Transactional email outbox: lease, delivery, retry, and skip bookkeeping. */
export interface MikaEmailOutboxRepositoryPort {
  findEmail(emailId: MikaId): Promise<EmailDocument | null>;
  listDueEmails(now: ISODateTime, limit?: number): Promise<MikaDocumentList<EmailDocument>>;
  reclaimExhaustedEmails(
    now: ISODateTime,
    limit?: number,
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }>;
  tryLeaseEmail(input: EmailLeaseRepositoryInput): Promise<EmailDocument | null>;
  completeEmail(input: EmailCompleteRepositoryInput): Promise<EmailDocument | null>;
  markEmailDelivered(input: EmailDeliveredRepositoryInput): Promise<EmailDocument | null>;
  failEmail(input: EmailFailureRepositoryInput): Promise<EmailDocument | null>;
  skipEmail(input: EmailSkipRepositoryInput): Promise<EmailDocument | null>;
  redactQueuedFailedEmailsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number>;
  put(document: EmailDocument): Promise<void>;
}

/**
 * Operational store: webhooks, workflows, emails, audits, and account-delete jobs. Composed from
 * the five per-store ports above so a host implementing only one concern (e.g. a custom email
 * outbox) can target the narrower port directly instead of the full union.
 */
export interface MikaOpsRepositoryPort
  extends
    MikaWebhookRepositoryPort,
    MikaAccountDeleteJobRepositoryPort,
    MikaWorkflowRepositoryPort,
    MikaAdminAuditRepositoryPort,
    MikaEmailOutboxRepositoryPort {
  put(document: OpsDocument): Promise<void>;
}

/** Stock items, reservation events, and quantity adjustments. */
export interface MikaStockRepositoryPort {
  findItemById(stockItemId: MikaId): Promise<StockItemRecord | null>;
  findBySellableId(sellableId: MikaId): Promise<StockItemRecord | null>;
  findEventByIdempotencyKey(idempotencyKey: string): Promise<StockEventRecord | null>;
  findEventById(eventId: MikaId): Promise<StockEventRecord | null>;
  putItem(record: StockItemRecord): Promise<void>;
  putItemDefinition(record: StockItemRecord): Promise<void>;
  insertEvent(record: StockEventRecord): Promise<void>;
  reserve(input: ReserveStockRepositoryInput): Promise<ReserveStockRepositoryResult>;
  release(
    input: ReleaseReservedStockRepositoryInput,
  ): Promise<ReleaseReservedStockRepositoryResult>;
  expire(input: ReleaseReservedStockRepositoryInput): Promise<ExpireReservedStockRepositoryResult>;
  consume(
    input: ConsumeReservedStockRepositoryInput,
  ): Promise<ConsumeReservedStockRepositoryResult>;
  releaseExpiredReservations(
    input: ReleaseExpiredReservationsRepositoryInput,
  ): Promise<ReleaseExpiredReservationsRepositoryResult>;
  releaseActiveReservationsByCustomer(
    input: ReleaseActiveReservationsByCustomerRepositoryInput,
  ): Promise<ReleaseExpiredReservationsRepositoryResult>;
  extendReservations(input: ExtendReservationsRepositoryInput): Promise<void>;
  adjustStock(input: AdjustStockRepositoryInput): Promise<AdjustStockRepositoryResult>;
}

/** Short-lived tokens, counters, and rate-limit state. */
export interface MikaEphemeralRepositoryPort {
  get(key: string): Promise<EphemeralRecord | null>;
  put(record: EphemeralRecord): Promise<void>;
  incrementCounter(input: {
    readonly key: string;
    readonly kind: EphemeralRecord["kind"];
    readonly subjectHash?: string;
    readonly status?: string;
    readonly expiresAt: ISODateTime;
    readonly now: ISODateTime;
    readonly data?: JsonObject;
  }): Promise<EphemeralRecord>;
  tryAcquireLock(input: {
    readonly key: string;
    readonly owner: string;
    readonly subjectHash?: string;
    readonly expiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<EphemeralRecord | null>;
  releaseLock(input: {
    readonly key: string;
    readonly owner: string;
    readonly now: ISODateTime;
  }): Promise<boolean>;
  consumeToken(key: string, now: ISODateTime): Promise<boolean>;
  /**
   * Reverts a token consumed by {@link consumeToken} back to `pending` (only if it is still
   * `consumed`). Used to compensate a single-use consume whose follow-up side effect failed, so
   * the token stays usable on retry. Returns true when a consumed token was restored.
   */
  restoreToken(key: string, now: ISODateTime): Promise<boolean>;
  purgeExpired(now: ISODateTime): Promise<number>;
  /**
   * Erases every ephemeral record tied to a deleted subject's identity — not just `"token"`
   * kinds. Any kind that carries a subject-linked `subjectHash` (e.g. `"cache_marker"`, used by
   * the download-token reuse pointer) must be included, or account-delete erasure leaves a
   * subject-linked record behind after the token it derived from is gone.
   */
  deleteTokensBySubjectHashes(subjectHashes: readonly string[]): Promise<number>;
}

/** Aggregate repository ports required by {@link createMikaBackendApi}. */
export interface MikaBackendRepositories {
  readonly catalog: MikaCatalogRepositoryPort;
  readonly session: MikaSessionRepositoryPort;
  readonly account: MikaAccountRepositoryPort;
  readonly ledger: MikaLedgerRepositoryPort;
  readonly ops: MikaOpsRepositoryPort;
  readonly stock: MikaStockRepositoryPort;
  readonly ephemeral: MikaEphemeralRepositoryPort;
}

/** Injectable clock for deterministic tests and jobs. */
export type MikaBackendNow = () => Date;
/** Injectable ISO timestamp source aligned with backend `now`. */
export type MikaBackendISODateTime = () => ISODateTime;
/** Namespaced id generator for documents and events. */
export type MikaBackendIdFactory = (namespace: string) => MikaId;
/** Plain text or binary payload accepted by the injectable hash helper. */
export type MikaBackendHashInput = string | Uint8Array;
/** Hash helper for PII, tokens, and webhook payload deduplication. */
export type MikaBackendHashHelper = (input: MikaBackendHashInput) => Promise<string> | string;

/** Site-wide defaults applied when request context omits values. */
export interface MikaBackendDefaults {
  readonly currency?: CurrencyCode;
  readonly locale?: string;
  readonly provider?: ProviderName;
}

/** Discount terms a host coupon resolver grants for an accepted code. */
export interface MikaCouponResolution {
  /** Display label stored on the coupon snapshot; defaults to the normalized code. */
  readonly label?: string;
  /** Fractional discount rate in [0, 1] applied to the cart subtotal. */
  readonly rate: number;
  readonly metadata?: JsonObject;
}

/** Coupon lookup input; `code` arrives trimmed and uppercased. */
export interface MikaCouponResolverInput {
  readonly code: string;
  readonly subtotalAmount: number;
  readonly currency: CurrencyCode;
}

/**
 * Host hook resolving coupon codes to discount terms. Return `null` to reject the code.
 * Without a configured resolver every coupon code is rejected — Mika ships no coupon catalog.
 */
export type MikaCouponResolver = (
  input: MikaCouponResolverInput,
) => Promise<MikaCouponResolution | null> | MikaCouponResolution | null;

/** TTLs, redirect URLs, and metadata knobs for backend-owned resources. */
export interface MikaBackendConfig {
  readonly accountExport?: {
    readonly ttlMs?: number;
  };
  readonly cart?: {
    readonly ttlMs?: number;
  };
  readonly checkout?: {
    readonly cancelUrl?: string;
    readonly successUrl?: string;
    readonly ttlMs?: number;
  };
  readonly coupons?: {
    readonly resolver?: MikaCouponResolver;
  };
  readonly download?: {
    readonly tokenTtlMs?: number;
  };
  readonly magicLink?: {
    readonly ttlMs?: number;
    readonly verifyPath?: string;
  };
  readonly metadata?: JsonObject;
  readonly order?: {
    readonly invoiceTokenTtlMs?: number;
  };
  readonly wishlist?: {
    readonly ttlMs?: number;
  };
}

/**
 * Observer for errors the backend swallows on best-effort paths (compensation releases,
 * webhook status persistence, notification hooks). Without it those failures are invisible;
 * wire it to the host's logger or error tracker. Observer throws are ignored.
 */
export type MikaBackendErrorObserver = (context: {
  readonly scope: string;
  readonly error: unknown;
  readonly metadata?: JsonObject;
}) => void;

/** Shared dependencies injected into backend services and handlers. */
export interface MikaBackendDependencies {
  readonly config?: MikaBackendConfig;
  readonly createId: MikaBackendIdFactory;
  readonly defaults?: MikaBackendDefaults;
  readonly hash: MikaBackendHashHelper;
  readonly isoNow?: MikaBackendISODateTime;
  readonly now: MikaBackendNow;
  readonly notifications?: {
    readonly handle?: MikaNotificationHook;
  };
  readonly onError?: MikaBackendErrorObserver;
  readonly providers: MikaProviderRegistry;
  readonly repositories: MikaBackendRepositories;
}

/** Input for constructing a fully wired {@link MikaApi} from repositories and providers. */
export interface CreateMikaBackendApiInput extends MikaBackendDependencies {
  readonly overrides?: MikaApiOverrides;
}
