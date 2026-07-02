/**
 * The MikaApiFailure shape, the `apiFailure` builder every specific error constructor composes
 * with, and the shared notification-emission/observability helpers used across every domain
 * cluster (cart, checkout, account, admin, webhooks).
 */
import { emitMikaNotification } from "../notifications";
import type {
  MikaNotificationContextMap,
  MikaNotificationIntent,
  MikaNotificationKind,
  MikaNotificationRecipientContext,
} from "../notifications";
import type { OrderDocument, SubscriptionDocument } from "../../types/documents";
import type { ISODateTime, JsonObject, MikaId } from "../../types/primitives";
import type { MikaApiResult, MikaError } from "../types";
import type { CreateMikaBackendApiInput, MikaBackendDependencies } from "./ports";

export type MikaApiFailure = Extract<MikaApiResult<never>, { readonly ok: false }>;

export function observeBackendError(
  input: Pick<MikaBackendDependencies, "onError">,
  scope: string,
  error: unknown,
  metadata?: JsonObject,
): void {
  try {
    input.onError?.({ scope, error, ...(metadata !== undefined ? { metadata } : {}) });
  } catch {
    // Observer bugs must not break the compensation path being observed.
  }
}

export async function emitBackendNotification<TKind extends MikaNotificationKind>(
  input: CreateMikaBackendApiInput,
  kind: TKind,
  occurredAt: ISODateTime,
  context: MikaNotificationContextMap[TKind],
): Promise<void> {
  await emitMikaNotification(
    input.notifications?.handle,
    {
      kind,
      occurredAt,
      context,
    } as MikaNotificationIntent,
    undefined,
    (error) => observeBackendError(input, `notification.hook.${kind}`, error),
  );
}

export function orderNotificationRecipient(order: OrderDocument): MikaNotificationRecipientContext {
  const customer = order.aggregate.customer;
  const customerId = order.customerId ?? customer.customerId;

  return {
    ...(customer.email ? { toEmail: customer.email } : {}),
    ...(customerId ? { customerId } : {}),
    ...(customer.userId ? { userId: customer.userId } : {}),
    ...(customer.emailHash ? { emailHash: customer.emailHash } : {}),
  };
}

export function subscriptionNotificationRecipient(
  subscription: SubscriptionDocument,
): MikaNotificationRecipientContext {
  const customer = subscription.aggregate.customer;
  const customerId = subscription.customerId ?? customer.customerId;

  return {
    ...(customer.email ? { toEmail: customer.email } : {}),
    ...(customerId ? { customerId } : {}),
    ...(customer.userId ? { userId: customer.userId } : {}),
    ...(customer.emailHash ? { emailHash: customer.emailHash } : {}),
  };
}

export function apiFailure(
  status: MikaApiFailure["status"],
  code: MikaError["code"],
  message: string,
  fieldErrors?: Record<string, string>,
): MikaApiFailure {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  };
}

export function tokenResult(code: MikaError["code"], message: string): MikaApiFailure {
  return apiFailure(code === "TOKEN_INVALID" ? 400 : 410, code, message);
}

export function authRequired(message: string): MikaApiFailure {
  return apiFailure(401, "AUTH_REQUIRED", message);
}

export function forbidden(message: string): MikaApiFailure {
  return apiFailure(403, "FORBIDDEN", message);
}

export function checkoutEmpty(): MikaApiFailure {
  return apiFailure(409, "CHECKOUT_EMPTY", "Checkout requires at least one cart line.");
}

export function checkoutExpired(): MikaApiFailure {
  return apiFailure(409, "CHECKOUT_EXPIRED", "Checkout cannot start from an expired cart.");
}

export function checkoutIdempotencyInProgress(): MikaApiFailure {
  return apiFailure(409, "CONFLICT", "Checkout idempotency replay is already in progress.");
}

export function checkoutIdempotencyInputMismatch(): MikaApiFailure {
  return apiFailure(409, "CONFLICT", "Checkout idempotency key was reused with different input.");
}

export function checkoutPersistenceFailed(): MikaApiFailure {
  return apiFailure(409, "CONFLICT", "Checkout could not be persisted after provider handoff.");
}

export function checkoutFailedReplay(checkoutId: MikaId): MikaApiFailure {
  return apiFailure(409, "CONFLICT", `Checkout '${checkoutId}' failed and cannot be replayed.`);
}

export function outOfStock(sellableId: MikaId): MikaApiFailure {
  return apiFailure(409, "OUT_OF_STOCK", `Sellable '${sellableId}' does not have enough stock.`);
}

export function providerUnsupportedForAction(message: string): MikaApiFailure {
  return apiFailure(409, "PROVIDER_UNSUPPORTED", message);
}

export function providerFailed(message: string): MikaApiFailure {
  return apiFailure(502, "PROVIDER_FAILED", message);
}

export function orderNotFound(orderId: MikaId): MikaApiFailure {
  return apiFailure(404, "NOT_FOUND", `Order '${orderId}' was not found.`, {
    orderId: "Order was not found.",
  });
}

export function webhookInvalid(message: string): MikaApiFailure {
  return apiFailure(400, "WEBHOOK_INVALID", message);
}

export function webhookProcessingDeferred(webhookId: MikaId): MikaApiFailure {
  return apiFailure(
    409,
    "CONFLICT",
    `Webhook '${webhookId}' is awaiting fulfillment and was not processed; retry delivery.`,
  );
}

export function adminIdempotencyInputMismatch(action: string): MikaApiFailure {
  return apiFailure(
    409,
    "CONFLICT",
    `Admin action '${action}' idempotency key was reused with different input.`,
  );
}

export function validationFailed(field: string, message: string): MikaApiFailure {
  return apiFailure(422, "VALIDATION_FAILED", "Mika input validation failed.", {
    [field]: message,
  });
}

export function sellableNotFound(sellableId: MikaId): MikaApiFailure {
  return apiFailure(404, "SELLABLE_NOT_FOUND", `Sellable '${sellableId}' was not found.`);
}

export function cartLineNotFound(lineId: MikaId): MikaApiFailure {
  return apiFailure(404, "NOT_FOUND", `Cart line '${lineId}' was not found.`, {
    lineId: "Cart line was not found.",
  });
}

export function wishlistItemNotFound(itemId: MikaId): MikaApiFailure {
  return apiFailure(404, "NOT_FOUND", `Wishlist item '${itemId}' was not found.`, {
    itemId: "Wishlist item was not found.",
  });
}

export function invalidCart(field: string, cartId: MikaId): MikaApiFailure {
  return apiFailure(404, "NOT_FOUND", `Cart '${cartId}' was not found.`, {
    [field]: "Open cart was not found.",
  });
}

export function invalidCheckout(field: string, checkoutId: MikaId): MikaApiFailure {
  return apiFailure(404, "NOT_FOUND", `Checkout '${checkoutId}' was not found.`, {
    [field]: "Checkout was not found.",
  });
}

export function invalidWishlist(field: string, wishlistId: MikaId): MikaApiFailure {
  return apiFailure(404, "NOT_FOUND", `Wishlist '${wishlistId}' was not found.`, {
    [field]: "Active wishlist was not found.",
  });
}
