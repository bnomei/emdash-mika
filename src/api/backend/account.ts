/**
 * Account API implementation: aggregated account view, GDPR-style data export request/status/
 * download, account deletion request, and the provider billing-portal session handoff. Also
 * houses order invoice lookup and the DTO-shaping helpers (order summary/subscription/
 * entitlement/download DTOs) the account view and admin order-invoice lookup share.
 */
import type { MikaProviderInvoiceInput } from "../../provider";
import type {
  AccountExportDocument,
  AccountDeleteRequestDocument,
  CustomerDocument,
  EntitlementDocument,
  OrderDocument,
  SubscriptionDocument,
} from "../../types/documents";
import { createMikaId } from "../../types/primitives";
import type { ISODateTime, MikaId } from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import { mikaSafeReturnPath } from "../redirect-policy";
import { mikaPluginRoute } from "../routes";
import type {
  AccountDTO,
  AccountExportDTO,
  AccountExportDownloadDTO,
  DownloadDTO,
  EntitlementDTO,
  MikaApiResult,
  OrderInvoiceDTO,
  OrderInvoiceInput,
  OrderSummaryDTO,
  SubscriptionDTO,
} from "../types";
import { requireProviderFeature } from "./admin-audit";
import {
  apiFailure,
  authRequired,
  emitBackendNotification,
  forbidden,
  observeBackendError,
  orderNotFound,
  providerFailed,
  tokenResult,
} from "./errors";
import type { MikaApiFailure } from "./errors";
import {
  accountExportBelongsToIdentity,
  accountExportSubjectHash,
  customerEmailHash,
  resolveAccountIdentity,
} from "./identity";
import type { MikaBackendDependencies } from "./ports";
import { addMilliseconds } from "./shared";
import {
  accountExportArtifactRef,
  accountExportDownloadTokenError,
  createOrderInvoiceToken,
  createOrderLineDownloadToken,
  hashAccountExportDownloadToken,
  orderInvoiceAccessError,
} from "./tokens";

export async function getAccount(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
): Promise<MikaApiResult<AccountDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account access requires an authenticated customer identity.");
  }

  if (identity.customer) {
    return {
      ok: true,
      status: 200,
      data: await accountDTOForCustomer(input, ctx, identity.customer),
    };
  }

  const orderItems = identity.emailHash
    ? (await input.repositories.ledger.listOrdersByEmailHash(identity.emailHash)).items
    : [];
  const orders = await Promise.all(
    orderItems.map((item) => orderSummaryDTO(input, ctx, item.data)),
  );

  return {
    ok: true,
    status: 200,
    data: {
      orders,
      subscriptions: [],
      entitlements: identity.entitlements.map((item) => entitlementDTO(item.data)),
      downloads: (
        await Promise.all(orderItems.map((item) => orderDownloadDTOs(input, ctx, item.data)))
      ).flat(),
    },
  };
}

export async function requestAccountExport(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
): Promise<MikaApiResult<AccountExportDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account export requires an authenticated customer identity.");
  }

  const now = ctx.now;
  const exportId = input.createId("account_export");
  const token = input.createId("account_export_token");
  const tokenHash = await hashAccountExportDownloadToken(input, token);
  const expiresAt = addMilliseconds(now, input.config?.accountExport?.ttlMs ?? 24 * 60 * 60_000);
  const account = identity.customer
    ? await accountDTOForCustomer(input, ctx, identity.customer, ACCOUNT_EXPORT_LIMIT)
    : {
        orders: [],
        subscriptions: [],
        entitlements: identity.entitlements.map((item) => entitlementDTO(item.data)),
        downloads: [],
      };
  const artifactRef = accountExportArtifactRef(account, now);

  await input.repositories.ephemeral.put({
    key: tokenHash,
    kind: "token",
    subjectHash: accountExportSubjectHash(identity),
    status: "pending",
    count: 0,
    expiresAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
    data: {
      purpose: "account_export_download",
      exportId,
    },
  });

  const identityEmailHash = identity.customer?.emailHash ?? identity.emailHash;
  const record = {
    id: exportId,
    customerId: identity.customer?.customerId,
    userId: identity.customer?.userId ?? identity.userId,
    ...(identityEmailHash ? { emailHash: identityEmailHash } : {}),
    status: "ready" as const,
    requestedAt: now,
    finishedAt: now,
    expiresAt,
    downloadTokenHash: tokenHash,
    artifactRef,
  };

  const document: AccountExportDocument = {
    id: exportId,
    type: "accountExport",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    status: record.status,
    expiresAt,
    record,
    createdAt: now,
    updatedAt: now,
  };

  await input.repositories.ops.put(document);

  const dto = accountExportDTO(document, ctx, token);
  await emitBackendNotification(input, "account.export_ready", now, {
    ...(record.customerId ? { customerId: record.customerId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...((identity.customer?.emailHash ?? identity.emailHash)
      ? { emailHash: identity.customer?.emailHash ?? identity.emailHash }
      : {}),
    exportId,
    expiresAt,
    ...(dto.downloadHref ? { downloadHref: dto.downloadHref } : {}),
    tokenId: token,
  });

  return { ok: true, status: 202, data: dto };
}

export async function accountExportStatus(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  statusInput: { readonly exportId: MikaId },
): Promise<MikaApiResult<AccountExportDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account export status requires an authenticated customer identity.");
  }

  const document = await input.repositories.ops.findAccountExport(statusInput.exportId);
  if (!document || !accountExportBelongsToIdentity(document, identity)) {
    return forbidden("Account export is not available for this identity.");
  }

  return { ok: true, status: 200, data: accountExportDTO(document, ctx) };
}

