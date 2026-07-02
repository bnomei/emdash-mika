/**
 * Order fulfillment: granting/revoking entitlements and licenses, resolving and consuming
 * download tokens, completing the checkout/cart side of a paid order, queuing order-confirmation
 * email, and the once-only notification-marker plumbing that backs every fulfillment
 * notification (license issued, download ready, order confirmed).
 */
import { renderMikaEmail } from "../../email";
import { nextCartVersion } from "../../storage/repositories";
import { createMikaId } from "../../types/primitives";
import type { ISODateTime, JsonObject, MikaId } from "../../types/primitives";
import type {
  CheckoutDocument,
  EmailDocument,
  EntitlementDocument,
  LicenseDocument,
  OrderDocument,
  WorkflowDocument,
} from "../../types/documents";
import type { OrderLine } from "../../types/aggregates";
import type { MikaProviderPaymentEvent } from "../../provider";
import type { MikaRequestContext } from "../context";
import { applyOrderCancel, applyOrderRefund } from "../lifecycle";
import {
  emitMikaNotification,
  type MikaNotificationContextMap,
  type MikaNotificationIntent,
  type MikaNotificationKind,
  type MikaOrderConfirmedNotificationContext,
} from "../notifications";
import type {
  DownloadIssueInput,
  DownloadResolutionDTO,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  OrderCancelInput,
  OrderRefundInput,
} from "../types";
import { downloadTokenError, hashDownloadToken } from "./tokens";
import {
  emitBackendNotification,
  observeBackendError,
  orderNotificationRecipient,
  tokenResult,
} from "./errors";
import type { MikaApiResult } from "../types";
import { orderAccessRevokedForAccountDelete, orderAllowsDownload } from "./identity";
import { addMilliseconds, currentBackendISODateTime, metadataMikaId, stringChild } from "./shared";
import { createMikaStockLifecycleService } from "./stock-lifecycle";
import { WorkflowRunner } from "./workflow-runner";
import type { CreateMikaBackendApiInput } from "./ports";

export async function revokeOrderFulfillmentAccess(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  now: ISODateTime,
  revokeReason: "order_refunded" | "order_cancelled" = "order_refunded",
): Promise<void> {
  for (const line of order.aggregate.lines) {
    switch (line.item.fulfillmentKind) {
      case "entitlement": {
        const entitlement = await input.repositories.account.findEntitlementById(
          fulfillmentDocumentId("entitlement", order.id, line.id),
        );
        if (entitlement && entitlement.status === "active") {
          await input.repositories.account.put({
            ...entitlement,
            status: "revoked",
            updatedAt: now,
            record: {
              ...entitlement.record,
              status: "revoked",
              revokedAt: now,
              metadata: {
                ...entitlement.record.metadata,
                revokeReason,
              },
            },
          });
        }
        break;
      }
      case "license": {
        const license = await input.repositories.account.findLicenseById(
          fulfillmentDocumentId("license", order.id, line.id),
        );
        if (license && license.status === "active") {
          await input.repositories.account.put({
            ...license,
            status: "revoked",
            updatedAt: now,
            record: {
              ...license.record,
              status: "revoked",
              revokedAt: now,
              metadata: {
                ...license.record.metadata,
                revokeReason,
              },
            },
          });
        }
        break;
      }
    }
  }
}

