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

/**
 * Whether an order has reached a terminal payment lifecycle state
 * (`cancelled`, `refunded`, or `partially_refunded`). Late payment webhook
 * retries must not promote such an order back to `paid` or re-run fulfillment.
 */
export function orderIsPaymentTerminal(order: OrderDocument): boolean {
  return PAYMENT_TERMINAL_ORDER_STATUSES.has(order.status);
}

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

/** Cumulative amount already refunded for an order, from prior refund metadata. */
export function orderRefundedAmount(order: OrderDocument): number {
  const value = order.aggregate.metadata?.["refundAmount"];

  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function applyOrderRefund(
  order: OrderDocument,
  refundInput: OrderRefundInput,
  now: ISODateTime,
): OrderDocument {
  // Accumulate against prior refunds rather than comparing each refund to the
  // immutable original total. An omitted amount refunds the remaining balance.
  // Without this, an order fully refunded via successive partials stays
  // `partially_refunded` forever and `refundAmount` loses the earlier amounts.
  const priorRefunded = orderRefundedAmount(order);
  const thisRefund = refundInput.amount ?? Math.max(0, order.totalAmount - priorRefunded);
  const cumulativeRefunded = priorRefunded + thisRefund;
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

export function subscriptionStatusAfterAction(
  current: SubscriptionStatus,
  action: "cancel" | "change" | "renew",
): SubscriptionStatus {
  if (action === "cancel") return "cancel_at_period_end";
  if (action === "renew") return "active";

  return current;
}

export function subscriptionCancelAtPeriodEndAfterAction(
  current: boolean,
  action: "cancel" | "change" | "renew",
): boolean {
  if (action === "cancel") return true;
  if (action === "renew") return false;

  return current;
}
