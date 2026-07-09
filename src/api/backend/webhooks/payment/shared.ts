/**
 * Shared payment-webhook helpers: subject locks, order persistence, and status marks.
 */
import { createOrderAggregate, orderLineFromCheckoutLine } from "../../../../model/builders";
import { omitUndefined } from "../../../../internal/object";
import {
  type MikaProviderPaymentEvent,
  type MikaProviderSubscriptionEvent,
} from "../../../../provider";
import { type CheckoutLine, type CustomerSnapshot } from "../../../../types/aggregates";
import {
  type CheckoutDocument,
  type OrderDocument,
  type SubscriptionDocument,
  type WebhookDocument,
} from "../../../../types/documents";
import { type ISODateTime, type JsonObject, type MikaId } from "../../../../types/primitives";
import { type MikaRequestContext } from "../../../context";
import { checkoutCustomerFromMetadata } from "../../checkout";
import { emitBackendNotification, observeBackendError } from "../../errors";
import { isAnonymizedCustomer } from "../../identity";
import { applyPaymentEventToOrder } from "../../../lifecycle";
import { type MikaBackendDependencies } from "../../ports";
import { addMilliseconds, emailHashKey } from "../../shared";

export interface WebhookSubjectLockTarget {
  readonly kind: "payment" | "order" | "checkout" | "subscription" | "subscription_customer";
  readonly identity: string;
}

export async function withWebhookSubjectLock<TResult>(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  target: WebhookSubjectLockTarget | null,
  run: () => Promise<TResult>,
): Promise<TResult | null> {
  if (!target) return run();

  const subject = `${target.kind}:${target.identity}`;
  const subjectHash = await input.hash(`webhook-subject-lock:${subject}`);
  const owner = `${webhook.id}:${ctx.now}`;
  const key = `webhook-subject-lock:${subjectHash}`;
  const lock = await input.repositories.ephemeral.tryAcquireLock({
    key,
    owner,
    subjectHash,
    expiresAt: addMilliseconds(ctx.now, 300_000),
    now: ctx.now,
  });
  if (!lock) return null;

  try {
    return await run();
  } finally {
    await input.repositories.ephemeral
      .releaseLock({ key, owner, now: ctx.now })
      .catch((error: unknown) =>
        observeBackendError(input, "webhook.subjectLock.release", error, { key }),
      );
  }
}

export function paymentWebhookLockTarget(
  event: MikaProviderPaymentEvent,
): WebhookSubjectLockTarget | null {
  if (event.providerPaymentId) {
    return { kind: "payment", identity: `${event.provider}:${event.providerPaymentId}` };
  }
  if (event.providerOrderId) {
    return { kind: "order", identity: `${event.provider}:${event.providerOrderId}` };
  }
  if (event.providerCheckoutId) {
    return { kind: "checkout", identity: `${event.provider}:${event.providerCheckoutId}` };
  }

  return null;
}

export function subscriptionWebhookLockTarget(
  event: MikaProviderSubscriptionEvent,
): WebhookSubjectLockTarget | null {
  if (event.providerSubscriptionId) {
    return { kind: "subscription", identity: `${event.provider}:${event.providerSubscriptionId}` };
  }
  if (event.providerCustomerId && event.providerPriceId) {
    return {
      kind: "subscription_customer",
      identity: `${event.provider}:${event.providerCustomerId}:${event.providerPriceId}`,
    };
  }

  return null;
}

export async function findExistingPaymentOrder(
  input: MikaBackendDependencies,
  event: MikaProviderPaymentEvent,
  checkoutSessionId?: MikaId,
): Promise<OrderDocument | null> {
  if (event.providerPaymentId) {
    const order = await input.repositories.ledger.findOrderByProviderPayment(
      event.provider,
      event.providerPaymentId,
    );
    if (order) return order;
  }

  if (event.providerOrderId) {
    const order = await input.repositories.ledger.findOrderByProviderOrder(
      event.provider,
      event.providerOrderId,
    );
    if (order) return order;
  }

  if (event.providerCheckoutId) {
    const order = await input.repositories.ledger.findOrderByProviderCheckout(
      event.provider,
      event.providerCheckoutId,
    );
    if (order) return order;
  }

  if (checkoutSessionId) {
    const order = await input.repositories.ledger.findOrderByCheckoutSession(checkoutSessionId);
    if (order) return order;
  }

  return null;
}

export async function persistNewPaymentOrder(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  checkout: CheckoutDocument,
): Promise<OrderDocument> {
  try {
    await input.repositories.ledger.put(order);

    return order;
  } catch (error) {
    const existingOrder = await findExistingPaymentOrder(input, event, checkout.id);
    if (!existingOrder) throw error;

    return updatePaymentOrderFromEvent(input, ctx, existingOrder, event);
  }
}