export function createManualEntitlementDocument(
  entitlementId: MikaId,
  grantInput: EntitlementGrantInput,
  now: ISODateTime,
  emailHash?: string,
): EntitlementDocument {
  const record = {
    id: entitlementId,
    ...(grantInput.customerId ? { customerId: grantInput.customerId } : {}),
    ...(grantInput.userId ? { userId: grantInput.userId } : {}),
    ...(emailHash ? { emailHash } : {}),
    entitlementKey: grantInput.entitlementKey,
    status: "active" as const,
    ...(grantInput.expiresAt ? { currentPeriodEnd: grantInput.expiresAt } : {}),
    grantedAt: now,
    metadata: {
      source: "admin",
    },
  };

  return {
    id: entitlementId,
    type: "entitlement",
    schemaVersion: 1,
    ...(record.customerId ? { customerId: record.customerId } : {}),
    ...(record.userId ? { userId: record.userId } : {}),
    ...(record.emailHash ? { emailHash: record.emailHash } : {}),
    entitlementKey: record.entitlementKey,
    status: record.status,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

export async function findEntitlementsForRevoke(
  input: CreateMikaBackendApiInput,
  revokeInput: EntitlementRevokeInput,
): Promise<readonly EntitlementDocument[]> {
  if (revokeInput.entitlementId) {
    const entitlement = await input.repositories.account.findEntitlementById(
      revokeInput.entitlementId,
    );
    return entitlement ? [entitlement] : [];
  }

  if (!revokeInput.customerId || !revokeInput.entitlementKey) return [];

  const entitlements = await input.repositories.account.listEntitlementsByCustomer(
    revokeInput.customerId,
  );
  return entitlements.items.flatMap((item) =>
    item.data.entitlementKey === revokeInput.entitlementKey && item.data.status === "active"
      ? [item.data]
      : [],
  );
}

export async function resolveDownloadIssueTarget(
  input: CreateMikaBackendApiInput,
  issueInput: DownloadIssueInput,
): Promise<{
  readonly order: OrderDocument;
  readonly line: OrderLine;
  readonly downloadRef: string;
  readonly license?: LicenseDocument;
} | null> {
  const entitlement = issueInput.entitlementId
    ? await input.repositories.account.findEntitlementById(issueInput.entitlementId)
    : null;
  if (issueInput.entitlementId && (!entitlement || entitlement.status !== "active")) return null;

  const orderId = issueInput.orderId ?? entitlement?.orderId;
  if (!orderId) return null;

  const order = await input.repositories.ledger.findOrderById(orderId);
  if (!order) return null;

  const line =
    order.aggregate.lines.find((candidate) => candidate.id === issueInput.orderLineId) ??
    order.aggregate.lines.find(
      (candidate) => candidate.entitlementId === issueInput.entitlementId,
    ) ??
    order.aggregate.lines[0];
  if (!line || (issueInput.orderLineId && line.id !== issueInput.orderLineId)) return null;

  const downloadRef = line.downloadRefs?.[0] ?? orderLineDownloadRef(order, line);
  const license = await findLicenseForDownload(input, order, line, issueInput.entitlementId);

  return { order, line, downloadRef, ...(license ? { license } : {}) };
}

export async function findLicenseForDownload(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  line: OrderLine,
  entitlementId?: MikaId,
): Promise<LicenseDocument | null> {
  if (!order.customerId) return null;

  const licenses = await input.repositories.account.listLicensesByCustomer(order.customerId);
  return (
    licenses.items.find(
      (item) =>
        item.data.status === "active" &&
        item.data.orderId === order.id &&
        item.data.orderLineId === line.id &&
        (!entitlementId || item.data.entitlementId === entitlementId),
    )?.data ?? null
  );
}

export function addDownloadRefToOrder(
  order: OrderDocument,
  orderLineId: MikaId,
  downloadRef: string,
  now: ISODateTime,
): OrderDocument {
  return {
    ...order,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      lines: order.aggregate.lines.map((line) =>
        line.id === orderLineId
          ? { ...line, downloadRefs: [...(line.downloadRefs ?? []), downloadRef] }
          : line,
      ),
      metadata: {
        ...order.aggregate.metadata,
        lastAdminAction: "download.issue",
      },
    },
  };
}

export async function resolveDownload(
  input: CreateMikaBackendApiInput,
  downloadInput: { readonly token: string },
  consumeToken: boolean,
): Promise<MikaApiResult<DownloadResolutionDTO>> {
  const now = currentBackendISODateTime(input);
  const tokenHash = await hashDownloadToken(input, downloadInput.token.trim());
  const record = await input.repositories.ephemeral.get(tokenHash);
  const tokenError = downloadTokenError(record, now);
  if (tokenError) return tokenError;

  const data = record?.data ?? {};
  const downloadRef = stringChild(data, "downloadRef");
  if (!downloadRef) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }

  // createOrderLineDownloadToken always stamps the order id it minted the token for onto the
  // token record, so the common case resolves via a direct indexed lookup instead of scanning
  // every order for a matching downloadRef. Only a token missing that field (predating it, or
  // host-authored without it) falls back to the full-ledger scan.
  const tokenOrderId = stringChild(data, "orderId");
  const order = tokenOrderId
    ? await input.repositories.ledger.findOrderById(createMikaId(tokenOrderId))
    : await input.repositories.ledger.findOrderByDownloadRef(downloadRef);
  const line = order?.aggregate.lines.find((candidate) =>
    candidate.downloadRefs?.includes(downloadRef),
  );
  if (!order || !line || !orderAllowsDownload(order)) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }
  if (orderAccessRevokedForAccountDelete(order)) {
    return tokenResult("DOWNLOAD_REVOKED", "Download access has been revoked.");
  }

  const orderLineId = stringChild(data, "orderLineId");
  if (orderLineId && line.id !== orderLineId) {
    return tokenResult("TOKEN_INVALID", "Download token is invalid.");
  }

  const entitlementId = stringChild(data, "entitlementId");
  if (entitlementId) {
    const entitlement = await input.repositories.account.findEntitlementById(
      createMikaId(entitlementId),
    );
    if (
      !entitlement ||
      entitlement.status !== "active" ||
      (entitlement.record.currentPeriodEnd !== undefined &&
        entitlement.record.currentPeriodEnd <= now) ||
      (entitlement.orderId && entitlement.orderId !== order.id)
    ) {
      return tokenResult("DOWNLOAD_REVOKED", "Download access has been revoked.");
    }
  }

  const licenseId = stringChild(data, "licenseId");
  if (licenseId) {
    const license = await input.repositories.account.findLicenseById(createMikaId(licenseId));
    if (
      !license ||
      license.status !== "active" ||
      license.record.orderId !== order.id ||
      license.record.orderLineId !== line.id
    ) {
      return tokenResult("DOWNLOAD_REVOKED", "Download access has been revoked.");
    }
  }

  if (consumeToken) {
    const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, now);
    if (!consumed) {
      const current = await input.repositories.ephemeral.get(tokenHash);
      return (
        downloadTokenError(current, now) ??
        tokenResult("TOKEN_INVALID", "Download token is invalid.")
      );
    }
  }

  return {
    ok: true,
    status: 200,
    data: {
      title: stringChild(data, "title") ?? line.item.titleSnapshot,
      redirectUrl: stringChild(data, "redirectUrl") ?? downloadRef,
      expiresAt: record?.expiresAt,
    },
  };
}

