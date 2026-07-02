/**
 * Payment and subscription webhook processing: linking a provider payment event to an order
 * (existing, checkout-linked, or brand-new), running the fulfillment workflow with per-step
 * resumability, payment reversal (refund/chargeback) handling, subscription event ingestion, and
 * the shared webhook-status transitions (processed/failed) both paths persist through.
 */
import {
  createOrderAggregate,
  createSubscriptionAggregate,
  orderLineFromCheckoutLine,
  snapshotPrice,
} from "../../../model/builders";
import type {
  MikaProviderPaymentEvent,
  MikaProviderSubscriptionEvent,
  MikaProviderWebhookEvent,
} from "../../../provider";
import type { CheckoutLine, CustomerSnapshot } from "../../../types/aggregates";
import type {
  CheckoutDocument,
  OrderDocument,
  SubscriptionDocument,
  WebhookDocument,
  WorkflowDocument,
} from "../../../types/documents";
import type { ISODateTime, JsonObject, MikaId } from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import { checkoutCustomerFromMetadata, expireCheckoutDocument } from "../checkout";
import { emitBackendNotification, observeBackendError } from "../errors";
import {
  completeCheckoutForPaymentOrder,
  fulfillCheckoutPaymentOrder,
  fulfillPaidOrder,
  fulfillmentDocumentId,
  revokeOrderFulfillmentAccess,
  updateOrderAfterRefund,
} from "../fulfillment";
import type { PaymentWebhookWorkflowStep, RunPaymentWebhookWorkflowStep } from "../fulfillment";
import { isAnonymizedCustomer } from "../identity";
import {
  applyPaymentEventToOrder,
  orderBlocksFulfillment,
  orderRefundedAmount,
} from "../../lifecycle";
import type { CreateMikaBackendApiInput } from "../ports";
import { addMilliseconds, currentBackendISODateTime } from "../shared";
import {
  emitSubscriptionLifecycleNotification,
  updateSubscriptionEntitlement,
} from "../subscriptions";
import { WorkflowRunner, WorkflowRunnerLeaseLostError } from "../workflow-runner";
import { isReplayableWebhookStatus } from "./ingest";

export async function processStoredWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderWebhookEvent,
): Promise<WebhookDocument> {
  switch (event.kind) {
    case "payment":
      if (event.paymentStatus === "refunded" || event.paymentStatus === "partially_refunded") {
        try {
          return (
            (await withWebhookSubjectLock(
              input,
              ctx,
              webhook,
              paymentWebhookLockTarget(event),
              () => processPaymentReversalWebhook(input, ctx, webhook, event),
            )) ?? webhook
          );
        } catch (error) {
          if (error instanceof WorkflowRunnerLeaseLostError) return webhook;

          return markWebhookFailed(
            input,
            webhook,
            ctx.now,
            "Refund webhook could not be processed.",
            { strict: true },
          );
        }
      }

      if (event.paymentStatus !== "paid") {
        if (event.type === "checkout.session.expired") {
          return (
            (await withWebhookSubjectLock(
              input,
              ctx,
              webhook,
              paymentWebhookLockTarget(event),
              () => processCheckoutExpiredWebhook(input, ctx, webhook, event),
            )) ?? webhook
          );
        }

        const failed = await markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment webhook is not in a paid state.",
          { strict: true },
        );
        await emitCheckoutPaymentFailedNotification(input, ctx.now, failed, event);

        return failed;
      }

      try {
        return (
          (await withWebhookSubjectLock(input, ctx, webhook, paymentWebhookLockTarget(event), () =>
            processPaymentWebhook(input, ctx, webhook, event),
          )) ?? webhook
        );
      } catch (error) {
        if (error instanceof WorkflowRunnerLeaseLostError) return webhook;

        return markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment webhook could not be processed.",
          { strict: true, retryable: true },
        );
      }
    case "subscription":
      try {
        return (
          (await withWebhookSubjectLock(
            input,
            ctx,
            webhook,
            subscriptionWebhookLockTarget(event),
            () => processSubscriptionWebhook(input, ctx, webhook, event),
          )) ?? webhook
        );
      } catch {
        return markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Subscription webhook could not be processed.",
          { strict: true, retryable: true },
        );
      }
    case "unknown":
      return webhook;
  }
}