export async function findPaymentEventCheckout(
  input: MikaBackendDependencies,
  event: Pick<MikaProviderPaymentEvent, "provider" | "providerCheckoutId">,
): Promise<CheckoutDocument | null> {
  if (!event.providerCheckoutId) return null;

  return input.repositories.session.findCheckoutByProvider(
    event.provider,
    event.providerCheckoutId,
  );
}

export async function createPaymentOrderDocument(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  checkout: CheckoutDocument,
  event: MikaProviderPaymentEvent,
): Promise<OrderDocument> {
  const orderId = input.createId("order");
  const total = checkout.aggregate.totals.total;
  const lines = checkout.aggregate.lines.map((line) =>
    orderLineFromCheckoutLine({
      id: input.createId("order_line"),
      line,
      metadata: paymentOrderLineMetadata(line, event),
    }),
  );
  const customer = await paymentCustomerSnapshot(input, checkout, event);

  return omitUndefined({
    id: orderId,
    type: "order",
    schemaVersion: 1,
    orderNumber: orderId,
    customerId: customer.customerId,
    ...(customer.emailHash ? { emailHash: customer.emailHash } : {}),
    provider: event.provider,
    providerCheckoutId:
      event.providerCheckoutId ??
      checkout.providerCheckoutId ??
      checkout.aggregate.binding.providerCheckoutId,
    providerPaymentId: event.providerPaymentId,
    providerOrderId: event.providerOrderId,
    checkoutSessionId: checkout.id,
    status: "paid",
    paymentStatus: "paid",
    currency: total.currency,
    totalAmount: total.amount,
    paidAt: ctx.now,
    aggregate: createOrderAggregate(
      omitUndefined({
        customer,
        checkout: checkout.aggregate,
        lines,
        providerPaymentId: event.providerPaymentId,
        providerOrderId: event.providerOrderId,
        invoiceUrl: event.invoiceUrl,
        metadata: paymentOrderMetadata(event, checkout.id),
      }),
    ),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
}

export async function updatePaymentOrderFromEvent(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): Promise<OrderDocument> {
  const updated = applyPaymentEventToOrder(
    order,
    event,
    ctx.now,
    omitUndefined({
      invoiceUrl: event.invoiceUrl,
      providerRefs: mergePaymentProviderRefs(order.aggregate.providerRefs, order, event),
      metadata: {
        ...order.aggregate.metadata,
        ...paymentOrderMetadata(event, order.checkoutSessionId),
      },
    }),
  );

  await input.repositories.ledger.put(updated);

  return updated;
}

export function mergePaymentProviderRefs(
  refs: OrderDocument["aggregate"]["providerRefs"],
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): OrderDocument["aggregate"]["providerRefs"] {
  const providerCheckoutId = event.providerCheckoutId ?? order.providerCheckoutId;
  const index = refs.findIndex(
    (ref) =>
      ref.provider === event.provider &&
      ((providerCheckoutId !== undefined && ref.checkoutId === providerCheckoutId) ||
        (event.providerPaymentId !== undefined && ref.paymentId === event.providerPaymentId) ||
        (event.providerOrderId !== undefined && ref.orderId === event.providerOrderId)),
  );
  const existing = refs[index] ?? { provider: event.provider };
  const merged = omitUndefined({
    ...existing,
    checkoutId: existing.checkoutId ?? providerCheckoutId,
    paymentId: existing.paymentId ?? event.providerPaymentId,
    orderId: existing.orderId ?? event.providerOrderId,
  });

  return index >= 0
    ? refs.map((ref, refIndex) => (refIndex === index ? merged : ref))
    : [...refs, merged];
}

export async function paymentCustomerSnapshot(
  input: MikaBackendDependencies,
  checkout: CheckoutDocument,
  event: MikaProviderPaymentEvent,
): Promise<CustomerSnapshot> {
  const checkoutCustomerRecord = checkout.customerId
    ? await input.repositories.account.findCustomerById(checkout.customerId)
    : null;
  const checkoutCustomerAnonymized =
    checkoutCustomerRecord !== null && isAnonymizedCustomer(checkoutCustomerRecord);
  const checkoutCustomer =
    checkoutCustomerRecord && !checkoutCustomerAnonymized ? checkoutCustomerRecord : null;
  const checkoutCustomerId = checkoutCustomerAnonymized ? undefined : checkout.customerId;
  const checkoutMetadataCustomer = checkoutCustomerFromMetadata(checkout.aggregate.metadata);
  const email =
    checkoutCustomer?.aggregate.email ?? event.customer?.email ?? checkoutMetadataCustomer.email;
  const trimmedEmail = email?.trim();
  const payerEmailHash = trimmedEmail ? await input.hash(emailHashKey(trimmedEmail)) : undefined;

  const customer =
    checkoutCustomer ??
    (!checkout.customerId && payerEmailHash
      ? await input.repositories.account.findCustomerByEmailHash(payerEmailHash)
      : null);

  return omitUndefined({
    ...((customer?.customerId ?? checkoutCustomerId)
      ? { customerId: customer?.customerId ?? checkoutCustomerId }
      : {}),
    ...(customer?.userId ? { userId: customer.userId } : {}),
    email: customer?.aggregate.email ?? email,
    emailHash: customer?.emailHash ?? customer?.aggregate.emailHash ?? payerEmailHash,
    name: event.customer?.name ?? checkoutMetadataCustomer.name,
    company: event.customer?.company ?? checkoutMetadataCustomer.company,
    vatId: event.customer?.vatId ?? checkoutMetadataCustomer.vatId,
  });
}

export function paymentOrderMetadata(
  event: MikaProviderPaymentEvent,
  checkoutSessionId?: MikaId,
): JsonObject {
  return {
    source: "webhook.payment",
    ...(checkoutSessionId ? { checkoutSessionId } : {}),
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
    ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
    ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
  };
}

export function paymentOrderLineMetadata(
  line: CheckoutLine,
  event: MikaProviderPaymentEvent,
): JsonObject {
  return {
    checkoutLineId: line.id,
    ...(line.reservationId ? { reservationId: line.reservationId } : {}),
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
  };
}

export async function markWebhookProcessedForOrder(
  input: MikaBackendDependencies,
  webhook: WebhookDocument,
  now: ISODateTime,
  order: OrderDocument,
): Promise<WebhookDocument> {
  return markWebhookProcessed(
    input,
    webhook,
    now,
    omitUndefined({
      relatedCustomerId: order.customerId,
      relatedOrderId: order.id,
    }),
  );
}

export async function markWebhookProcessedForSubscription(
  input: MikaBackendDependencies,
  webhook: WebhookDocument,
  now: ISODateTime,
  subscription: SubscriptionDocument,
): Promise<WebhookDocument> {
  return markWebhookProcessed(
    input,
    webhook,
    now,
    omitUndefined({
      relatedCustomerId: subscription.customerId,
      relatedSubscriptionId: subscription.id,
    }),
  );
}

export async function markWebhookProcessed(
  input: MikaBackendDependencies,
  webhook: WebhookDocument,
  now: ISODateTime,
  related: Pick<
    WebhookDocument["record"],
    "relatedCustomerId" | "relatedOrderId" | "relatedSubscriptionId"
  >,
): Promise<WebhookDocument> {
  const processed: WebhookDocument = {
    ...webhook,
    status: "processed",
    record: {
      ...webhook.record,
      status: "processed",
      attemptCount: webhook.record.attemptCount + 1,
      processedAt: now,
      ...related,
    },
    updatedAt: now,
  };

  return putWebhook(input, processed);
}

export async function markWebhookFailed(
  input: MikaBackendDependencies,
  webhook: WebhookDocument,
  now: ISODateTime,
  lastError: string,
  options: { readonly retryable?: boolean } = {},
): Promise<WebhookDocument> {
  const failed: WebhookDocument = {
    ...webhook,
    status: "failed",
    record: {
      ...webhook.record,
      status: "failed",
      attemptCount: webhook.record.attemptCount + 1,
      lastError,
      retryable: options.retryable ?? false,
    },
    updatedAt: now,
  };

  const persisted = await putWebhook(input, failed);
  await emitBackendNotification(input, "ops.webhook_failed", now, {
    webhookId: persisted.id,
    provider: persisted.provider,
    eventType: persisted.eventType,
    ...(persisted.providerEventId ? { providerEventId: persisted.providerEventId } : {}),
    payloadHash: persisted.payloadHash,
    lastError,
    ...(persisted.record.relatedCustomerId
      ? { relatedCustomerId: persisted.record.relatedCustomerId }
      : {}),
    ...(persisted.record.relatedOrderId ? { relatedOrderId: persisted.record.relatedOrderId } : {}),
    ...(persisted.record.relatedSubscriptionId
      ? { relatedSubscriptionId: persisted.record.relatedSubscriptionId }
      : {}),
  });

  return persisted;
}

export async function putWebhook(
  input: MikaBackendDependencies,
  webhook: WebhookDocument,
): Promise<WebhookDocument> {
  try {
    await input.repositories.ops.put(webhook);
  } catch (error) {
    throw new Error(`Webhook '${webhook.id}' status could not be persisted.`, { cause: error });
  }

  return webhook;
}