/** The named steps a payment webhook workflow runs through, in order. */
export type PaymentWebhookWorkflowStep =
  | "link_checkout"
  | "persist_order"
  | "complete_checkout"
  | "fulfill_order"
  | "mark_webhook";

export type RunPaymentWebhookWorkflowStep = <TResult>(
  name: PaymentWebhookWorkflowStep,
  fn: () => Promise<TResult>,
) => Promise<TResult>;

export async function fulfillCheckoutPaymentOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  runWorkflowStep: RunPaymentWebhookWorkflowStep,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  checkout?: CheckoutDocument,
): Promise<OrderDocument> {
  await runWorkflowStep("complete_checkout", () =>
    completeCheckoutForPaymentOrder(input, ctx, order, event, checkout),
  );

  return runWorkflowStep("fulfill_order", () => fulfillPaidOrder(input, ctx, order));
}

export async function completeCheckoutForPaymentOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  knownCheckout?: CheckoutDocument,
): Promise<void> {
  const checkout = knownCheckout ?? (await findOrderCheckout(input, order, event));
  if (!checkout) return;

  const completedCheckout: CheckoutDocument = {
    ...checkout,
    status: "completed",
    providerStatus: "completed",
    orderId: order.id,
    updatedAt: ctx.now,
    aggregate: {
      ...checkout.aggregate,
      metadata: completedCheckoutMetadata(checkout.aggregate.metadata, order, event),
    },
  };
  await input.repositories.session.put(completedCheckout);

  if (!checkout.cartId) return;

  const document = await input.repositories.session.findById(checkout.cartId);
  if (!document || document.type !== "cart") return;
  if (
    document.status !== "checkout_pending" ||
    metadataMikaId(document.aggregate.metadata, "checkoutSessionId") !== checkout.id
  ) {
    return;
  }

  await input.repositories.session.put({
    ...document,
    status: "converted",
    version: nextCartVersion(document.version),
    updatedAt: ctx.now,
    aggregate: {
      ...document.aggregate,
      metadata: {
        ...document.aggregate.metadata,
        checkoutSessionId: checkout.id,
        checkoutOrderId: order.id,
      },
    },
  });
}

