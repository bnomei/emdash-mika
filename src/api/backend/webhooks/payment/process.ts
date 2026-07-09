/**
 * Dispatch stored webhook events by kind.
 */
import { type MikaProviderWebhookEvent } from "../../../../provider";
import { type WebhookDocument } from "../../../../types/documents";
import { type MikaRequestContext } from "../../../context";
import { type MikaBackendDependencies } from "../../ports";
import { WorkflowRunnerLeaseLostError } from "../../workflow-runner";
import {
  markWebhookFailed,
  paymentWebhookLockTarget,
  subscriptionWebhookLockTarget,
  withWebhookSubjectLock,
} from "./shared";
import {
  emitCheckoutPaymentFailedNotification,
  processCheckoutExpiredWebhook,
  processPaymentReversalWebhook,
  processPaymentWebhook,
} from "./payment-event";
import { processSubscriptionWebhook } from "./subscription";

export async function processStoredWebhook(
  input: MikaBackendDependencies,
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
          { retryable: true },
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
          { retryable: true },
        );
      }
    case "unknown":
      return webhook;
  }
}
