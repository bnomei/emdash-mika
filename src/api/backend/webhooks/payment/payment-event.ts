/**
 * Payment event processing: paid checkouts, fulfillment workflow, and reversals.
 */
import { omitUndefined } from "../../../../internal/object";
import { type MikaProviderPaymentEvent } from "../../../../provider";
import {
  type CheckoutDocument,
  type OrderDocument,
  type WebhookDocument,
  type WorkflowDocument,
} from "../../../../types/documents";
import { createOrderId, type ISODateTime, type MikaId } from "../../../../types/primitives";
import { type MikaRequestContext } from "../../../context";
import { expireCheckoutDocument } from "../../checkout";
import { emitBackendNotification } from "../../errors";
import {
  fulfillCheckoutPaymentOrder,
  fulfillmentDocumentId,
  revokeOrderFulfillmentAccess,
  type PaymentWebhookWorkflowStep,
  type RunPaymentWebhookWorkflowStep,
} from "../../fulfillment";
import { applyOrderRefund, orderBlocksFulfillment, orderRefundedAmount } from "../../../lifecycle";
import { type MikaBackendDependencies } from "../../ports";
import { addMilliseconds, currentBackendISODateTime } from "../../shared";
import { WorkflowRunner, WorkflowRunnerLeaseLostError } from "../../workflow-runner";
import { isReplayableWebhookStatus } from "../status";
import {
  createPaymentOrderDocument,
  findExistingPaymentOrder,
  findPaymentEventCheckout,
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessedForOrder,
  persistNewPaymentOrder,
  updatePaymentOrderFromEvent,
} from "./shared";

export async function processPaymentReversalWebhook(
  input: MikaBackendDependencies,
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
      );
    }

    return markWebhookProcessed(input, webhook, ctx.now, {});
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
    );
  }
  const refundAmount =
    event.paymentStatus === "partially_refunded" && cumulativeReversed !== undefined
      ? Math.max(0, cumulativeReversed - orderRefundedAmount(order))
      : undefined;

  const updated = applyOrderRefund(
    order,
    {
      orderId: createOrderId(order.id),
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

export async function processCheckoutExpiredWebhook(
  input: MikaBackendDependencies,
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
    );
  }

  const expired = await expireCheckoutDocument(input, checkout, ctx.now);

  return markWebhookProcessed(
    input,
    webhook,
    ctx.now,
    omitUndefined({
      relatedCustomerId: expired.customerId,
    }),
  );
}

export function reversalHasStrongOrderIdentity(event: MikaProviderPaymentEvent): boolean {
  return Boolean(event.providerPaymentId || event.providerOrderId);
}

export async function emitCheckoutPaymentFailedNotification(
  input: MikaBackendDependencies,
  now: ISODateTime,
  webhook: WebhookDocument,
  event: MikaProviderPaymentEvent,
): Promise<void> {
  const checkout = await findPaymentEventCheckout(input, event);

  await emitBackendNotification(
    input,
    "checkout.payment_failed",
    now,
    omitUndefined({
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
    }),
  );
}

export async function processPaymentWebhook(
  input: MikaBackendDependencies,
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

      return fulfillAndMarkPaymentOrder(input, ctx, runWorkflowStep, webhook, order, event);
    }

    const checkout = await runWorkflowStep("link_checkout", () =>
      findPaymentEventCheckout(input, event),
    );
    if (!checkout) {
      if (event.providerSubscriptionId) {
        return runWorkflowStep("mark_webhook", () =>
          markWebhookProcessed(input, webhook, ctx.now, {}),
        );
      }
      return runWorkflowStep("mark_webhook", () =>
        markWebhookFailed(
          input,
          webhook,
          ctx.now,
          "Payment event could not be linked to a checkout.",
        ),
      );
    }

    existingOrder = await findExistingPaymentOrder(input, event, checkout.id);
    if (existingOrder) {
      const orderSource = existingOrder;
      const order = await runWorkflowStep("persist_order", () =>
        updatePaymentOrderFromEvent(input, ctx, orderSource, event),
      );

      return fulfillAndMarkPaymentOrder(
        input,
        ctx,
        runWorkflowStep,
        webhook,
        order,
        event,
        checkout,
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

    return fulfillAndMarkPaymentOrder(input, ctx, runWorkflowStep, webhook, order, event, checkout);
  });
}

/**
 * Shared tail for every processPaymentWebhook branch: fulfill the order (unless its lifecycle
 * blocks fulfillment — a refunded/cancelled replay) via the complete_checkout + fulfill_order
 * workflow steps, then record the webhook as processed. For a brand-new paid order the block check
 * is always false, so this runs the same two steps the branch used to inline.
 */
export async function fulfillAndMarkPaymentOrder(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  runWorkflowStep: RunPaymentWebhookWorkflowStep,
  webhook: WebhookDocument,
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  checkout?: CheckoutDocument,
): Promise<WebhookDocument> {
  const fulfilledOrder = orderBlocksFulfillment(order)
    ? order
    : await fulfillCheckoutPaymentOrder(input, ctx, runWorkflowStep, order, event, checkout);

  return runWorkflowStep("mark_webhook", () =>
    markWebhookProcessedForOrder(input, webhook, ctx.now, fulfilledOrder),
  );
}

export async function runPaymentWebhookWorkflow(
  input: MikaBackendDependencies,
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

export const PAYMENT_WEBHOOK_WORKFLOW_STEPS = [
  "link_checkout",
  "persist_order",
  "complete_checkout",
  "fulfill_order",
  "mark_webhook",
] as const satisfies readonly PaymentWebhookWorkflowStep[];

export async function startPaymentWebhookWorkflow(
  input: MikaBackendDependencies,
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

export function shouldForcePaymentWebhookWorkflowLease(webhook: WebhookDocument): boolean {
  return isReplayableWebhookStatus(webhook.status);
}

export function leasePaymentWebhookWorkflow(
  input: MikaBackendDependencies,
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

export function paymentWorkflowSteps(
  existing: WorkflowDocument | null,
): WorkflowDocument["record"]["steps"] {
  const existingSteps = new Map(existing?.record.steps.map((step) => [step.name, step]) ?? []);

  return PAYMENT_WEBHOOK_WORKFLOW_STEPS.map((name) => {
    const prior = existingSteps.get(name);
    return omitUndefined({
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
    });
  });
}

export function nextWorkflowAttemptAt(now: ISODateTime, workflow: WorkflowDocument): ISODateTime {
  const attempt = Math.max(1, workflow.record.attemptCount);
  const delay = Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000);

  return addMilliseconds(now, delay);
}