interface WebhookSubjectLockTarget {
  readonly kind: "payment" | "order" | "checkout" | "subscription" | "subscription_customer";
  readonly identity: string;
}

async function withWebhookSubjectLock<TResult>(
  input: CreateMikaBackendApiInput,
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

function paymentWebhookLockTarget(
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

function subscriptionWebhookLockTarget(
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

/**
 * Applies a provider-initiated payment reversal (refund / chargeback / uncollectible invoice) to
 * the matching order: downgrades it to `refunded`/`partially_refunded` and, on a FULL reversal,
 * revokes the order's entitlements/licenses (a partial refund intentionally retains access). Idem-
 * potent: a re-delivered reversal for an already fully-refunded order is a no-op. A reversal with
 * a strong provider payment/order id is retryable until the matching Mika order exists; weak,
 * uncorrelated reversals are acknowledged so non-Mika provider noise is not retried forever.
 */
async function processPaymentReversalWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  const order = await findExistingPaymentOrder(input, event);
  if (!order) {
    if (reversalHasStrongOrderIdentity(event)) {
      return markWebhookFailed(
        input,
        webhook,
        ctx.now,
        "Refund webhook could not be linked to an order.",
        { strict: true },
      );
    }

    return markWebhookProcessed(input, webhook, ctx.now, {}, { strict: true });
  }

  if (order.paymentStatus === "refunded") {
    await revokeOrderFulfillmentAccess(input, order, ctx.now, "order_refunded");
    return markWebhookProcessedForOrder(input, webhook, ctx.now, order);
  }

  const now = ctx.now;
  const cumulativeReversed = event.totals?.total?.amount;
  if (event.paymentStatus === "partially_refunded" && cumulativeReversed === undefined) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Partial refund webhook is missing cumulative refund totals.",
      { strict: true },
    );
  }
  const refundAmount =
    event.paymentStatus === "partially_refunded" && cumulativeReversed !== undefined
      ? Math.max(0, cumulativeReversed - orderRefundedAmount(order))
      : undefined;

  const updated = updateOrderAfterRefund(
    order,
    {
      orderId: order.id,
      reason: event.type,
      ...(refundAmount !== undefined ? { amount: refundAmount } : {}),
    },
    now,
  );
  await input.repositories.ledger.put(updated);
  if (updated.status === "refunded") {
    await revokeOrderFulfillmentAccess(input, updated, now, "order_refunded");
  }

  return markWebhookProcessedForOrder(input, webhook, now, updated);
}

async function processCheckoutExpiredWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  const checkout = await findPaymentEventCheckout(input, event);
  if (!checkout) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Expired checkout webhook could not be linked to a checkout.",
      { strict: true },
    );
  }

  const expired = await expireCheckoutDocument(input, checkout, ctx.now);

  return markWebhookProcessed(input, webhook, ctx.now, {
    relatedCustomerId: expired.customerId,
  });
}

function reversalHasStrongOrderIdentity(event: MikaProviderPaymentEvent): boolean {
  return Boolean(event.providerPaymentId || event.providerOrderId);
}

type PaymentFailureWebhookEvent = Omit<MikaProviderPaymentEvent, "paymentStatus"> & {
  readonly paymentStatus?: string;
};

async function emitCheckoutPaymentFailedNotification(
  input: CreateMikaBackendApiInput,
  now: ISODateTime,
  webhook: WebhookDocument,
  event: PaymentFailureWebhookEvent,
): Promise<void> {
  const checkout = await findPaymentEventCheckout(input, event);

  await emitBackendNotification(input, "checkout.payment_failed", now, {
    ...(event.customer?.email ? { toEmail: event.customer.email } : {}),
    ...(checkout?.customerId ? { customerId: checkout.customerId } : {}),
    ...(checkout?.id ? { checkoutId: checkout.id } : {}),
    provider: event.provider,
    ...((event.providerCheckoutId ?? checkout?.providerCheckoutId)
      ? { providerCheckoutId: event.providerCheckoutId ?? checkout?.providerCheckoutId }
      : {}),
    ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
    ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
    ...(event.paymentStatus ? { paymentStatus: event.paymentStatus } : {}),
    eventType: event.type,
    webhookId: webhook.id,
    error: webhook.record.lastError ?? "Payment webhook is not in a paid state.",
    ...(event.totals?.total ? { total: event.totals.total } : {}),
  });
}

