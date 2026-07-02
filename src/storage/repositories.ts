/**
 * Repository layer over document collections and operational SQLite tables.
 * Encapsulates typed queries, stock mutations, workflow leases, and ephemeral record access.
 */
import type {
  AccountDeleteRequestDocument,
  AccountDocument,
  AccountExportDocument,
  AdminAuditDocument,
  CartDocument,
  CheckoutDocument,
  CustomerDocument,
  EmailDocument,
  EntitlementDocument,
  LedgerDocument,
  LicenseDocument,
  OrderDocument,
  OpsDocument,
  ProviderAccountDocument,
  SessionDocument,
  SubscriptionDocument,
  WebhookDocument,
  WorkflowDocument,
  WishlistDocument,
} from "../types/documents";
import { isJsonObject, type ISODateTime, type JsonObject, type MikaId } from "../types/primitives";
import type { MikaStorageCollections, StorageCollection } from "./collections";
import {
  documentOfType,
  findFirstByTypeCandidate,
  listAllByType,
  listByTypeCandidates,
  typedCollection,
  type DocumentList,
  type TypedCollectionFacade,
  type TypeScopedQueryOptions,
} from "./repositories/kit";
import { mirrorRecordFields } from "./repositories/record-mirror";
import type { MikaDbExecutor } from "./repositories/db-shared";
import { EphemeralRepository } from "./repositories/ephemeral";
import { StockRepository } from "./repositories/stock";
import { CatalogRepository } from "./repositories/catalog";

export type { MikaDb, MikaDbExecutor, MikaTransaction } from "./repositories/db-shared";
export { EphemeralRepository } from "./repositories/ephemeral";
export { CatalogRepository, type CatalogProviderPriceMatch } from "./repositories/catalog";
export {
  StockRepository,
  type AdjustStockRepositoryInput,
  type AdjustStockRepositoryResult,
  type ConsumeReservedStockRepositoryInput,
  type ConsumeReservedStockRepositoryResult,
  type ExpireReservedStockRepositoryResult,
  type ExtendReservationsRepositoryInput,
  type ReleaseActiveReservationsByCustomerRepositoryInput,
  type ReleaseExpiredReservationsRepositoryInput,
  type ReleaseExpiredReservationsRepositoryResult,
  type ReleaseReservedStockRepositoryInput,
  type ReleaseReservedStockRepositoryResult,
  type ReserveStockRepositoryInput,
  type ReserveStockRepositoryResult,
} from "./repositories/stock";

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

const ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "idempotencyInputHash";

type SessionRepositoryInternals = {
  readonly findOpenCartBySessionAnyCurrency: (sessionId: string) => Promise<CartDocument | null>;
};
const sessionRepositoryInternals = new WeakMap<object, SessionRepositoryInternals>();

function adminAuditInputHashMatches(
  current: AdminAuditDocument,
  next: AdminAuditDocument,
): boolean {
  const currentHash = current.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];
  const nextHash = next.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];

  return typeof currentHash === "string" && currentHash === nextHash;
}

function adminAuditHasTopLevelAction(document: AdminAuditDocument): boolean {
  return typeof (document as { readonly action?: unknown }).action === "string";
}

function adminAuditWithId(document: AdminAuditDocument, id: MikaId): AdminAuditDocument {
  return {
    ...document,
    id,
    record: {
      ...document.record,
      id,
    },
  };
}

/**
 * Increments a cart's optimistic-concurrency version, tolerating a missing `current` (a cart
 * persisted before this field existed) by treating it as version 0 rather than producing NaN —
 * which would otherwise permanently 409 every write to that cart from here on (NaN !== NaN).
 */
export function nextCartVersion(current: number | undefined): number {
  return (current ?? 0) + 1;
}

function cartWithCheckoutClaim(
  cart: CartDocument,
  checkoutId: MikaId,
  claimExpiresAt: ISODateTime,
  now: ISODateTime,
): CartDocument {
  return {
    ...cart,
    status: "checkout_pending",
    aggregate: {
      ...cart.aggregate,
      metadata: {
        ...cart.aggregate.metadata,
        checkoutStartClaimId: checkoutId,
        checkoutStartClaimExpiresAt: claimExpiresAt,
      },
    },
    updatedAt: now,
    version: nextCartVersion(cart.version),
  };
}

