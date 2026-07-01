/**
 * Pure order and subscription state transitions applied after provider events and admin actions.
 * Terminal payment states are preserved across duplicate webhook delivery.
 */
import type { MikaProviderPaymentEvent } from "../provider";
import type { OrderRefundInput, OrderCancelInput } from "./types";
import type { OrderDocument } from "../types/documents";
import type {
  ISODateTime,
  OrderStatus,
  PaymentStatus,
  SubscriptionStatus,
} from "../types/primitives";

const PAYMENT_TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  "refunded",
  "partially_refunded",
  "cancelled",
]);

const FULFILLMENT_BLOCKING_ORDER_STATUSES = new Set<OrderStatus>(["refunded", "cancelled"]);

/** Whether the order has reached a non-reversible payment terminal status. */
export function orderIsPaymentTerminal(order: OrderDocument): boolean {
  return PAYMENT_TERMINAL_ORDER_STATUSES.has(order.status);
}

/** Whether fulfillment must not run for the order's current lifecycle state. */
export function orderBlocksFulfillment(order: OrderDocument): boolean {
  return FULFILLMENT_BLOCKING_ORDER_STATUSES.has(order.status);
}

/** Derives post-payment status without downgrading terminal orders. */
export function orderPaymentStatusAfterPaymentEvent(order: OrderDocument): {
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly paidAt?: ISODateTime;
} {
  if (PAYMENT_TERMINAL_ORDER_STATUSES.has(order.status)) {
    return {
      status: order.status,
      paymentStatus: order.paymentStatus,
      ...(order.paidAt ? { paidAt: order.paidAt } : {}),
    };
  }

  return {
    status: "paid",
    paymentStatus: "paid",
    ...(order.paidAt ? { paidAt: order.paidAt } : {}),
  };
}

/** Merges a verified provider payment event into an order document. */
export function applyPaymentEventToOrder(
  order: OrderDocument,
  event: MikaProviderPaymentEvent,
  now: ISODateTime,
  updates: Pick<OrderDocument["aggregate"], "providerRefs" | "metadata"> & {
    readonly invoiceUrl?: string;
  },
): OrderDocument {
  const paymentState = orderPaymentStatusAfterPaymentEvent(order);

  return {
    ...order,
    providerPaymentId: order.providerPaymentId ?? event.providerPaymentId,
    providerOrderId: order.providerOrderId ?? event.providerOrderId,
    status: paymentState.status,
    paymentStatus: paymentState.paymentStatus,
    paidAt: paymentState.paidAt ?? now,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      invoiceUrl: updates.invoiceUrl ?? order.aggregate.invoiceUrl,
      providerRefs: updates.providerRefs,
      metadata: updates.metadata,
    },
  };
}

/** Cumulative refunded amount stored in order metadata. */
export function orderRefundedAmount(order: OrderDocument): number {
  const value = order.aggregate.metadata?.["refundAmount"];

  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Applies a partial or full refund and updates payment status accordingly. */
export function applyOrderRefund(
  order: OrderDocument,
  refundInput: OrderRefundInput,
  now: ISODateTime,
): OrderDocument {
  const priorRefunded = orderRefundedAmount(order);
  const requestedRefund = refundInput.amount ?? Math.max(0, order.totalAmount - priorRefunded);
  const thisRefund = Math.max(0, requestedRefund);
  const cumulativeRefunded = Math.min(order.totalAmount, priorRefunded + thisRefund);
  const fullRefund = refundInput.amount === undefined || cumulativeRefunded >= order.totalAmount;
  const status = fullRefund ? "refunded" : "partially_refunded";

  return {
    ...order,
    status,
    paymentStatus: status,
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      metadata: {
        ...order.aggregate.metadata,
        lastAdminAction: "order.refund",
        refundAmount: cumulativeRefunded,
        ...(refundInput.reason ? { refundReason: refundInput.reason } : {}),
      },
    },
  };
}

/** Marks an order cancelled and records admin cancel metadata. */
export function applyOrderCancel(
  order: OrderDocument,
  cancelInput: OrderCancelInput,
  now: ISODateTime,
): OrderDocument {
  return {
    ...order,
    status: "cancelled",
    updatedAt: now,
    aggregate: {
      ...order.aggregate,
      metadata: {
        ...order.aggregate.metadata,
        lastAdminAction: "order.cancel",
        ...(cancelInput.reason ? { cancelReason: cancelInput.reason } : {}),
      },
    },
  };
}

/** Maps provider subscription actions to the next subscription status. */
export function subscriptionStatusAfterAction(
  current: SubscriptionStatus,
  action: "cancel" | "change" | "renew",
): SubscriptionStatus {
  if (action === "cancel") return "cancel_at_period_end";
  if (action === "renew") return "active";

  return current;
}

/** Updates cancel-at-period-end flag after a provider subscription action. */
export function subscriptionCancelAtPeriodEndAfterAction(
  current: boolean,
  action: "cancel" | "change" | "renew",
): boolean {
  if (action === "cancel") return true;
  if (action === "renew") return false;

  return current;
}