async function processPaymentWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WebhookDocument> {
  return runPaymentWebhookWorkflow(input, ctx, webhook, event, async (runWorkflowStep) => {
    let existingOrder = await findExistingPaymentOrder(input, event);
    if (existingOrder) {
      const orderSource = existingOrder;
      const order = await runWorkflowStep("persist_order", () =>
        updatePaymentOrderFromEvent(input, ctx, orderSource, event),
      );
      const fulfilledOrder = orderBlocksFulfillment(order)
        ? order
        : await fulfillCheckoutPaymentOrder(input, ctx, runWorkflowStep, order, event);

      return runWorkflowStep("mark_webhook", () =>
        markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
      );
    }

    const checkout = await runWorkflowStep("link_checkout", () =>
      findPaymentEventCheckout(input, event),
    );
    if (!checkout) {
      if (event.providerSubscriptionId) {
        return runWorkflowStep("mark_webhook", () =>
          markWebhookProcessed(input, webhook, ctx.now, {}, { strict: true }),
        );
      }
      return runWorkflowStep("mark_webhook", () =>
        markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment event could not be linked to a checkout.",
          {
            strict: true,
          },
        ),
      );
    }

    existingOrder = await findExistingPaymentOrder(input, event, checkout.id);
    if (existingOrder) {
      const orderSource = existingOrder;
      const order = await runWorkflowStep("persist_order", () =>
        updatePaymentOrderFromEvent(input, ctx, orderSource, event),
      );
      const fulfilledOrder = orderBlocksFulfillment(order)
        ? order
        : await fulfillCheckoutPaymentOrder(input, ctx, runWorkflowStep, order, event, checkout);

      return runWorkflowStep("mark_webhook", () =>
        markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
      );
    }

    const order = await runWorkflowStep("persist_order", async () =>
      persistNewPaymentOrder(
        input,
        ctx,
        await createPaymentOrderDocument(input, ctx, checkout, event),
        event,
        checkout,
      ),
    );
    await runWorkflowStep("complete_checkout", () =>
      completeCheckoutForPaymentOrder(input, ctx, order, event, checkout),
    );
    const fulfilledOrder = await runWorkflowStep("fulfill_order", () =>
      fulfillPaidOrder(input, ctx, order),
    );

    return runWorkflowStep("mark_webhook", () =>
      markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
    );
  });
}

async function runPaymentWebhookWorkflow(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
  run: (step: RunPaymentWebhookWorkflowStep) => Promise<WebhookDocument>,
): Promise<WebhookDocument> {
  const leasedWorkflow = await startPaymentWebhookWorkflow(input, ctx, webhook, event);
  if (!leasedWorkflow) return webhook;

  const runner = new WorkflowRunner<PaymentWebhookWorkflowStep>({
    ops: input.repositories.ops,
    workflow: leasedWorkflow,
    now: () => currentBackendISODateTime(input),
    nextAttemptAt: nextWorkflowAttemptAt,
    stepFailureMessage: "Payment webhook workflow failed.",
  });

  try {
    const result = await run((name, fn) => runner.runStep(name, fn));
    if (result.status === "failed") {
      await runner.fail(result.record.lastError ?? "Payment webhook could not be processed.");

      return result;
    }

    await runner.complete({
      webhookStatus: result.status,
      ...(result.record.relatedOrderId ? { relatedOrderId: result.record.relatedOrderId } : {}),
    });

    return result;
  } catch (error) {
    if (error instanceof WorkflowRunnerLeaseLostError) throw error;

    if (!runner.failurePersisted) {
      await runner.fail(
        error instanceof Error ? error.message : "Payment webhook workflow failed.",
      );
    }
    throw error;
  }
}

const PAYMENT_WEBHOOK_WORKFLOW_STEPS = [
  "link_checkout",
  "persist_order",
  "complete_checkout",
  "fulfill_order",
  "mark_webhook",
] as const satisfies readonly PaymentWebhookWorkflowStep[];