function cartWithoutCheckoutClaim(cart: CartDocument, now: ISODateTime): CartDocument {
  const metadata = Object.fromEntries(
    Object.entries(cart.aggregate.metadata ?? {}).filter(
      ([key]) => key !== "checkoutStartClaimId" && key !== "checkoutStartClaimExpiresAt",
    ),
  );

  return {
    ...cart,
    status: "open",
    aggregate: {
      ...cart.aggregate,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
    updatedAt: now,
    version: nextCartVersion(cart.version),
  };
}

/**
 * Reads an open cart by session id across currencies without importing {@link SessionRepository}.
 * Duck-types the repository instance so Astro layout shells can read cart badges with loose coupling.
 */
export function findSessionRepositoryOpenCartBySessionAnyCurrency(
  repository: unknown,
  sessionId: string,
): Promise<CartDocument | null> {
  if (typeof repository !== "object" || repository === null) return Promise.resolve(null);
  return (
    sessionRepositoryInternals.get(repository)?.findOpenCartBySessionAnyCurrency(sessionId) ??
    Promise.resolve(null)
  );
}

/** Document repository for cart, wishlist, and checkout session documents. */
export class SessionRepository {
  private readonly documents: TypedCollectionFacade<SessionDocument>;

  constructor(collection: StorageCollection<SessionDocument>) {
    this.documents = typedCollection(collection);
    sessionRepositoryInternals.set(this, {
      findOpenCartBySessionAnyCurrency: (sessionId) =>
        this.documents.findOneByType("cart", {
          sessionId,
          status: "open",
        }),
    });
  }

  async findById(id: MikaId): Promise<SessionDocument | null> {
    return this.documents.get(id);
  }

  async findCheckoutById(id: MikaId): Promise<CheckoutDocument | null> {
    return this.documents.findByIdOfType(id, "checkout");
  }

  async findOpenCartBySession(sessionId: string, currency: string): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      sessionId,
      status: "open",
      currency,
    });
  }

  async findOpenCartByCustomer(customerId: MikaId, currency: string): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      customerId,
      status: "open",
      currency,
    });
  }

  async findCheckoutPendingCartBySession(
    sessionId: string,
    currency: string,
  ): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      sessionId,
      status: "checkout_pending",
      currency,
    });
  }

  async findCheckoutPendingCartByCustomer(
    customerId: MikaId,
    currency: string,
  ): Promise<CartDocument | null> {
    return this.documents.findOneByType("cart", {
      customerId,
      status: "checkout_pending",
      currency,
    });
  }

  async listCheckoutPendingCartsBySession(
    sessionId: string,
    limit = 20,
  ): Promise<DocumentList<CartDocument>> {
    return this.documents.listByType("cart", {
      where: { sessionId, status: "checkout_pending" },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listCheckoutPendingCartsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<CartDocument>> {
    return this.documents.listByType("cart", {
      where: { customerId, status: "checkout_pending" },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async claimCartForCheckout(input: {
    readonly cartId: MikaId;
    readonly checkoutId: MikaId;
    readonly expectedVersion: number | undefined;
    readonly claimExpiresAt: ISODateTime;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null> {
    const updated = await this.documents.update(input.cartId, (current) => {
      const cart = documentOfType(current, "cart");
      if (!cart || cart.status !== "open") return null;
      // A cart with no version (persisted before this field existed) has nothing to compare —
      // allow the write instead of vacuously matching (undefined !== expectedVersion is always
      // true, so a strict check would permanently 409 every such cart) or vacuously rejecting it.
      if (cart.version !== undefined && cart.version !== input.expectedVersion) return null;

      return cartWithCheckoutClaim(cart, input.checkoutId, input.claimExpiresAt, input.now);
    });

    return documentOfType(updated, "cart");
  }

  async releaseCartCheckoutClaim(input: {
    readonly cartId: MikaId;
    readonly checkoutId: MikaId;
    readonly now: ISODateTime;
  }): Promise<CartDocument | null> {
    const updated = await this.documents.update(input.cartId, (current) => {
      const cart = documentOfType(current, "cart");
      if (!cart || cart.status !== "checkout_pending") return null;
      if (cart.aggregate.metadata?.["checkoutStartClaimId"] !== input.checkoutId) return null;

      return cartWithoutCheckoutClaim(cart, input.now);
    });

    return documentOfType(updated, "cart");
  }

  async putCartIfUnchanged(
    cart: CartDocument,
    expectedVersion: number | undefined,
  ): Promise<CartDocument | null> {
    const updated = await this.documents.update(cart.id, (current) => {
      const existing = documentOfType(current, "cart");
      if (!existing || existing.status !== "open") return null;
      // See claimCartForCheckout: a cart with no version (persisted before this field existed)
      // has nothing to compare — allow the write rather than permanently 409ing every such cart.
      if (existing.version !== undefined && existing.version !== expectedVersion) return null;

      return cart;
    });

    return documentOfType(updated, "cart");
  }

  async findWishlistBySession(sessionId: string): Promise<WishlistDocument | null> {
    return this.documents.findOneByType("wishlist", {
      sessionId,
      status: "active",
    });
  }

  async findWishlistByCustomer(customerId: MikaId): Promise<WishlistDocument | null> {
    return this.documents.findOneByType("wishlist", {
      customerId,
      status: "active",
    });
  }

  async findCheckoutByProvider(
    provider: string,
    providerCheckoutId: string,
  ): Promise<CheckoutDocument | null> {
    return this.documents.findOneByType("checkout", {
      provider,
      providerCheckoutId,
    });
  }

  async findCheckoutByIdempotencyKey(idempotencyKey: string): Promise<CheckoutDocument | null> {
    if (!idempotencyKey) return null;

    const indexed = await this.documents.findOneByType("checkout", {
      checkoutIdempotencyKey: idempotencyKey,
    });
    if (indexed) return indexed;

    return findFirstByTypeCandidate(this.documents, "checkout", (item) =>
      item.data.aggregate.metadata?.["checkoutIdempotencyKey"] === idempotencyKey
        ? item.data
        : null,
    );
  }

  async put(document: SessionDocument): Promise<void> {
    await this.documents.put(document);
  }
}

/** Document repository for customer, entitlement, license, and subscription documents. */
export class AccountRepository {
  private readonly documents: TypedCollectionFacade<AccountDocument>;

  constructor(collection: StorageCollection<AccountDocument>) {
    this.documents = typedCollection(collection);
  }

  async findCustomerById(customerId: MikaId): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { customerId });
  }

  async findCustomerByUserId(userId: string): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { userId });
  }

  async findCustomerByEmailHash(emailHash: string): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { emailHash });
  }

  async findEntitlementById(entitlementId: MikaId): Promise<EntitlementDocument | null> {
    return this.documents.findByIdOfType(entitlementId, "entitlement");
  }

  async findLicenseById(licenseId: MikaId): Promise<LicenseDocument | null> {
    return this.documents.findByIdOfType(licenseId, "license");
  }

  async findProviderAccount(
    provider: string,
    providerCustomerId: string,
  ): Promise<ProviderAccountDocument | null> {
    return this.documents.findOneByType("providerAccount", {
      provider,
      providerCustomerId,
    });
  }

  async findSubscriptionByProvider(
    provider: string,
    providerSubscriptionId: string,
  ): Promise<SubscriptionDocument | null> {
    return this.documents.findOneByType("subscription", {
      provider,
      providerSubscriptionId,
    });
  }

  async findSubscriptionById(subscriptionId: MikaId): Promise<SubscriptionDocument | null> {
    return this.documents.findByIdOfType(subscriptionId, "subscription");
  }

  async listProviderAccountsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<ProviderAccountDocument>> {
    return this.documents.listByType("providerAccount", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listSubscriptionsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<SubscriptionDocument>> {
    return this.documents.listByType("subscription", {
      where: { customerId },
      orderBy: { currentPeriodEnd: "desc" },
      limit,
    });
  }

  async listEntitlementsByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listEntitlementsByUser(
    userId: string,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { userId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listEntitlementsByEmailHash(
    emailHash: string,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { emailHash },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listLicensesByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<LicenseDocument>> {
    return this.documents.listByType("license", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async put(document: AccountDocument): Promise<void> {
    await this.documents.put(document);
  }

  async anonymizeCustomerForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: boolean; readonly sentinel?: string }> {
    const customer =
      (input.customerId ? await this.findCustomerById(input.customerId) : null) ??
      (input.emailHash ? await this.findCustomerByEmailHash(input.emailHash) : null);
    if (!customer) return { anonymized: false };

    const sentinel = `account-deleted:${customer.customerId}`;
    const anonymized: CustomerDocument = {
      ...customer,
      emailHash: sentinel,
      userId: sentinel,
      aggregate: {
        ...customer.aggregate,
        email: undefined,
        emailHash: sentinel,
        name: undefined,
        company: undefined,
        vatId: undefined,
        metadata: {
          ...customer.aggregate.metadata,
          anonymizedAt: input.now,
        },
      },
      updatedAt: input.now,
    };

    await this.put(anonymized);

    return { anonymized: true, sentinel };
  }

  async anonymizeEntitlementsForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly userId?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const byId = new Map<MikaId, EntitlementDocument>();
    if (input.customerId) {
      for (const item of await listAllByType(this.documents, "entitlement", {
        where: { customerId: input.customerId },
        orderBy: { updatedAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.emailHash) {
      for (const item of await listAllByType(this.documents, "entitlement", {
        where: { emailHash: input.emailHash },
        orderBy: { updatedAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.userId) {
      for (const item of await listAllByType(this.documents, "entitlement", {
        where: { userId: input.userId },
        orderBy: { updatedAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }

    let anonymized = 0;
    for (const entitlement of byId.values()) {
      const redacted: EntitlementDocument = {
        ...entitlement,
        emailHash: input.sentinel,
        userId: input.sentinel,
        record: {
          ...entitlement.record,
          emailHash: input.sentinel,
          userId: input.sentinel,
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }

  async anonymizeLicensesForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const licenses = input.customerId
      ? await listAllByType(this.documents, "license", {
          where: { customerId: input.customerId },
          orderBy: { updatedAt: "desc" },
        })
      : [];

    let anonymized = 0;
    for (const item of licenses) {
      const license = item.data;
      const redacted: LicenseDocument = {
        ...license,
        customerId: undefined,
        status: "revoked",
        record: {
          ...license.record,
          licenseKeyHash: `${input.sentinel}:license-redacted`,
          displayKeySuffix: "redacted",
          status: "revoked",
          revokedAt: license.record.revokedAt ?? input.now,
          metadata: {
            ...license.record.metadata,
            anonymizedAt: input.now,
          },
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }
}

/** Document repository for order ledger documents and provider payment lookup. */
export class LedgerRepository {
  private readonly documents: TypedCollectionFacade<LedgerDocument>;

  constructor(collection: StorageCollection<LedgerDocument>) {
    this.documents = typedCollection(collection);
  }

  async findOrderById(orderId: MikaId): Promise<OrderDocument | null> {
    return this.documents.findByIdOfType(orderId, "order");
  }

  async findOrderByNumber(orderNumber: string): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", { orderNumber });
  }

  async findOrderByProviderPayment(
    provider: string,
    providerPaymentId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerPaymentId,
    });
  }

  async findOrderByProviderCheckout(
    provider: string,
    providerCheckoutId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerCheckoutId,
    });
  }

  async findOrderByProviderOrder(
    provider: string,
    providerOrderId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerOrderId,
    });
  }

  async findOrderByCheckoutSession(checkoutSessionId: MikaId): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", { checkoutSessionId });
  }

  async findOrderByDownloadRef(downloadRef: string): Promise<OrderDocument | null> {
    return findFirstByTypeCandidate(this.documents, "order", (item) =>
      item.data.aggregate.lines.some((line) => line.downloadRefs?.includes(downloadRef))
        ? item.data
        : null,
    );
  }

  async listOrdersByCustomer(customerId: MikaId, limit = 50): Promise<DocumentList<OrderDocument>> {
    return this.documents.listByType("order", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listOrdersByEmailHash(emailHash: string, limit = 50): Promise<DocumentList<OrderDocument>> {
    return this.documents.listByType("order", {
      where: { emailHash },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async anonymizeOrdersForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const byId = new Map<MikaId, OrderDocument>();
    if (input.customerId) {
      for (const item of await listAllByType(this.documents, "order", {
        where: { customerId: input.customerId },
        orderBy: { createdAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.emailHash) {
      for (const item of await listAllByType(this.documents, "order", {
        where: { emailHash: input.emailHash },
        orderBy: { createdAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }

    let anonymized = 0;
    for (const order of byId.values()) {
      const redacted: OrderDocument = {
        ...order,
        emailHash: input.sentinel,
        aggregate: {
          ...order.aggregate,
          customer: {
            ...order.aggregate.customer,
            email: undefined,
            emailHash: input.sentinel,
            name: undefined,
            company: undefined,
            vatId: undefined,
          },
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }

  async put(document: LedgerDocument): Promise<void> {
    await this.documents.put(document);
  }
}

/** Document repository for webhooks, emails, workflows, audits, and account ops records. */
export class OpsRepository {
  private readonly documents: TypedCollectionFacade<OpsDocument>;

  constructor(collection: StorageCollection<OpsDocument>) {
    this.documents = typedCollection(collection);
  }

  async findWebhookDuplicate(input: {
    readonly provider: string;
    readonly providerEventId?: string;
    readonly eventType: string;
    readonly payloadHash: string;
  }): Promise<WebhookDocument | null> {
    if (input.providerEventId !== undefined) {
      const duplicate = await this.documents.findOneByType("webhook", {
        provider: input.provider,
        providerEventId: input.providerEventId,
      });
      if (duplicate) return duplicate;
    }

    return this.documents.findOneByType("webhook", {
      provider: input.provider,
      payloadHash: input.payloadHash,
    });
  }

  async findWebhookById(webhookId: MikaId): Promise<WebhookDocument | null> {
    return this.documents.findByIdOfType(webhookId, "webhook");
  }

  async findAccountExport(exportId: MikaId): Promise<AccountExportDocument | null> {
    return this.documents.findByIdOfType(exportId, "accountExport");
  }

  async findAccountDeleteRequest(requestId: MikaId): Promise<AccountDeleteRequestDocument | null> {
    return this.documents.findByIdOfType(requestId, "accountDeleteRequest");
  }

  async listAccountExportsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountExportDocument>> {
    return this.documents.listByType("accountExport", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listAccountDeleteRequestsByCustomer(
    customerId: MikaId,
    limit = 20,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return this.documents.listByType("accountDeleteRequest", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listQueuedAccountDeleteRequests(
    limit = 25,
  ): Promise<DocumentList<AccountDeleteRequestDocument>> {
    return this.documents.listByType("accountDeleteRequest", {
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      limit,
    });
  }

  async completeAccountDeleteRequest(
    input: AccountDeleteRequestCompletionRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        status: "completed",
        completedAt: input.now,
        userId: undefined,
        emailHash: undefined,
        confirmTokenHash: undefined,
        lastError: undefined,
        metadata: {
          ...request.record.metadata,
          ...input.metadata,
        },
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async recordAccountDeleteMaintenanceStep(
    input: AccountDeleteMaintenanceStepRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        lastError: undefined,
        metadata: accountDeleteMaintenanceStepMetadata(request.record.metadata, input),
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async recordAccountDeleteRequestError(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async failAccountDeleteRequest(
    input: AccountDeleteRequestFailureRepositoryInput,
  ): Promise<AccountDeleteRequestDocument | null> {
    const updated = await this.documents.update(input.requestId, (current) => {
      const request = documentOfType(current, "accountDeleteRequest");
      if (!request || request.status !== "queued") return null;

      return accountDeleteRequestDocumentWithRecord(request, input.now, {
        status: "failed",
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "accountDeleteRequest");
  }

  async findWorkflow(workflowId: MikaId): Promise<WorkflowDocument | null> {
    return this.documents.findByIdOfType(workflowId, "workflow");
  }

  async createWorkflow(document: WorkflowDocument): Promise<WorkflowDocument | null> {
    const created = await this.documents.update(document.id, (current) =>
      current === null ? document : null,
    );

    return documentOfType(created, "workflow");
  }

  async listDueWorkflows(
    now: ISODateTime,
    limit = 50,
    kind?: WorkflowDocument["kind"],
  ): Promise<DocumentList<WorkflowDocument>> {
    const target = limit + 1;
    const ready = await listLeaseableWorkflowCandidates(this.documents, now, target, {
      where: {
        ...(kind ? { kind } : {}),
        status: { in: ["queued", "failed"] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: "asc" },
    });
    const expiredRunning = await listLeaseableWorkflowCandidates(this.documents, now, target, {
      where: {
        ...(kind ? { kind } : {}),
        status: "running",
        leaseExpiresAt: { lte: now },
      },
      orderBy: { leaseExpiresAt: "asc" },
    });
    const workflows = Array.from(
      new Map(
        [...ready.items, ...expiredRunning.items].map((item) => [item.id, item] as const),
      ).values(),
    ).sort((left, right) =>
      workflowDueSortKey(left.data).localeCompare(workflowDueSortKey(right.data)),
    );
    const items = workflows.slice(0, limit);
    const hasMore = ready.hasMore || expiredRunning.hasMore || workflows.length > limit;

    // No real cursor exists for this page: it's a merge-sort of two independently-cursored
    // sub-queries (ready, expiredRunning) re-ordered by a third key, and listDueWorkflows's own
    // signature has no cursor parameter to resume with anyway. hasMore still tells the caller
    // there's more than `limit` due work; a due workflow stays due, so a later call (or a larger
    // limit) picks up what this page dropped rather than losing it.
    return {
      items,
      hasMore,
    };
  }

  async reclaimExhaustedWorkflows(
    now: ISODateTime,
    limit = 50,
    kind?: WorkflowDocument["kind"],
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "workflow",
      limit + 1,
      {
        where: {
          ...(kind ? { kind } : {}),
          status: "running",
          leaseExpiresAt: { lte: now },
        },
        orderBy: { leaseExpiresAt: "asc" },
      },
      (workflow) => workflowIsExhausted(workflow, now),
    );

    const stuck = candidates.items.slice(0, limit);
    let reclaimed = 0;
    for (const candidate of stuck) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const workflow = documentOfType(current, "workflow");
        if (!workflow || !workflowIsExhausted(workflow, now)) return null;

        return workflowDocumentWithRecord(workflow, now, {
          status: "failed",
          leaseKey: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
          lastError:
            workflow.record.lastError ??
            "Workflow exhausted its lease attempts without completing; marked failed for replay.",
        });
      });
      if (documentOfType(updated, "workflow")) reclaimed += 1;
    }

    return { scanned: stuck.length, reclaimed };
  }

  async purgeWebhookRawPayloads(
    cutoff: ISODateTime,
    now: ISODateTime,
    limit = 50,
  ): Promise<{ readonly scanned: number; readonly purged: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "webhook",
      limit + 1,
      {
        where: { receivedAt: { lte: cutoff } },
        orderBy: { receivedAt: "asc" },
      },
      (webhook) => webhookRawPayloadIsPurgeable(webhook, cutoff),
    );

    const stale = candidates.items.slice(0, limit);
    let purged = 0;
    for (const candidate of stale) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const webhook = documentOfType(current, "webhook");
        if (!webhook || !webhookRawPayloadIsPurgeable(webhook, cutoff)) return null;

        return webhookDocumentWithRecord(webhook, now, {
          rawPayloadJson: undefined,
          rawPayloadPurgedAt: now,
        });
      });
      if (documentOfType(updated, "webhook")) purged += 1;
    }

    return { scanned: stale.length, purged };
  }

  async tryLeaseWorkflow(input: WorkflowLeaseRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (workflow.status === "completed") return null;
      if (!workflowIsDueForLease(workflow, input.now, input.force)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        attemptCount: workflow.record.attemptCount + 1,
        nextAttemptAt: undefined,
        leaseKey: input.leaseKey,
        leasedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async startWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) => {
        if (step.name !== input.stepName || step.status === "completed") return step;

        return {
          ...step,
          status: "running" as const,
          startedAt: input.now,
          failedAt: undefined,
          completedAt: undefined,
          attemptCount: step.attemptCount + 1,
          nextAttemptAt: undefined,
          lastError: undefined,
        };
      });

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        steps,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async completeWorkflowStep(input: WorkflowStepRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) => {
        if (step.name !== input.stepName || step.status === "completed") return step;

        return {
          ...step,
          status: "completed" as const,
          startedAt: step.startedAt ?? input.now,
          completedAt: input.now,
          failedAt: undefined,
          nextAttemptAt: undefined,
          lastError: undefined,
          ...(input.state ? { state: { ...step.state, ...input.state } } : {}),
        };
      });

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "running",
        steps,
        nextAttemptAt: undefined,
        lastError: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async failWorkflowStep(
    input: WorkflowFailureRepositoryInput & { readonly stepName: string },
  ): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      const steps = workflow.record.steps.map((step) =>
        step.name === input.stepName && step.status !== "completed"
          ? {
              ...step,
              status: "failed" as const,
              failedAt: input.now,
              nextAttemptAt: input.nextAttemptAt,
              lastError: input.lastError,
            }
          : step,
      );

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "failed",
        steps,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
      });
    });

    return documentOfType(updated, "workflow");
  }

  async completeWorkflow(input: {
    readonly workflowId: MikaId;
    readonly leaseKey: string;
    readonly now: ISODateTime;
    readonly state?: JsonObject;
  }): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "completed",
        completedAt: input.now,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        resumeState: { ...workflow.record.resumeState, ...input.state },
        steps: workflow.record.steps.map((step) =>
          step.status === "queued"
            ? {
                ...step,
                status: "skipped" as const,
              }
            : step,
        ),
      });
    });

    return documentOfType(updated, "workflow");
  }

  async failWorkflow(input: WorkflowFailureRepositoryInput): Promise<WorkflowDocument | null> {
    const updated = await this.documents.update(input.workflowId, (current) => {
      const workflow = documentOfType(current, "workflow");
      if (!workflow) return null;
      if (!workflowHasActiveLease(workflow, input)) return null;

      return workflowDocumentWithRecord(workflow, input.now, {
        status: "failed",
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        steps: workflow.record.steps.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: "failed",
                failedAt: input.now,
                nextAttemptAt: input.nextAttemptAt,
                lastError: input.lastError,
              }
            : step,
        ),
      });
    });

    return documentOfType(updated, "workflow");
  }

  async findAdminAudit(auditId: MikaId): Promise<AdminAuditDocument | null> {
    return this.documents.findByIdOfType(auditId, "adminAudit");
  }

  async findAdminAuditByIdempotencyKey(
    action: string,
    idempotencyKey: string,
  ): Promise<AdminAuditDocument | null> {
    return findFirstByTypeCandidate(
      this.documents,
      "adminAudit",
      (item) => (item.data.record.action === action ? item.data : null),
      { where: { idempotencyKey } },
    );
  }

  async claimAdminAuditIdempotency(
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult> {
    if (!document.record.idempotencyKey) {
      await this.writeAudit(document);

      return { status: "claimed", audit: document };
    }

    const legacy = await this.findAdminAuditByIdempotencyKey(
      document.record.action,
      document.record.idempotencyKey,
    );
    if (legacy && !adminAuditHasTopLevelAction(legacy)) {
      const reclaimed = await this.reclaimFailedAdminAuditIdempotency(legacy, document);

      return reclaimed ?? { status: "existing", audit: legacy };
    }

    try {
      await this.writeAudit(document);

      return { status: "claimed", audit: document };
    } catch (error) {
      const existing = await this.findAdminAuditByIdempotencyKey(
        document.record.action,
        document.record.idempotencyKey,
      );
      if (existing) {
        const reclaimed = await this.reclaimFailedAdminAuditIdempotency(existing, document);
        if (reclaimed) return reclaimed;
        return { status: "existing", audit: existing };
      }

      throw error;
    }
  }

  private async reclaimFailedAdminAuditIdempotency(
    existing: AdminAuditDocument,
    document: AdminAuditDocument,
  ): Promise<AdminAuditIdempotencyClaimResult | undefined> {
    if (existing.record.status !== "failed" || !adminAuditInputHashMatches(existing, document)) {
      return undefined;
    }

    let reclaimedByThisCall = false;
    const reclaimed = await this.documents.update(existing.id, (current) => {
      // Reset on every invocation: adapters may retry the updater on write contention, and only
      // the last (committed) invocation's determination may survive — a stale `true` from an
      // earlier, uncommitted attempt must not outlive a later attempt that finds nothing to claim.
      reclaimedByThisCall = false;
      const currentAudit = documentOfType(current, "adminAudit");
      if (
        !currentAudit ||
        currentAudit.record.status !== "failed" ||
        !adminAuditInputHashMatches(currentAudit, document)
      ) {
        return current;
      }

      reclaimedByThisCall = true;

      return adminAuditWithId(document, currentAudit.id);
    });
    const audit = documentOfType(reclaimed, "adminAudit");
    if (reclaimedByThisCall && audit?.record.status === "started") {
      return { status: "claimed", audit };
    }
    if (audit) return { status: "existing", audit };

    return undefined;
  }

  async findEmail(emailId: MikaId): Promise<EmailDocument | null> {
    return this.documents.findByIdOfType(emailId, "email");
  }

  async listDueEmails(now: ISODateTime, limit = 50): Promise<DocumentList<EmailDocument>> {
    const target = limit + 1;
    const result = await listByTypeCandidates(
      this.documents,
      "email",
      target,
      {
        where: {
          status: { in: ["queued", "failed"] },
        },
        orderBy: { nextAttemptAt: "asc" },
      },
      (email) => emailIsDueForLease(email, now),
    );
    const items = result.items.slice(0, limit);
    const hasMore = result.hasMore || result.items.length > limit;

    // result.cursor (from listByTypeCandidates) resumes after the last raw page fetched, not
    // after the `limit`-th due candidate — when a single raw page yields more due candidates than
    // `limit`, it would skip the held-back ones. listDueEmails's own signature has no cursor
    // parameter to resume with anyway; hasMore tells the caller there's more than `limit` due
    // work, and a due email stays due, so a later call (or a larger limit) picks it up.
    return {
      items,
      hasMore,
    };
  }

  async reclaimExhaustedEmails(
    now: ISODateTime,
    limit = 50,
  ): Promise<{ readonly scanned: number; readonly reclaimed: number }> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "email",
      limit + 1,
      {
        where: {
          status: "queued",
        },
        orderBy: { nextAttemptAt: "asc" },
      },
      (email) => emailIsExhaustedLeaseLoss(email, now),
    );

    const exhausted = candidates.items.slice(0, limit);
    let reclaimed = 0;
    for (const candidate of exhausted) {
      const updated = await this.documents.update(candidate.id, (current) => {
        const email = documentOfType(current, "email");
        if (!email || !emailIsExhaustedLeaseLoss(email, now)) return null;

        return emailDocumentWithRecord(email, now, {
          status: "failed",
          nextAttemptAt: undefined,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError:
            email.record.lastError ??
            "Email exhausted its lease attempts without delivery; marked failed for review.",
        });
      });
      if (documentOfType(updated, "email")) reclaimed += 1;
    }

    return { scanned: exhausted.length, reclaimed };
  }

  async tryLeaseEmail(input: EmailLeaseRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailIsDueForLease(email, input.now, input.force)) return null;

      return emailDocumentWithRecord(email, input.now, {
        attemptCount: email.record.attemptCount + 1,
        nextAttemptAt: input.leaseExpiresAt,
        lastError: undefined,
        leaseKey: input.leaseKey,
        leasedAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
      });
    });

    return documentOfType(updated, "email");
  }

  async completeEmail(input: EmailCompleteRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "sent",
        providerMessageId: input.providerMessageId,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        sentAt: input.now,
        metadata: emailSentMetadata(email, input.now),
      });
    });

    return documentOfType(updated, "email");
  }

  async markEmailDelivered(input: EmailDeliveredRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (email.record.status === "sent") return email;

      return emailDocumentWithRecord(email, input.now, {
        status: "sent",
        providerMessageId: input.providerMessageId,
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        sentAt: input.now,
        metadata: emailSentMetadata(email, input.now),
      });
    });

    return documentOfType(updated, "email");
  }

  async failEmail(input: EmailFailureRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "failed",
        nextAttemptAt: input.nextAttemptAt,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "email");
  }

  async skipEmail(input: EmailSkipRepositoryInput): Promise<EmailDocument | null> {
    const updated = await this.documents.update(input.emailId, (current) => {
      const email = documentOfType(current, "email");
      if (!email) return null;
      if (!emailHasActiveLease(email, input)) return null;

      return emailDocumentWithRecord(email, input.now, {
        status: "skipped",
        nextAttemptAt: undefined,
        leaseKey: undefined,
        leasedAt: undefined,
        leaseExpiresAt: undefined,
        lastError: input.lastError,
      });
    });

    return documentOfType(updated, "email");
  }

  async redactQueuedFailedEmailsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "email",
      1000,
      {
        where: { status: { in: ["queued", "failed"] } },
        orderBy: { createdAt: "asc" },
      },
      (email) => emailMatchesAccountDeleteIdentity(email, input),
    );
    let redacted = 0;

    for (const item of candidates.items) {
      const updated = await this.documents.update(item.id, (current) => {
        const email = documentOfType(current, "email");
        if (!email || !emailMatchesAccountDeleteIdentity(email, input)) return null;
        if (email.status !== "queued" && email.status !== "failed") return null;

        return emailDocumentWithRecord(email, input.now, {
          customerId: undefined,
          orderId: undefined,
          tokenId: undefined,
          toEmail: `redacted-${email.id}@redacted.invalid`,
          subject: "Redacted email",
          status: "skipped",
          nextAttemptAt: undefined,
          leaseKey: undefined,
          leasedAt: undefined,
          leaseExpiresAt: undefined,
          lastError: "Redacted after account deletion.",
          metadata: {
            redactedAt: input.now,
          },
        });
      });

      if (updated) redacted += 1;
    }

    return redacted;
  }

  async redactAccountExportsForAccountDelete(
    input: AccountDeleteEmailRedactionRepositoryInput,
  ): Promise<number> {
    const candidates = await listByTypeCandidates(
      this.documents,
      "accountExport",
      1000,
      {
        orderBy: { createdAt: "asc" },
      },
      (document) => accountExportMatchesAccountDeleteIdentity(document, input),
    );
    let redacted = 0;

    for (const item of candidates.items) {
      const updated = await this.documents.update(item.id, (current) => {
        const document = documentOfType(current, "accountExport");
        if (!document || !accountExportMatchesAccountDeleteIdentity(document, input)) return null;
        if (document.record.artifactRef === undefined && document.status === "expired") return null;

        return {
          ...document,
          status: "expired",
          expiresAt: input.now,
          updatedAt: input.now,
          record: {
            ...document.record,
            status: "expired",
            expiresAt: input.now,
            artifactRef: undefined,
            downloadTokenHash: undefined,
            lastError: "Redacted after account deletion.",
            metadata: {
              ...document.record.metadata,
              redactedAt: input.now,
            },
          },
        };
      });

      if (updated) redacted += 1;
    }

    return redacted;
  }

  async writeAudit(document: AdminAuditDocument): Promise<void> {
    await this.put(document);
  }

  async put(document: OpsDocument): Promise<void> {
    await this.documents.put(document);
  }
}

async function listLeaseableWorkflowCandidates(
  documents: TypedCollectionFacade<OpsDocument>,
  now: ISODateTime,
  target: number,
  options: TypeScopedQueryOptions<WorkflowDocument>,
): Promise<DocumentList<WorkflowDocument>> {
  return listByTypeCandidates(documents, "workflow", target, options, (workflow) =>
    workflowIsDueForLease(workflow, now),
  );
}

function workflowIsDueForLease(
  workflow: WorkflowDocument,
  now: ISODateTime,
  force = false,
): boolean {
  if (workflow.record.leaseExpiresAt && workflow.record.leaseExpiresAt > now) return false;
  if (workflow.status === "running" && !workflow.record.leaseExpiresAt) return false;
  if (force) return workflow.status !== "completed";
  if (workflow.record.attemptCount >= workflow.record.maxAttempts) return false;

  return !workflow.nextAttemptAt || workflow.nextAttemptAt <= now;
}

function workflowIsExhausted(workflow: WorkflowDocument, now: ISODateTime): boolean {
  return (
    workflow.status === "running" &&
    workflow.record.leaseExpiresAt !== undefined &&
    workflow.record.leaseExpiresAt <= now &&
    workflow.record.attemptCount >= workflow.record.maxAttempts
  );
}

function workflowDueSortKey(workflow: WorkflowDocument): ISODateTime {
  return (
    workflow.nextAttemptAt ??
    workflow.record.leaseExpiresAt ??
    workflow.leaseExpiresAt ??
    workflow.updatedAt
  );
}

function webhookRawPayloadIsPurgeable(webhook: WebhookDocument, cutoff: ISODateTime): boolean {
  return (
    webhook.record.receivedAt <= cutoff &&
    webhook.record.rawPayloadJson !== undefined &&
    webhook.record.rawPayloadPurgedAt === undefined &&
    (webhook.status === "processed" || webhook.record.normalizedPayloadJson !== undefined)
  );
}

function webhookDocumentWithRecord(
  webhook: WebhookDocument,
  now: ISODateTime,
  patch: Partial<WebhookDocument["record"]>,
): WebhookDocument {
  return mirrorRecordFields(webhook, now, patch, ["status", "nextAttemptAt", "receivedAt"]);
}

function workflowHasActiveLease(
  workflow: WorkflowDocument,
  input: { readonly leaseKey: string; readonly now: ISODateTime },
): boolean {
  if (workflow.status !== "running") return false;
  if (workflow.record.leaseKey !== input.leaseKey) return false;
  if (!workflow.record.leaseExpiresAt || workflow.record.leaseExpiresAt <= input.now) return false;

  return true;
}

function workflowDocumentWithRecord(
  workflow: WorkflowDocument,
  now: ISODateTime,
  patch: Partial<WorkflowDocument["record"]>,
): WorkflowDocument {
  return mirrorRecordFields(workflow, now, { ...patch, updatedAt: now }, [
    "kind",
    "status",
    "subjectType",
    "subjectId",
    "idempotencyKey",
    "nextAttemptAt",
    "leaseExpiresAt",
  ]);
}

function emailIsDueForLease(email: EmailDocument, now: ISODateTime, force = false): boolean {
  if (email.status === "sent" || email.status === "skipped") return false;
  const leaseExpiresAt = email.record.leaseExpiresAt;
  if (leaseExpiresAt && leaseExpiresAt > now) return false;
  if (force) return true;
  if (email.record.attemptCount >= email.record.maxAttempts) return false;

  return !email.nextAttemptAt || email.nextAttemptAt <= now;
}

function emailIsExhaustedLeaseLoss(email: EmailDocument, now: ISODateTime): boolean {
  if (email.status !== "queued") return false;
  const leaseExpiresAt = email.record.leaseExpiresAt;
  if (!leaseExpiresAt || leaseExpiresAt > now) return false;
  if (email.record.attemptCount < email.record.maxAttempts) return false;

  return !email.record.lastError;
}

function emailHasActiveLease(
  email: EmailDocument,
  input: { readonly leaseKey: string; readonly now: ISODateTime },
): boolean {
  const leaseKey = email.record.leaseKey;
  const leaseExpiresAt = email.record.leaseExpiresAt;

  return leaseKey === input.leaseKey && leaseExpiresAt !== undefined && leaseExpiresAt > input.now;
}

function emailDocumentWithRecord(
  email: EmailDocument,
  now: ISODateTime,
  patch: Partial<EmailDocument["record"]>,
): EmailDocument {
  return mirrorRecordFields(email, now, patch, [
    "status",
    "nextAttemptAt",
    "orderId",
    "tokenId",
    "kind",
  ]);
}

function emailSentMetadata(email: EmailDocument, now: ISODateTime): JsonObject | undefined {
  const metadata = email.record.metadata;
  if (email.kind !== "magic_link" || !metadata) return metadata;
  if (metadata["link"] === undefined && metadata["url"] === undefined) return metadata;

  const { link: _link, url: _url, ...redacted } = metadata;
  return {
    ...redacted,
    linkRedactedAt: now,
  };
}

function emailMatchesAccountDeleteIdentity(
  email: EmailDocument,
  identity: AccountDeleteEmailRedactionRepositoryInput,
): boolean {
  const record = email.record;

  return Boolean(
    (identity.customerId && record.customerId === identity.customerId) ||
    (identity.userId && record.metadata?.["userId"] === identity.userId) ||
    (identity.emailHash && record.metadata?.["emailHash"] === identity.emailHash),
  );
}

function accountExportMatchesAccountDeleteIdentity(
  document: AccountExportDocument,
  identity: AccountDeleteEmailRedactionRepositoryInput,
): boolean {
  const record = document.record;

  return Boolean(
    (identity.customerId && record.customerId === identity.customerId) ||
    (identity.userId && record.userId === identity.userId) ||
    (identity.emailHash && record.emailHash === identity.emailHash),
  );
}

function accountDeleteMaintenanceStepMetadata(
  metadata: JsonObject | undefined,
  input: AccountDeleteMaintenanceStepRepositoryInput,
): JsonObject {
  const maintenance = jsonObjectChild(metadata, "maintenance");
  const steps = jsonObjectChild(maintenance, "steps");

  return {
    ...metadata,
    maintenance: {
      ...maintenance,
      steps: {
        ...steps,
        [input.stepName]: {
          status: "completed",
          completedAt: input.now,
          result: input.result,
        },
      },
    },
  };
}

function jsonObjectChild(input: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = input?.[key];

  return isJsonObject(value) ? value : undefined;
}

function accountDeleteRequestDocumentWithRecord(
  request: AccountDeleteRequestDocument,
  now: ISODateTime,
  patch: Partial<AccountDeleteRequestDocument["record"]>,
): AccountDeleteRequestDocument {
  return mirrorRecordFields(request, now, patch, [
    "customerId",
    "userId",
    "emailHash",
    "status",
    "expiresAt",
  ]);
}

/** Facade wiring document and operational repositories for the commerce storage model. */
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

/** Constructs the full repository facade from storage collections and a db executor. */
export function createMikaRepositories(input: {
  readonly storage: MikaStorageCollections;
  readonly db: MikaDbExecutor;
}): MikaRepositories {
  return new MikaRepositories(input.storage, input.db);
}