export async function findOrderCheckout(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): Promise<CheckoutDocument | null> {
  if (order.checkoutSessionId) {
    const checkout = await input.repositories.session.findCheckoutById(order.checkoutSessionId);
    if (checkout) return checkout;
  }

  const providerCheckoutId = event.providerCheckoutId ?? order.providerCheckoutId;
  if (!providerCheckoutId) return null;

  return input.repositories.session.findCheckoutByProvider(event.provider, providerCheckoutId);
}

export function completedCheckoutMetadata(
  metadata: JsonObject | undefined,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): JsonObject {
  return {
    ...metadata,
    checkoutProviderStatus: "completed",
    checkoutOrderId: order.id,
    ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
    ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
  };
}

export async function fulfillPaidOrder(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
): Promise<OrderDocument> {
  const fulfilledLines: OrderLine[] = [];
  const originalLines = order.aggregate.lines;
  let changed = false;

  try {
    for (const line of originalLines) {
      const fulfilled = await fulfillPaidOrderLine(input, ctx, order, line);
      fulfilledLines.push(fulfilled);
      const lineChanged = fulfilled !== line;
      changed = changed || lineChanged;
      if (lineChanged) {
        const progressedLines = [...fulfilledLines, ...originalLines.slice(fulfilledLines.length)];
        await input.repositories.ledger.put(
          orderWithFulfilledLines(order, progressedLines, ctx.now),
        );
      }
    }
  } catch (error) {
    if (changed) {
      const progressedLines = [...fulfilledLines, ...originalLines.slice(fulfilledLines.length)];
      await input.repositories.ledger
        .put(orderWithFulfilledLines(order, progressedLines, ctx.now))
        .catch((persistError: unknown) =>
          observeBackendError(input, "fulfillment.persistProgress", persistError, {
            orderId: order.id,
          }),
        );
    }
    throw error;
  }

  const orderAlreadyMarkedFulfilled = typeof order.aggregate.metadata?.["fulfilledAt"] === "string";

  if (!changed && orderAlreadyMarkedFulfilled) {
    await queueOrderConfirmationEmail(input, ctx, order, fulfilledLines);
    await emitOrderDownloadReadyNotifications(input, ctx, order, originalLines, {
      includeExistingRefs: true,
    });
    return order;
  }

  const fulfilledOrder = orderWithFulfilledLines(
    order,
    fulfilledLines,
    ctx.now,
    orderAlreadyMarkedFulfilled ? undefined : ctx.now,
  );

  await input.repositories.ledger.put(fulfilledOrder);
  await queueOrderConfirmationEmail(input, ctx, fulfilledOrder, fulfilledLines);
  await emitOrderDownloadReadyNotifications(input, ctx, fulfilledOrder, originalLines, {
    includeExistingRefs: !orderAlreadyMarkedFulfilled,
  });

  return fulfilledOrder;
}

export function orderWithFulfilledLines(
  order: OrderDocument,
  lines: readonly OrderLine[],
  now: ISODateTime,
  fulfilledAt?: ISODateTime,
): OrderDocument {
  return {
    ...order,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      lines,
      metadata: {
        ...order.aggregate.metadata,
        ...(fulfilledAt ? { fulfilledAt } : {}),
      },
    },
  };
}