async function startPaymentWebhookWorkflow(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<WorkflowDocument | null> {
  const id = fulfillmentDocumentId("workflow", webhook.id, "payment");
  const existing = await input.repositories.ops.findWorkflow(id);
  if (existing) {
    return leasePaymentWebhookWorkflow(
      input,
      ctx,
      id,
      webhook,
      shouldForcePaymentWebhookWorkflowLease(webhook),
    );
  }

  const workflow: WorkflowDocument = {
    id,
    type: "workflow",
    schemaVersion: 1,
    kind: "payment_webhook_fulfillment",
    status: "queued",
    subjectType: "webhook",
    subjectId: webhook.id,
    idempotencyKey: event.providerEventId ?? webhook.payloadHash,
    nextAttemptAt: ctx.now,
    record: {
      id,
      kind: "payment_webhook_fulfillment",
      status: "queued",
      subjectType: "webhook",
      subjectId: webhook.id,
      idempotencyKey: event.providerEventId ?? webhook.payloadHash,
      attemptCount: 0,
      maxAttempts: 5,
      nextAttemptAt: ctx.now,
      steps: paymentWorkflowSteps(null),
      resumeState: {
        provider: event.provider,
        webhookId: webhook.id,
        ...(event.providerCheckoutId ? { providerCheckoutId: event.providerCheckoutId } : {}),
        ...(event.providerPaymentId ? { providerPaymentId: event.providerPaymentId } : {}),
        ...(event.providerOrderId ? { providerOrderId: event.providerOrderId } : {}),
      },
      createdAt: ctx.now,
      updatedAt: ctx.now,
      metadata: {
        source: "webhook.payment",
      },
    },
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };

  const created = await input.repositories.ops.createWorkflow(workflow);
  if (!created) {
    return leasePaymentWebhookWorkflow(
      input,
      ctx,
      id,
      webhook,
      shouldForcePaymentWebhookWorkflowLease(webhook),
    );
  }

  return leasePaymentWebhookWorkflow(input, ctx, id, webhook);
}

function shouldForcePaymentWebhookWorkflowLease(webhook: WebhookDocument): boolean {
  return isReplayableWebhookStatus(webhook.status);
}

function leasePaymentWebhookWorkflow(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  workflowId: MikaId,
  webhook: WebhookDocument,
  force = false,
): Promise<WorkflowDocument | null> {
  return input.repositories.ops.tryLeaseWorkflow({
    workflowId,
    leaseKey: `payment:${webhook.id}:${ctx.now}`,
    now: ctx.now,
    leaseExpiresAt: addMilliseconds(ctx.now, 300_000),
    force,
  });
}

function paymentWorkflowSteps(
  existing: WorkflowDocument | null,
): WorkflowDocument["record"]["steps"] {
  const existingSteps = new Map(existing?.record.steps.map((step) => [step.name, step]) ?? []);

  return PAYMENT_WEBHOOK_WORKFLOW_STEPS.map((name) => {
    const prior = existingSteps.get(name);
    return {
      name,
      status:
        prior?.status === "completed"
          ? "completed"
          : prior?.status === "failed"
            ? "failed"
            : "queued",
      startedAt: prior?.startedAt,
      completedAt: prior?.completedAt,
      failedAt: prior?.status === "failed" ? prior.failedAt : undefined,
      attemptCount: prior?.attemptCount ?? 0,
      nextAttemptAt: prior?.status === "failed" ? prior.nextAttemptAt : undefined,
      lastError: prior?.status === "failed" ? prior.lastError : undefined,
      state: prior?.state,
    };
  });
}

function nextWorkflowAttemptAt(now: ISODateTime, workflow: WorkflowDocument): ISODateTime {
  const attempt = Math.max(1, workflow.record.attemptCount);
  const delay = Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000);

  return addMilliseconds(now, delay);
}

