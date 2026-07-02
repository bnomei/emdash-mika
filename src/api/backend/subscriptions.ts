/**
 * Subscription lifecycle: caller-initiated cancel/change/renew actions, the entitlement that
 * tracks a subscription's access grant, and the lifecycle notification emitted whenever a
 * subscription's status changes (from a caller action or a provider webhook event).
 */
import { snapshotPrice } from "../../model/builders";
import type {
  MikaProviderSubscriptionActionInput,
  MikaProviderSubscriptionEvent,
} from "../../provider";
import type { EntitlementDocument, SubscriptionDocument } from "../../types/documents";
import type { ISODateTime, JsonObject, MikaId, SubscriptionStatus } from "../../types/primitives";
import type { MikaRequestContext } from "../context";
import type { AccountDTO, MikaApiResult } from "../types";
import { accountDTOForCustomer } from "./account";
import { requireProviderFeature, runAdminProviderAction } from "./admin-audit";
import {
  authRequired,
  emitBackendNotification,
  providerUnsupportedForAction,
  subscriptionNotificationRecipient,
  validationFailed,
} from "./errors";
import { fulfillmentDocumentId } from "./fulfillment";
import { resolveAccountIdentity } from "./identity";
import {
  subscriptionCancelAtPeriodEndAfterAction,
  subscriptionStatusAfterAction,
} from "../lifecycle";
import type { CreateMikaBackendApiInput, MikaBackendRepositories } from "./ports";

export type SubscriptionActionKind = "cancel" | "change" | "renew";

export const subscriptionActionMethods = {
  cancel: "cancelSubscription",
  change: "changeSubscription",
  renew: "renewSubscription",
} as const;