export async function fulfillPaidOrderLine(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  line: OrderLine,
): Promise<OrderLine> {
  const stockMovementId = await consumeOrderLineReservation(input, ctx, order, line);
  let fulfilledLine: OrderLine =
    stockMovementId && line.stockMovementId !== stockMovementId
      ? { ...line, stockMovementId }
      : line;

  switch (line.item.fulfillmentKind) {
    case "none":
    case "external":
      return fulfilledLine;
    case "entitlement": {
      const entitlement = createOrderLineEntitlementDocument(order, line, ctx.now);
      const existing = await input.repositories.account.findEntitlementById(entitlement.id);
      if (!existing) await input.repositories.account.put(entitlement);
      return fulfilledLine.entitlementId === entitlement.id
        ? fulfilledLine
        : { ...fulfilledLine, entitlementId: entitlement.id };
    }
    case "download": {
      const downloadRef = orderLineDownloadRef(order, line);
      return fulfilledLine.downloadRefs?.includes(downloadRef)
        ? fulfilledLine
        : { ...fulfilledLine, downloadRefs: [...(fulfilledLine.downloadRefs ?? []), downloadRef] };
    }
    case "license": {
      const license = await createOrderLineLicenseDocument(input, order, line, ctx.now);
      const existing = await input.repositories.account.findLicenseById(license.id);
      if (!existing) await input.repositories.account.put(license);
      await emitFulfillmentNotificationOnce(
        input,
        ctx,
        {
          id: fulfillmentDocumentId("workflow", order.id, line.id, "notification_license_issued"),
          kind: "license.issued",
          subjectType: "orderLine",
          subjectId: line.id,
          idempotencyKey: `license.issued:${order.id}:${line.id}`,
        },
        {
          ...orderNotificationRecipient(order),
          ...(license.customerId ? { customerId: license.customerId } : {}),
          licenseId: license.id,
          orderId: order.id,
          orderLineId: line.id,
          ...(license.record.entitlementId ? { entitlementId: license.record.entitlementId } : {}),
          displayKeySuffix: license.record.displayKeySuffix,
          sellableId: line.item.sellableId,
          fulfillmentKind: line.item.fulfillmentKind,
        },
      );
      return fulfilledLine.licenseKeySuffix === license.record.displayKeySuffix
        ? fulfilledLine
        : { ...fulfilledLine, licenseKeySuffix: license.record.displayKeySuffix };
    }
  }
}

export async function consumeOrderLineReservation(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  line: OrderLine,
): Promise<MikaId | undefined> {
  const reservationId = metadataMikaId(line.metadata, "reservationId");
  if (!reservationId) return line.stockMovementId;
  if (line.stockMovementId === reservationId) return line.stockMovementId;

  const result = await createMikaStockLifecycleService(input).consume({
    reservationEventId: reservationId,
    now: ctx.now,
    orderId: order.id,
    orderLineId: line.id,
  });

  if (result.status === "consumed") return result.event.id;
  if (result.status === "not_active" && result.event.status === "consumed") return result.event.id;

  throw new Error(`Reservation '${reservationId}' for order line '${line.id}' was not active.`);
}