export async function downloadAccountExport(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  downloadInput: {
    readonly exportId: MikaId;
    readonly token?: string;
    readonly consumeToken?: boolean;
  },
): Promise<MikaApiResult<AccountExportDownloadDTO>> {
  const document = await input.repositories.ops.findAccountExport(downloadInput.exportId);
  if (!document) {
    return tokenResult("TOKEN_INVALID", "Account export download token is invalid.");
  }

  if (downloadInput.token) {
    const tokenHash = await hashAccountExportDownloadToken(input, downloadInput.token.trim());
    if (tokenHash !== document.record.downloadTokenHash) {
      return tokenResult("TOKEN_INVALID", "Account export download token is invalid.");
    }

    const record = await input.repositories.ephemeral.get(tokenHash);
    const tokenError = accountExportDownloadTokenError(record, document.id, ctx.now);
    if (tokenError) return tokenError;

    if (!downloadInput.consumeToken) {
      return accountExportDownloadConfirmationResult(document, ctx.now);
    }

    const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, ctx.now);
    if (!consumed) {
      const current = await input.repositories.ephemeral.get(tokenHash);
      return (
        accountExportDownloadTokenError(current, document.id, ctx.now) ??
        tokenResult("TOKEN_INVALID", "Account export download token is invalid.")
      );
    }

    return accountExportDownloadResult(document, ctx.now);
  }

  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account export download requires an authenticated customer identity.");
  }
  if (!accountExportBelongsToIdentity(document, identity)) {
    return forbidden("Account export download is not available for this identity.");
  }

  return accountExportDownloadResult(document, ctx.now);
}

export async function requestAccountDelete(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
): Promise<MikaApiResult<{ requested: boolean }>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity) {
    return authRequired("Account deletion requires an authenticated customer identity.");
  }
  const block = await accountDeleteBlocked(input, {
    customerId: identity.customer?.customerId,
    sessionId: ctx.sessionId,
  });
  if (block) return block;

  const now = ctx.now;
  const requestId = input.createId("account_delete_request");
  const record = {
    id: requestId,
    customerId: identity.customer?.customerId,
    userId: identity.customer?.userId ?? identity.userId,
    emailHash: identity.customer?.emailHash ?? identity.emailHash,
    status: "queued" as const,
    requestedAt: now,
  };
  const document: AccountDeleteRequestDocument = {
    id: requestId,
    type: "accountDeleteRequest",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    status: record.status,
    record,
    createdAt: now,
    updatedAt: now,
  };

  await input.repositories.ops.put(document);

  await emitBackendNotification(input, "account.delete_requested", now, {
    ...(record.customerId ? { customerId: record.customerId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.emailHash ? { emailHash: record.emailHash } : {}),
    requestId,
  });

  return { ok: true, status: 202, data: { requested: true } };
}

export async function accountDeleteBlocked(
  input: MikaBackendDependencies,
  identity: { readonly customerId?: MikaId; readonly sessionId?: string },
): Promise<MikaApiFailure | null> {
  if (identity.customerId) {
    const subscriptions = await input.repositories.account.listSubscriptionsByCustomer(
      identity.customerId,
      Number.MAX_SAFE_INTEGER,
    );
    const activeSubscription = subscriptions.items.find((item) =>
      subscriptionBlocksAccountDelete(item.data),
    );
    if (activeSubscription) {
      return apiFailure(
        409,
        "CONFLICT",
        "Account deletion is blocked while an active subscription exists. Cancel the subscription in the host application first.",
        { subscriptionId: "Active subscriptions must be cancelled before account deletion." },
      );
    }

    const pendingCarts = await input.repositories.session.listCheckoutPendingCartsByCustomer(
      identity.customerId,
      1,
    );
    if (pendingCarts.items.length > 0) {
      return apiFailure(
        409,
        "CONFLICT",
        "Account deletion is blocked while a checkout is in progress.",
        { cartId: "Complete or cancel the active checkout before account deletion." },
      );
    }
  }

  if (identity.sessionId) {
    const pendingCarts = await input.repositories.session.listCheckoutPendingCartsBySession(
      identity.sessionId,
      1,
    );
    if (pendingCarts.items.length > 0) {
      return apiFailure(
        409,
        "CONFLICT",
        "Account deletion is blocked while a checkout is in progress.",
        { cartId: "Complete or cancel the active checkout before account deletion." },
      );
    }
  }

  return null;
}

