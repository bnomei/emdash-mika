/**
 * Stripe subscription lifecycle, refund, and order cancel actions.
 */
import type { AdminActionResultDTO } from "../api/types";
import type {
  MikaProviderOrderCancelInput,
  MikaProviderRefundInput,
  MikaProviderSubscriptionActionInput,
} from "../provider";
import { createMikaId } from "../types/primitives";
import type { CreateMikaStripeProviderOptions } from "./types";
import {
  completedAction,
  failedAction,
  requestOptions,
  stringChild,
  stripeActionErrorMessage,
  stripeMetadata,
  stripeRefundActionStatus,
  unsupportedAction,
} from "./helpers";

export async function changeStripeSubscription(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderSubscriptionActionInput,
): Promise<AdminActionResultDTO> {
  if (!options.stripe.subscriptions || !input.providerSubscriptionId || !input.providerPriceId) {
    return unsupportedAction(
      "subscription_change",
      "Stripe subscription id and price id are required.",
    );
  }

  try {
    const metadata = stripeMetadata(input.metadata);
    const subscription = await options.stripe.subscriptions.update(
      input.providerSubscriptionId,
      {
        cancel_at_period_end: false,
        items: [{ price: input.providerPriceId }],
        ...(metadata ? { metadata } : {}),
      },
      requestOptions(input.metadata ? stringChild(input.metadata, "idempotencyKey") : undefined),
    );

    return completedAction(
      "subscription_change",
      `Stripe subscription ${subscription.id} updated.`,
    );
  } catch (error) {
    return failedAction("subscription_change", stripeActionErrorMessage(error));
  }
}

export async function renewStripeSubscription(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderSubscriptionActionInput,
): Promise<AdminActionResultDTO> {
  if (!options.stripe.subscriptions || !input.providerSubscriptionId) {
    return unsupportedAction("subscription_renew", "Stripe subscription id is required.");
  }

  try {
    const subscription = options.stripe.subscriptions.resume
      ? await options.stripe.subscriptions.resume(input.providerSubscriptionId)
      : await options.stripe.subscriptions.update(input.providerSubscriptionId, {
          cancel_at_period_end: false,
        });

    return completedAction("subscription_renew", `Stripe subscription ${subscription.id} renewed.`);
  } catch (error) {
    return failedAction("subscription_renew", stripeActionErrorMessage(error));
  }
}

export async function refundStripePayment(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderRefundInput,
): Promise<AdminActionResultDTO> {
  if (!options.stripe.refunds || !input.providerPaymentId) {
    return unsupportedAction("refund", "Stripe payment intent id is required.");
  }

  try {
    const refund = await options.stripe.refunds.create(
      {
        payment_intent: input.providerPaymentId,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      requestOptions(input.idempotencyKey ? `${input.idempotencyKey}_refund` : undefined),
    );

    return {
      id: createMikaId(refund.id),
      status: stripeRefundActionStatus(refund.status),
    };
  } catch (error) {
    return failedAction("refund", stripeActionErrorMessage(error));
  }
}

export async function cancelStripeOrder(
  options: CreateMikaStripeProviderOptions,
  input: MikaProviderOrderCancelInput,
): Promise<AdminActionResultDTO> {
  const paymentIntentId = input.providerPaymentId ?? input.providerOrderId;
  if (!options.stripe.paymentIntents?.cancel || !paymentIntentId) {
    return unsupportedAction(
      "order_cancel",
      "Stripe payment intent cancellation is not available.",
    );
  }

  try {
    const intent = await options.stripe.paymentIntents.cancel(
      paymentIntentId,
      input.reason ? { cancellation_reason: input.reason } : {},
    );

    return {
      id: createMikaId(intent.id),
      status: intent.status === "canceled" ? "completed" : "running",
    };
  } catch (error) {
    return failedAction("order_cancel", stripeActionErrorMessage(error));
  }
}