export function createOrderLineEntitlementDocument(
  order: OrderDocument,
  line: OrderLine,
  now: ISODateTime,
): EntitlementDocument {
  const id = fulfillmentDocumentId("entitlement", order.id, line.id);
  const entitlementKey = line.item.entitlementKey ?? orderLineContentKey(line);
  const record = {
    id,
    customerId: order.customerId ?? order.aggregate.customer.customerId,
    userId: order.aggregate.customer.userId,
    emailHash: order.aggregate.customer.emailHash,
    entitlementKey,
    contentCollection: line.item.content.collection,
    contentId: line.item.content.id,
    sellableId: line.item.sellableId,
    orderId: order.id,
    status: "active" as const,
    sourceStatus: order.status,
    grantedAt: now,
    metadata: {
      orderLineId: line.id,
      fulfillmentKind: line.item.fulfillmentKind,
    },
  };

  return {
    id,
    type: "entitlement",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    entitlementKey: record.entitlementKey,
    status: record.status,
    orderId: record.orderId,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createOrderLineLicenseDocument(
  input: CreateMikaBackendApiInput,
  order: OrderDocument,
  line: OrderLine,
  now: ISODateTime,
): Promise<LicenseDocument> {
  const id = fulfillmentDocumentId("license", order.id, line.id);
  const licenseKeyHash = await input.hash(`license:${order.id}:${line.id}`);
  const displayKeySuffix = licenseKeyHash
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-6)
    .toUpperCase();
  const record = {
    id,
    orderId: order.id,
    orderLineId: line.id,
    entitlementId: line.entitlementId,
    licenseKeyHash,
    displayKeySuffix,
    status: "active" as const,
    createdAt: now,
    metadata: {
      fulfillmentKind: line.item.fulfillmentKind,
      sellableId: line.item.sellableId,
    },
  };

  return {
    id,
    type: "license",
    schemaVersion: 1,
    orderId: record.orderId,
    orderLineId: record.orderLineId,
    entitlementId: record.entitlementId,
    status: record.status,
    customerId: order.customerId ?? order.aggregate.customer.customerId,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

export async function queueOrderConfirmationEmail(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  lines: readonly OrderLine[],
): Promise<void> {
  const recipient = orderNotificationRecipient(order);
  const toEmail = recipient.toEmail?.trim();
  if (!toEmail) return;

  const notificationMarkerId = orderConfirmedNotificationMarkerId(order.id);
  const defaultEmailId = fulfillmentDocumentId("email", order.id, "order_confirmation");
  const markerLease = await acquireNotificationMarker(input, ctx, {
    id: notificationMarkerId,
    kind: "order.confirmed",
    subjectType: "order",
    subjectId: order.id,
    idempotencyKey: `order.confirmed:${order.id}`,
    metadata: {
      defaultEmailId,
    },
  });
  if (markerLease.status !== "acquired") return;

  try {
    const existingDefaultEmail = await input.repositories.ops.findEmail(defaultEmailId);
    if (existingDefaultEmail) {
      await markerLease.runner.complete({
        notificationKind: "order.confirmed",
        defaultEmailId,
        defaultEmailAlreadyQueued: true,
      });
      return;
    }

    const fulfillmentKinds = [...new Set(lines.map((line) => line.item.fulfillmentKind))];
    const context: MikaOrderConfirmedNotificationContext = {
      ...recipient,
      toEmail,
      orderId: order.id,
      orderNumber: order.orderNumber,
      ...(order.provider ? { provider: order.provider } : {}),
      ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
      ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
      ...(order.checkoutSessionId ? { checkoutSessionId: order.checkoutSessionId } : {}),
      subtotal: order.aggregate.totals.subtotal,
      ...(order.aggregate.totals.discount ? { discount: order.aggregate.totals.discount } : {}),
      total: order.aggregate.totals.total,
      fulfilledLines: lines.map((line) => ({
        lineId: line.id,
        sellableId: line.item.sellableId,
        ...(line.item.priceId ? { priceId: line.item.priceId } : {}),
        ...(line.item.sku ? { sku: line.item.sku } : {}),
        title: line.item.titleSnapshot,
        quantity: line.quantity,
        total: { amount: line.totalAmount, currency: line.item.currency },
        fulfillmentKind: line.item.fulfillmentKind,
        ...(line.entitlementId ? { entitlementId: line.entitlementId } : {}),
        ...(line.downloadRefs ? { downloadRefs: line.downloadRefs } : {}),
        ...(line.licenseKeySuffix ? { licenseKeySuffix: line.licenseKeySuffix } : {}),
        ...(line.stockMovementId ? { stockMovementId: line.stockMovementId } : {}),
        ...(line.metadata ? { metadata: line.metadata } : {}),
      })),
      fulfillmentKinds,
    };
    const intent: MikaNotificationIntent<"order.confirmed"> = {
      kind: "order.confirmed",
      occurredAt: ctx.now,
      context,
    };

    await emitMikaNotification(
      input.notifications?.handle,
      intent,
      () => queueDefaultOrderConfirmedEmail(input, intent, defaultEmailId),
      (error) => observeBackendError(input, "notification.hook.order.confirmed", error),
    );
    await markerLease.runner.complete({
      notificationKind: "order.confirmed",
      defaultEmailId,
    });
  } catch (error) {
    await markerLease.runner.fail(
      error instanceof Error ? error.message : "Order-confirmation notification failed.",
    );
    throw error;
  }
}

export async function queueDefaultOrderConfirmedEmail(
  input: CreateMikaBackendApiInput,
  intent: MikaNotificationIntent<"order.confirmed">,
  emailId?: MikaId,
): Promise<void> {
  const { context } = intent;
  const id = emailId ?? fulfillmentDocumentId("email", context.orderId, "order_confirmation");
  const existing = await input.repositories.ops.findEmail(id);
  if (existing) return;

  const rendered = renderMikaEmail("order_confirmation", {
    toEmail: context.toEmail,
    orderNumber: context.orderNumber,
    subtotal: context.subtotal,
    ...(context.discount ? { discount: context.discount } : {}),
    total: context.total,
    lines: context.fulfilledLines.map((line) => ({
      title: line.title,
      quantity: line.quantity,
      total: line.total,
    })),
  });
  const record = {
    id,
    customerId: context.customerId,
    orderId: context.orderId,
    kind: "order_confirmation" as const,
    toEmail: context.toEmail,
    subject: rendered.subject,
    status: "queued" as const,
    idempotencyKey: `order-confirmation:${context.orderId}`,
    templateKey: rendered.template,
    templateVersion: "1",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: intent.occurredAt,
    createdAt: intent.occurredAt,
    metadata: {
      orderLineIds: context.fulfilledLines.map((line) => line.lineId),
      fulfillmentKinds: [...context.fulfillmentKinds],
      ...(context.emailHash ? { emailHash: context.emailHash } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
    },
  };
  const document: EmailDocument = {
    id,
    type: "email",
    schemaVersion: 1,
    status: record.status,
    nextAttemptAt: record.nextAttemptAt,
    orderId: record.orderId,
    kind: record.kind,
    record,
    createdAt: intent.occurredAt,
    updatedAt: intent.occurredAt,
  };

  await input.repositories.ops.put(document);
}

export async function emitOrderDownloadReadyNotifications(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  originalLines: readonly OrderLine[],
  options: { readonly includeExistingRefs?: boolean } = {},
): Promise<void> {
  const originalById = new Map(originalLines.map((line) => [line.id, line]));

  for (const line of order.aggregate.lines) {
    const originalRefs = new Set(originalById.get(line.id)?.downloadRefs ?? []);
    const addedRefs = options.includeExistingRefs
      ? (line.downloadRefs ?? [])
      : (line.downloadRefs ?? []).filter((downloadRef) => !originalRefs.has(downloadRef));

    for (const downloadRef of addedRefs) {
      await emitFulfillmentNotificationOnce(
        input,
        ctx,
        {
          id: fulfillmentDocumentId("workflow", downloadRef, "notification_download_ready"),
          kind: "download.ready",
          subjectType: "orderDownload",
          subjectId: createMikaId(downloadRef),
          idempotencyKey: `download.ready:${downloadRef}`,
        },
        {
          ...orderNotificationRecipient(order),
          downloadRef,
          orderId: order.id,
          orderLineId: line.id,
          title: line.item.titleSnapshot,
        },
      );
    }
  }
}

export function orderLineDownloadRef(order: OrderDocument, line: OrderLine): string {
  return `download:${order.id}:${line.id}`;
}

export function orderConfirmedNotificationMarkerId(orderId: MikaId): MikaId {
  return fulfillmentDocumentId("workflow", orderId, "notification_order_confirmed");
}

export type NotificationMarkerLease =
  | {
      readonly status: "acquired";
      readonly runner: WorkflowRunner<never>;
    }
  | {
      readonly status: "active" | "completed";
    };

export async function acquireNotificationMarker(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  marker: {
    readonly id: MikaId;
    readonly kind: MikaNotificationKind;
    readonly subjectType: string;
    readonly subjectId: MikaId;
    readonly idempotencyKey: string;
    readonly metadata?: JsonObject;
  },
): Promise<NotificationMarkerLease> {
  const existing = await input.repositories.ops.findWorkflow(marker.id);
  if (existing?.status === "completed") return { status: "completed" };

  const workflowKind = `notification.${marker.kind}` as WorkflowDocument["kind"];
  if (!existing) {
    await input.repositories.ops.createWorkflow({
      id: marker.id,
      type: "workflow",
      schemaVersion: 1,
      kind: workflowKind,
      status: "queued",
      subjectType: marker.subjectType,
      subjectId: marker.subjectId,
      idempotencyKey: marker.idempotencyKey,
      nextAttemptAt: ctx.now,
      record: {
        id: marker.id,
        kind: workflowKind,
        status: "queued",
        subjectType: marker.subjectType,
        subjectId: marker.subjectId,
        idempotencyKey: marker.idempotencyKey,
        attemptCount: 0,
        maxAttempts: 5,
        nextAttemptAt: ctx.now,
        steps: [],
        createdAt: ctx.now,
        updatedAt: ctx.now,
        metadata: {
          notificationKind: marker.kind,
          ...marker.metadata,
        },
      },
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  }

  const leased = await input.repositories.ops.tryLeaseWorkflow({
    workflowId: marker.id,
    leaseKey: `notification:${marker.id}:${ctx.now}`,
    now: ctx.now,
    leaseExpiresAt: addMilliseconds(ctx.now, 300_000),
  });
  if (!leased) return { status: "active" };

  return {
    status: "acquired",
    runner: new WorkflowRunner<never>({
      ops: input.repositories.ops,
      workflow: leased,
      now: () => ctx.now,
      nextAttemptAt: (now) => now,
      stepFailureMessage: "Notification hook failed.",
    }),
  };
}

export async function emitFulfillmentNotificationOnce<TKind extends MikaNotificationKind>(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  marker: {
    readonly id: MikaId;
    readonly kind: TKind;
    readonly subjectType: string;
    readonly subjectId: MikaId;
    readonly idempotencyKey: string;
  },
  context: MikaNotificationContextMap[TKind],
): Promise<void> {
  const lease = await acquireNotificationMarker(input, ctx, {
    id: marker.id,
    kind: marker.kind,
    subjectType: marker.subjectType,
    subjectId: marker.subjectId,
    idempotencyKey: marker.idempotencyKey,
  });
  if (lease.status !== "acquired") return;

  try {
    await emitBackendNotification(input, marker.kind, ctx.now, context);
    await lease.runner.complete({
      notificationKind: marker.kind,
      idempotencyKey: marker.idempotencyKey,
    });
  } catch (error) {
    await lease.runner.fail(
      error instanceof Error ? error.message : "Fulfillment notification hook failed.",
    );
    throw error;
  }
}

export function orderLineContentKey(line: OrderLine): string {
  return `${line.item.content.collection}:${line.item.content.id}`;
}

export function fulfillmentDocumentId(namespace: string, ...parts: readonly string[]): MikaId {
  return createMikaId([namespace, ...parts].map(fulfillmentIdPart).join("_"));
}

export function fulfillmentIdPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "value";
}

export function updateOrderAfterRefund(
  order: OrderDocument,
  refundInput: OrderRefundInput,
  now: ISODateTime,
): OrderDocument {
  return applyOrderRefund(order, refundInput, now);
}

export function updateOrderAfterCancel(
  order: OrderDocument,
  cancelInput: OrderCancelInput,
  now: ISODateTime,
): OrderDocument {
  return applyOrderCancel(order, cancelInput, now);
}