export function subscriptionBlocksAccountDelete(subscription: SubscriptionDocument): boolean {
  return subscription.status !== "cancelled" && subscription.status !== "expired";
}

export async function createAccountPortalSession(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  portalInput: { readonly returnTo?: string },
): Promise<MikaApiResult<{ redirectUrl: string }>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity?.customer) {
    return authRequired("Account portal requires an authenticated customer identity.");
  }

  const providerAccount = (
    await input.repositories.account.listProviderAccountsByCustomer(identity.customer.customerId, 1)
  ).items[0]?.data;
  if (!providerAccount) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PROVIDER_UNSUPPORTED",
        message: "No provider account is available for portal sessions.",
      },
    };
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: providerAccount.provider,
    method: "createPortalSession",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support portal sessions.`,
  });
  if (!providerFeature.ok) return providerFeature;

  try {
    const session = await providerFeature.method.call(providerFeature.provider, {
      providerCustomerId: providerAccount.providerCustomerId,
      returnUrl: accountPortalReturnUrl(ctx, portalInput.returnTo),
    });

    return {
      ok: true,
      status: 200,
      data: { redirectUrl: session.redirectUrl },
    };
  } catch (error) {
    // Customer-facing path: the raw provider error goes to the host observer, never onto the wire.
    observeBackendError(input, "account.portalSession", error, {
      provider: providerAccount.provider,
    });
    return providerFailed("Provider portal session failed.");
  }
}

export async function getOrderInvoice(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  invoiceInput: OrderInvoiceInput,
): Promise<MikaApiResult<OrderInvoiceDTO>> {
  const order = await input.repositories.ledger.findOrderById(invoiceInput.orderId);
  if (!order) return orderNotFound(invoiceInput.orderId);

  const accessError = await orderInvoiceAccessError(input, ctx, order, invoiceInput.token);
  if (accessError) return accessError;

  if (order.aggregate.invoiceUrl) {
    return {
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        href: order.aggregate.invoiceUrl,
      },
    };
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: order.provider,
    method: "getInvoiceUrl",
    capability: "invoice_url",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support invoice URLs.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const providerInput: MikaProviderInvoiceInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
  };

  try {
    const invoice = await providerFeature.method.call(providerFeature.provider, providerInput);

    return {
      ok: true,
      status: 200,
      data: {
        ...invoice,
        orderId: order.id,
      },
    };
  } catch {
    return providerFailed("Provider invoice lookup failed.");
  }
}

const ACCOUNT_EXPORT_LIMIT = Number.MAX_SAFE_INTEGER;

export async function accountDTOForCustomer(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  customer: CustomerDocument,
  limit?: number,
): Promise<AccountDTO> {
  const emailHash = customerEmailHash(customer);
  const [
    customerOrders,
    emailHashOrders,
    subscriptions,
    customerEntitlements,
    emailHashEntitlements,
  ] = await Promise.all([
    input.repositories.ledger.listOrdersByCustomer(customer.customerId, limit),
    emailHash
      ? input.repositories.ledger.listOrdersByEmailHash(emailHash, limit)
      : Promise.resolve({ items: [], nextCursor: undefined }),
    input.repositories.account.listSubscriptionsByCustomer(customer.customerId, limit),
    input.repositories.account.listEntitlementsByCustomer(customer.customerId, limit),
    emailHash
      ? input.repositories.account.listEntitlementsByEmailHash(emailHash, limit)
      : Promise.resolve({ items: [], nextCursor: undefined }),
  ]);

  const orders = uniqueDocumentsById([...customerOrders.items, ...emailHashOrders.items]);
  const entitlements = uniqueDocumentsById([
    ...customerEntitlements.items,
    ...emailHashEntitlements.items,
  ]);
  const orderSummaries = await Promise.all(
    orders.map((item) => orderSummaryDTO(input, ctx, item.data)),
  );

  return {
    customer: {
      id: customer.customerId,
      userId: customer.userId,
      email: customer.aggregate.email,
      name: customer.aggregate.name,
    },
    orders: orderSummaries,
    subscriptions: subscriptions.items.map((item) => subscriptionDTO(item.data)),
    entitlements: entitlements.map((item) => entitlementDTO(item.data)),
    downloads: (
      await Promise.all(orders.map((item) => orderDownloadDTOs(input, ctx, item.data)))
    ).flat(),
  };
}

export function uniqueDocumentsById<TDocument extends { readonly id: string }>(
  items: readonly {
    readonly id: string;
    readonly data: TDocument;
  }[],
): readonly {
  readonly id: string;
  readonly data: TDocument;
}[] {
  const seen = new Set<string>();
  const unique: {
    readonly id: string;
    readonly data: TDocument;
  }[] = [];

  for (const item of items) {
    if (seen.has(item.data.id)) continue;
    seen.add(item.data.id);
    unique.push(item);
  }

  return unique;
}

export async function orderSummaryDTO(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<OrderSummaryDTO> {
  const invoiceToken = await createOrderInvoiceToken(input, ctx, order);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.aggregate.totals.total,
    createdAt: order.createdAt,
    invoiceHref: mikaPluginRoute("orderInvoice", {
      origin: ctx.url,
      search: { orderId: order.id, token: invoiceToken },
    }),
  };
}

export function subscriptionDTO(subscription: SubscriptionDocument): SubscriptionDTO {
  return {
    id: subscription.id,
    title: subscription.aggregate.sellable.titleSnapshot,
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.aggregate.cancelAtPeriodEnd,
  };
}

export function entitlementDTO(entitlement: EntitlementDocument): EntitlementDTO {
  return {
    key: entitlement.entitlementKey,
    status: entitlement.status,
    source: entitlement.orderId ? "order" : entitlement.subscriptionId ? "subscription" : "manual",
    expiresAt: entitlement.record.currentPeriodEnd,
  };
}

export async function orderDownloadDTOs(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<readonly DownloadDTO[]> {
  const downloads: DownloadDTO[] = [];
  for (const line of order.aggregate.lines) {
    for (const downloadRef of line.downloadRefs ?? []) {
      const { token, expiresAt } = await createOrderLineDownloadToken(
        input,
        ctx,
        order,
        line,
        downloadRef,
      );
      downloads.push({
        id: createMikaId(downloadRef),
        title: line.item.titleSnapshot,
        href: `/download/${token}`,
        expiresAt,
      });
    }
  }
  return downloads;
}

export function accountExportDTO(
  document: AccountExportDocument,
  ctx: MikaRequestContext,
  token?: string,
): AccountExportDTO {
  const expired = document.expiresAt <= ctx.now;
  const status = expired && document.status !== "failed" ? "expired" : document.status;

  return {
    id: document.id,
    status,
    requestedAt: document.record.requestedAt,
    expiresAt: document.expiresAt,
    ...(status === "ready"
      ? {
          downloadHref: mikaPluginRoute("accountExportDownload", {
            origin: ctx.url?.origin,
            search: {
              exportId: document.id,
              token,
            },
          }),
        }
      : {}),
  };
}

export function accountExportDownloadResult(
  document: AccountExportDocument,
  now: ISODateTime,
): MikaApiResult<AccountExportDownloadDTO> {
  if (document.expiresAt <= now || document.status === "expired") {
    return tokenResult("TOKEN_EXPIRED", "Account export download token has expired.");
  }
  if (document.status !== "ready") {
    return tokenResult("TOKEN_INVALID", "Account export download is not ready.");
  }

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      href: document.record.artifactRef,
      expiresAt: document.expiresAt,
    },
  };
}

export function accountExportDownloadConfirmationResult(
  document: AccountExportDocument,
  now: ISODateTime,
): MikaApiResult<AccountExportDownloadDTO> {
  const ready = accountExportDownloadResult(document, now);
  if (!ready.ok) return ready;

  return {
    ok: true,
    status: 200,
    data: {
      id: document.id,
      expiresAt: document.expiresAt,
      requiresConfirmation: true,
      confirmMethod: "POST",
    },
  };
}

export function accountPortalReturnUrl(ctx: MikaRequestContext, returnTo?: string): string {
  if (!returnTo) return ctx.url?.href ?? "/";
  if (!ctx.url) return safeRequestReturnPath(ctx, returnTo);

  return new URL(safeRequestReturnPath(ctx, returnTo), ctx.url.origin).toString();
}

export function safeRequestReturnPath(
  ctx: MikaRequestContext,
  candidate?: string,
  fallback = ctx.url ? `${ctx.url.pathname}${ctx.url.search}${ctx.url.hash}` : "/",
): string {
  return mikaSafeReturnPath(candidate ?? fallback, {
    origin: ctx.url,
    fallback,
  });
}