export async function processSubscriptionWebhook(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  webhook: WebhookDocument,
  event: MikaProviderSubscriptionEvent,
): Promise<WebhookDocument> {
  const resolved = await findOrCreateSubscriptionFromEvent(input, ctx, event);
  if (!resolved) {
    return markWebhookFailed(
      input,
      webhook,
      ctx.now,
      "Subscription event could not be linked to a subscription.",
    );
  }
  if (resolved.kind === "anonymized_customer") {
    return markWebhookProcessed(input, webhook, ctx.now, {
      relatedCustomerId: resolved.customerId,
      ...(resolved.subscription ? { relatedSubscriptionId: resolved.subscription.id } : {}),
    });
  }

  const previous = resolved.created ? undefined : resolved.subscription;
  const updated = await updateSubscriptionFromEvent(input, ctx, resolved.subscription, event);
  const fulfilled = await updateSubscriptionEntitlement(input, ctx, updated);
  await emitSubscriptionLifecycleNotification(input, ctx.now, fulfilled, {
    event,
    previous,
    created: resolved.created,
  });

  return markWebhookProcessedForSubscription(input, webhook, ctx.now, fulfilled);
}

type SubscriptionFromEventResult =
  | {
      readonly kind: "subscription";
      readonly subscription: SubscriptionDocument;
      readonly created: boolean;
    }
  | {
      readonly kind: "anonymized_customer";
      readonly customerId: MikaId;
      readonly subscription?: SubscriptionDocument;
    };

async function findOrCreateSubscriptionFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  event: MikaProviderSubscriptionEvent,
): Promise<SubscriptionFromEventResult | null> {
  if (event.providerSubscriptionId) {
    const existing = await input.repositories.account.findSubscriptionByProvider(
      event.provider,
      event.providerSubscriptionId,
    );
    if (existing) {
      const customerId = existing.customerId ?? existing.aggregate.customer.customerId;
      if (customerId) {
        const customer = await input.repositories.account.findCustomerById(customerId);
        if (customer && isAnonymizedCustomer(customer)) {
          return { kind: "anonymized_customer", customerId, subscription: existing };
        }
      }
      return { kind: "subscription", subscription: existing, created: false };
    }
  }

  if (!event.providerSubscriptionId || !event.providerCustomerId || !event.providerPriceId) {
    return null;
  }

  const providerAccount = await input.repositories.account.findProviderAccount(
    event.provider,
    event.providerCustomerId,
  );
  if (!providerAccount) return null;

  const priceMatch = await input.repositories.catalog.findItemByProviderPrice(
    event.provider,
    event.providerPriceId,
  );
  if (!priceMatch) return null;

  const customer = await input.repositories.account.findCustomerById(providerAccount.customerId);
  if (customer && isAnonymizedCustomer(customer)) {
    return { kind: "anonymized_customer", customerId: providerAccount.customerId };
  }
  const customerSnapshot: CustomerSnapshot = {
    customerId: providerAccount.customerId,
    userId: customer?.userId,
    email: customer?.aggregate.email ?? providerAccount.record.emailSnapshot,
    emailHash: customer?.emailHash ?? customer?.aggregate.emailHash,
    name: customer?.aggregate.name,
    company: customer?.aggregate.company,
    vatId: customer?.aggregate.vatId,
  };
  const subscriptionId = input.createId("subscription");
  const aggregate = createSubscriptionAggregate({
    customer: customerSnapshot,
    sellable: snapshotPrice({
      content: priceMatch.catalog.aggregate.content,
      sellable: priceMatch.sellable,
      price: priceMatch.price,
      fallbackTitle: priceMatch.catalog.titleSnapshot ?? priceMatch.sellable.id,
    }),
    provider: event.provider,
    providerSubscriptionId: event.providerSubscriptionId,
    providerCustomerId: event.providerCustomerId,
    providerPriceId: event.providerPriceId,
    status: event.status,
    currentPeriodStart: event.currentPeriodStart,
    currentPeriodEnd: event.currentPeriodEnd,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    metadata: subscriptionEventMetadata(event),
  });

  return {
    kind: "subscription",
    subscription: {
      id: subscriptionId,
      type: "subscription",
      schemaVersion: 1,
      customerId: providerAccount.customerId,
      provider: event.provider,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      status: event.status,
      currentPeriodEnd: event.currentPeriodEnd,
      aggregate,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
    created: true,
  };
}

function subscriptionEventIsStale(
  subscription: SubscriptionDocument,
  event: MikaProviderSubscriptionEvent,
): boolean {
  const appliedStart = subscription.aggregate.currentPeriodStart;
  const eventStart = event.currentPeriodStart;
  if (!appliedStart || !eventStart) return false;

  return new Date(eventStart).getTime() < new Date(appliedStart).getTime();
}

async function updateSubscriptionFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
  event: MikaProviderSubscriptionEvent,
): Promise<SubscriptionDocument> {
  if (subscriptionEventIsStale(subscription, event)) {
    return subscription;
  }

  const eventStart = event.currentPeriodStart;
  const appliedStart = subscription.aggregate.currentPeriodStart;
  const eventAdvancesPeriod = Boolean(
    eventStart && appliedStart && new Date(eventStart).getTime() > new Date(appliedStart).getTime(),
  );
  const localStatusIsTerminal =
    subscription.status === "cancelled" || subscription.status === "expired";
  const eventStatusIsTerminal = event.status === "cancelled" || event.status === "expired";
  if (localStatusIsTerminal && !eventStatusIsTerminal && !eventAdvancesPeriod) {
    return subscription;
  }
  const preserveLocalCancel =
    subscription.status === "cancel_at_period_end" &&
    event.status === "active" &&
    !eventAdvancesPeriod;
  const preserveRenewedActive =
    subscription.status === "active" &&
    subscription.aggregate.cancelAtPeriodEnd === false &&
    subscription.aggregate.metadata?.["lastAdminAction"] === "subscription.renew" &&
    event.status === "active" &&
    event.cancelAtPeriodEnd === true &&
    !eventAdvancesPeriod;
  const status = preserveLocalCancel ? "cancel_at_period_end" : event.status;
  const cancelAtPeriodEnd = preserveLocalCancel
    ? true
    : preserveRenewedActive
      ? false
      : (event.cancelAtPeriodEnd ?? subscription.aggregate.cancelAtPeriodEnd ?? false);
  const priceMatch = event.providerPriceId
    ? await input.repositories.catalog.findItemByProviderPrice(
        event.provider,
        event.providerPriceId,
      )
    : null;
  const sellable =
    priceMatch && priceMatch.price.mode === "subscription"
      ? snapshotPrice({
          content: priceMatch.catalog.aggregate.content,
          sellable: priceMatch.sellable,
          price: priceMatch.price,
          fallbackTitle: priceMatch.catalog.titleSnapshot ?? priceMatch.sellable.id,
        })
      : subscription.aggregate.sellable;

  const updated: SubscriptionDocument = {
    ...subscription,
    providerCustomerId: event.providerCustomerId ?? subscription.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId ?? subscription.providerSubscriptionId,
    status,
    currentPeriodEnd: event.currentPeriodEnd ?? subscription.currentPeriodEnd,
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      providerRef: {
        ...subscription.aggregate.providerRef,
        provider: event.provider,
        subscriptionId:
          event.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId,
        customerId: event.providerCustomerId ?? subscription.aggregate.providerRef.customerId,
        priceId: event.providerPriceId ?? subscription.aggregate.providerRef.priceId,
      },
      sellable,
      status,
      cancelAtPeriodEnd,
      currentPeriodStart: event.currentPeriodStart ?? subscription.aggregate.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd,
      metadata: {
        ...subscription.aggregate.metadata,
        ...subscriptionEventMetadata(event),
      },
    },
  };

  await input.repositories.account.put(updated);

  return updated;
}

