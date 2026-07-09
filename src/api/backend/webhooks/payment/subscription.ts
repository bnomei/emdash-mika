/**
 * Subscription webhook ingestion and entitlement updates.
 */
import { createSubscriptionAggregate, snapshotPrice } from "../../../../model/builders";
import { omitUndefined, optionalProperty } from "../../../../internal/object";
import { type MikaProviderSubscriptionEvent } from "../../../../provider";
import { type CustomerSnapshot } from "../../../../types/aggregates";
import { type SubscriptionDocument, type WebhookDocument } from "../../../../types/documents";
import { type JsonObject, type MikaId } from "../../../../types/primitives";
import { type MikaRequestContext } from "../../../context";
import { isAnonymizedCustomer } from "../../identity";
import { type MikaBackendDependencies } from "../../ports";
import {
  emitSubscriptionLifecycleNotification,
  updateSubscriptionEntitlement,
} from "../../subscriptions";
import {
  markWebhookFailed,
  markWebhookProcessed,
  markWebhookProcessedForSubscription,
} from "./shared";

export async function processSubscriptionWebhook(
  input: MikaBackendDependencies,
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
  await emitSubscriptionLifecycleNotification(
    input,
    ctx.now,
    fulfilled,
    omitUndefined({
      event,
      previous,
      created: resolved.created,
    }),
  );

  return markWebhookProcessedForSubscription(input, webhook, ctx.now, fulfilled);
}

export type SubscriptionFromEventResult =
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

export async function findOrCreateSubscriptionFromEvent(
  input: MikaBackendDependencies,
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
  const customerSnapshot: CustomerSnapshot = omitUndefined({
    customerId: providerAccount.customerId,
    userId: customer?.userId,
    email: customer?.aggregate.email ?? providerAccount.record.emailSnapshot,
    emailHash: customer?.emailHash ?? customer?.aggregate.emailHash,
    name: customer?.aggregate.name,
    company: customer?.aggregate.company,
    vatId: customer?.aggregate.vatId,
  });
  const subscriptionId = input.createId("subscription");
  const aggregate = createSubscriptionAggregate(
    omitUndefined({
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
    }),
  );

  return {
    kind: "subscription",
    subscription: omitUndefined({
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
    }),
    created: true,
  };
}

export function subscriptionEventIsStale(
  subscription: SubscriptionDocument,
  event: MikaProviderSubscriptionEvent,
): boolean {
  const appliedStart = subscription.aggregate.currentPeriodStart;
  const eventStart = event.currentPeriodStart;
  if (!appliedStart || !eventStart) return false;

  return new Date(eventStart).getTime() < new Date(appliedStart).getTime();
}

export async function updateSubscriptionFromEvent(
  input: MikaBackendDependencies,
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
    ...optionalProperty(
      "providerCustomerId",
      event.providerCustomerId ?? subscription.providerCustomerId,
    ),
    ...optionalProperty(
      "providerSubscriptionId",
      event.providerSubscriptionId ?? subscription.providerSubscriptionId,
    ),
    status,
    ...optionalProperty(
      "currentPeriodEnd",
      event.currentPeriodEnd ?? subscription.currentPeriodEnd,
    ),
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      providerRef: omitUndefined({
        ...subscription.aggregate.providerRef,
        provider: event.provider,
        subscriptionId:
          event.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId,
        customerId: event.providerCustomerId ?? subscription.aggregate.providerRef.customerId,
        priceId: event.providerPriceId ?? subscription.aggregate.providerRef.priceId,
      }),
      sellable,
      status,
      cancelAtPeriodEnd,
      ...optionalProperty(
        "currentPeriodStart",
        event.currentPeriodStart ?? subscription.aggregate.currentPeriodStart,
      ),
      ...optionalProperty(
        "currentPeriodEnd",
        event.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd,
      ),
      metadata: {
        ...subscription.aggregate.metadata,
        ...subscriptionEventMetadata(event),
      },
    },
  };

  await input.repositories.account.put(updated);

  return updated;
}

export function subscriptionEventMetadata(event: MikaProviderSubscriptionEvent): JsonObject {
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