export async function runSubscriptionAction(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  actionInput: { readonly subscriptionId: MikaId; readonly priceId?: MikaId },
  action: SubscriptionActionKind,
): Promise<MikaApiResult<AccountDTO>> {
  const identity = await resolveAccountIdentity(input, ctx);
  if (!identity?.customer) {
    return authRequired("Subscription changes require an authenticated customer identity.");
  }

  const subscription = await input.repositories.account.findSubscriptionById(
    actionInput.subscriptionId,
  );
  if (!subscription || subscription.customerId !== identity.customer.customerId) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        message: `Subscription '${actionInput.subscriptionId}' was not found.`,
        fieldErrors: { subscriptionId: "Subscription was not found." },
      },
    };
  }

  if (subscription.status === "cancelled" || subscription.status === "expired") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Subscription '${actionInput.subscriptionId}' is ${subscription.status} and cannot be modified.`,
        fieldErrors: { subscriptionId: `Subscription is ${subscription.status}.` },
      },
    };
  }

  const methodName = subscriptionActionMethods[action];
  const providerFeature = await requireProviderFeature(input, {
    providerName: subscription.provider,
    method: methodName,
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support subscription ${action}.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const priceMatch =
    action === "change" && actionInput.priceId
      ? await input.repositories.catalog.findPriceById(actionInput.priceId)
      : null;
  if (action === "change" && actionInput.priceId && !priceMatch) {
    return validationFailed("priceId", `Price '${actionInput.priceId}' was not found.`);
  }
  if (action === "change" && actionInput.priceId && priceMatch) {
    const current = subscription.aggregate.sellable;
    if (
      priceMatch.sellable.id !== current.sellableId ||
      priceMatch.price.mode !== "subscription" ||
      priceMatch.price.currency !== current.currency
    ) {
      return validationFailed(
        "priceId",
        `Price '${actionInput.priceId}' is not a valid change target for this subscription.`,
      );
    }
  }

  const providerPriceId =
    priceMatch?.price.providerRefs.find((ref) => ref.provider === subscription.provider)?.priceId ??
    (action === "change" ? undefined : subscription.aggregate.providerRef.priceId);
  if (action === "change" && actionInput.priceId && !providerPriceId) {
    return providerUnsupportedForAction(
      `Price '${actionInput.priceId}' is not mapped for provider '${subscription.provider}'.`,
    );
  }

  const providerSubscriptionId =
    subscription.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId;
  const providerInput: MikaProviderSubscriptionActionInput = {
    subscriptionId: subscription.id,
    ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
    ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
    ...(providerPriceId ? { providerPriceId } : {}),
  };
  const idempotencyInput: JsonObject = {
    subscriptionId: actionInput.subscriptionId,
    ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
  };

  return runAdminProviderAction(
    input,
    {
      action: `subscription.${action}`,
      targetType: "subscription",
      targetId: subscription.id,
      idempotencyKey: ctx.idempotencyKey,
      idempotencyInput,
      metadata: {
        provider: subscription.provider,
        subscriptionId: subscription.id,
        ...(providerSubscriptionId ? { providerSubscriptionId } : {}),
        ...(actionInput.priceId ? { priceId: actionInput.priceId } : {}),
        ...(providerPriceId ? { providerPriceId } : {}),
      },
    },
    async () => {
      const result = await providerFeature.method.call(providerFeature.provider, providerInput);
      if (result.status !== "completed") {
        throw new Error(
          result.message ??
            `Provider subscription ${action} did not complete (status: ${result.status}).`,
        );
      }

      await updateSubscriptionAfterAction(input, ctx, subscription, action, priceMatch);

      return accountDTOForCustomer(input, ctx, identity.customer);
    },
    `Provider subscription ${action} failed.`,
  );
}

export async function updateSubscriptionAfterAction(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
  action: SubscriptionActionKind,
  priceMatch: Awaited<ReturnType<MikaBackendRepositories["catalog"]["findPriceById"]>>,
): Promise<SubscriptionDocument> {
  const providerPriceId = priceMatch?.price.providerRefs.find(
    (ref) => ref.provider === subscription.provider,
  )?.priceId;
  const changedSellable = priceMatch
    ? snapshotPrice({
        content: priceMatch.catalog.aggregate.content,
        sellable: priceMatch.sellable,
        price: priceMatch.price,
        fallbackTitle: priceMatch.catalog.titleSnapshot ?? priceMatch.sellable.id,
      })
    : subscription.aggregate.sellable;
  const status = subscriptionStatusAfterAction(subscription.status, action);
  const cancelAtPeriodEnd = subscriptionCancelAtPeriodEndAfterAction(
    subscription.aggregate.cancelAtPeriodEnd,
    action,
  );
  const updated: SubscriptionDocument = {
    ...subscription,
    status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      sellable: changedSellable,
      providerRef: {
        ...subscription.aggregate.providerRef,
        ...(providerPriceId ? { priceId: providerPriceId } : {}),
      },
      status,
      cancelAtPeriodEnd,
      metadata: {
        ...subscription.aggregate.metadata,
        lastAdminAction: `subscription.${action}`,
      },
    },
  };

  await input.repositories.account.put(updated);
  const fulfilled = await updateSubscriptionEntitlement(input, ctx, updated);
  await emitSubscriptionLifecycleNotification(input, ctx.now, fulfilled, {
    previous: subscription,
  });

  return fulfilled;
}

export async function updateSubscriptionEntitlement(
  input: CreateMikaBackendApiInput,
  ctx: MikaRequestContext,
  subscription: SubscriptionDocument,
): Promise<SubscriptionDocument> {
  if (subscription.aggregate.sellable.fulfillmentKind !== "entitlement") return subscription;

  const entitlementId =
    subscription.aggregate.entitlementId ??
    fulfillmentDocumentId("entitlement", subscription.id, "subscription");
  const existing = await input.repositories.account.findEntitlementById(entitlementId);
  const status =
    existing?.status === "revoked"
      ? existing.status
      : entitlementStatusForSubscription(subscription.status);
  const record = {
    id: entitlementId,
    customerId: subscription.customerId ?? subscription.aggregate.customer.customerId,
    userId: subscription.aggregate.customer.userId,
    emailHash: subscription.aggregate.customer.emailHash,
    entitlementKey:
      subscription.aggregate.sellable.entitlementKey ??
      subscriptionSellableContentKey(subscription),
    contentCollection: subscription.aggregate.sellable.content.collection,
    contentId: subscription.aggregate.sellable.content.id,
    sellableId: subscription.aggregate.sellable.sellableId,
    subscriptionId: subscription.id,
    status,
    sourceStatus: subscription.status,
    currentPeriodEnd: subscription.aggregate.currentPeriodEnd,
    grantedAt: existing?.record.grantedAt ?? ctx.now,
    metadata: {
      fulfillmentKind: subscription.aggregate.sellable.fulfillmentKind,
      ...(subscription.providerSubscriptionId
        ? { providerSubscriptionId: subscription.providerSubscriptionId }
        : {}),
    },
  };
  const entitlement: EntitlementDocument = {
    id: entitlementId,
    type: "entitlement",
    schemaVersion: 1,
    customerId: record.customerId,
    userId: record.userId,
    emailHash: record.emailHash,
    entitlementKey: record.entitlementKey,
    status: record.status,
    subscriptionId: record.subscriptionId,
    record,
    createdAt: existing?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
  };

  await input.repositories.account.put(entitlement);

  if (subscription.aggregate.entitlementId === entitlementId) return subscription;

  const updated: SubscriptionDocument = {
    ...subscription,
    updatedAt: ctx.now,
    aggregate: {
      ...subscription.aggregate,
      entitlementId,
    },
  };
  await input.repositories.account.put(updated);

  return updated;
}

export async function emitSubscriptionLifecycleNotification(
  input: CreateMikaBackendApiInput,
  now: ISODateTime,
  subscription: SubscriptionDocument,
  options: {
    readonly created?: boolean;
    readonly previous?: SubscriptionDocument;
    readonly event?: MikaProviderSubscriptionEvent;
  } = {},
): Promise<void> {
  const kind =
    subscription.status === "past_due"
      ? "subscription.renewal_failed"
      : options.created && (subscription.status === "active" || subscription.status === "trialing")
        ? "subscription.started"
        : "subscription.updated";

  await emitBackendNotification(input, kind, now, {
    ...subscriptionNotificationRecipient(subscription),
    subscriptionId: subscription.id,
    status: subscription.status,
    ...(options.previous?.status && options.previous.status !== subscription.status
      ? { previousStatus: options.previous.status }
      : {}),
    provider: subscription.provider,
    ...((subscription.providerCustomerId ?? subscription.aggregate.providerRef.customerId)
      ? {
          providerCustomerId:
            subscription.providerCustomerId ?? subscription.aggregate.providerRef.customerId,
        }
      : {}),
    ...((subscription.providerSubscriptionId ?? subscription.aggregate.providerRef.subscriptionId)
      ? {
          providerSubscriptionId:
            subscription.providerSubscriptionId ??
            subscription.aggregate.providerRef.subscriptionId,
        }
      : {}),
    ...(subscription.aggregate.providerRef.priceId
      ? { providerPriceId: subscription.aggregate.providerRef.priceId }
      : {}),
    ...((subscription.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd)
      ? {
          currentPeriodEnd:
            subscription.currentPeriodEnd ?? subscription.aggregate.currentPeriodEnd,
        }
      : {}),
    cancelAtPeriodEnd: subscription.aggregate.cancelAtPeriodEnd,
    sellableId: subscription.aggregate.sellable.sellableId,
    title: subscription.aggregate.sellable.titleSnapshot,
    ...(subscription.aggregate.entitlementId
      ? { entitlementId: subscription.aggregate.entitlementId }
      : {}),
    ...(options.event?.type ? { eventType: options.event.type } : {}),
  });
}

export function entitlementStatusForSubscription(
  status: SubscriptionStatus,
): EntitlementDocument["status"] {
  switch (status) {
    case "active":
    case "trialing":
    case "cancel_at_period_end":
    case "past_due":
      return "active";
    case "cancelled":
    case "expired":
      return "expired";
    case "incomplete":
      return "inactive";
  }
}

export function subscriptionSellableContentKey(subscription: SubscriptionDocument): string {
  const content = subscription.aggregate.sellable.content;
  return `${content.collection}:${content.id}`;
}