function subscriptionEventMetadata(event: MikaProviderSubscriptionEvent): JsonObject {
  return {
    source: "webhook.subscription",
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
    ...(event.providerSubscriptionId
      ? { providerSubscriptionId: event.providerSubscriptionId }
      : {}),
    ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}),
    ...(event.providerPriceId ? { providerPriceId: event.providerPriceId } : {}),
  };
}

async function findExistingPaymentOrder(
  input: CreateMikaBackendApiInput,
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

async function persistNewPaymentOrder(
  input: CreateMikaBackendApiInput,
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

async function findPaymentEventCheckout(
  input: CreateMikaBackendApiInput,
  event: Pick<MikaProviderPaymentEvent, "provider" | "providerCheckoutId">,
): Promise<CheckoutDocument | null> {
  if (!event.providerCheckoutId) return null;

  return input.repositories.session.findCheckoutByProvider(
    event.provider,
    event.providerCheckoutId,
  );
}

async function createPaymentOrderDocument(
  input: CreateMikaBackendApiInput,
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

  return {
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
    aggregate: createOrderAggregate({
      customer,
      checkout: checkout.aggregate,
      lines,
      providerPaymentId: event.providerPaymentId,
      providerOrderId: event.providerOrderId,
      invoiceUrl: event.invoiceUrl,
      metadata: paymentOrderMetadata(event, checkout.id),
    }),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

async function updatePaymentOrderFromEvent(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
): Promise<OrderDocument> {
  const updated = applyPaymentEventToOrder(order, event, ctx.now, {
    invoiceUrl: event.invoiceUrl,
    providerRefs: mergePaymentProviderRefs(order.aggregate.providerRefs, order, event),
    metadata: {
      ...order.aggregate.metadata,
      ...paymentOrderMetadata(event, order.checkoutSessionId),
    },
  });

  await input.repositories.ledger.put(updated);

  return updated;
}

function mergePaymentProviderRefs(
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
  const merged = {
    ...existing,
    checkoutId: existing.checkoutId ?? providerCheckoutId,
    paymentId: existing.paymentId ?? event.providerPaymentId,
    orderId: existing.orderId ?? event.providerOrderId,
  };

  return index >= 0
    ? refs.map((ref, refIndex) => (refIndex === index ? merged : ref))
    : [...refs, merged];
}

async function paymentCustomerSnapshot(
  input: CreateMikaBackendApiInput,
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
  const normalizedEmail = email?.trim().toLowerCase();
  const payerEmailHash = normalizedEmail ? await input.hash(`email:${normalizedEmail}`) : undefined;

  const customer =
    checkoutCustomer ??
    (!checkout.customerId && payerEmailHash
      ? await input.repositories.account.findCustomerByEmailHash(payerEmailHash)
      : null);

  return {
    ...((customer?.customerId ?? checkoutCustomerId)
      ? { customerId: customer?.customerId ?? checkoutCustomerId }
      : {}),
    ...(customer?.userId ? { userId: customer.userId } : {}),
    email: customer?.aggregate.email ?? email,
    emailHash: customer?.emailHash ?? customer?.aggregate.emailHash ?? payerEmailHash,
    name: event.customer?.name ?? checkoutMetadataCustomer.name,
    company: event.customer?.company ?? checkoutMetadataCustomer.company,
    vatId: event.customer?.vatId ?? checkoutMetadataCustomer.vatId,
  };
}

function paymentOrderMetadata(
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

function paymentOrderLineMetadata(line: CheckoutLine, event: MikaProviderPaymentEvent): JsonObject {
  return {
    checkoutLineId: line.id,
    ...(line.reservationId ? { reservationId: line.reservationId } : {}),
    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
  };
}

export async function markWebhookProcessedForOrder(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  order: OrderDocument,
): Promise<WebhookDocument> {
  return markWebhookProcessed(
    input,
    webhook,
    now,
    {
      relatedCustomerId: order.customerId,
      relatedOrderId: order.id,
    },
    { strict: true },
  );
}

export async function markWebhookProcessedForSubscription(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  subscription: SubscriptionDocument,
): Promise<WebhookDocument> {
  return markWebhookProcessed(input, webhook, now, {
    relatedCustomerId: subscription.customerId,
    relatedSubscriptionId: subscription.id,
  });
}

export async function markWebhookProcessed(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  related: Pick<
    WebhookDocument["record"],
    "relatedCustomerId" | "relatedOrderId" | "relatedSubscriptionId"
  >,
  options: { readonly strict?: boolean } = { strict: true },
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

  return putWebhook(input, processed, options);
}

export async function markWebhookFailed(
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  now: ISODateTime,
  lastError: string,
  options: { readonly strict?: boolean; readonly retryable?: boolean } = { strict: true },
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

  const persisted = await putWebhook(input, failed, options);
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
  input: CreateMikaBackendApiInput,
  webhook: WebhookDocument,
  options: { readonly strict?: boolean },
): Promise<WebhookDocument> {
  try {
    await input.repositories.ops.put(webhook);
  } catch (error) {
    if (options.strict) {
      throw new Error(`Webhook '${webhook.id}' status could not be persisted.`, { cause: error });
    }
    // The webhook has already been accepted; callers still receive the in-memory state.
    observeBackendError(input, "webhook.persistStatus", error, { webhookId: webhook.id });
  }

  return webhook;
}
