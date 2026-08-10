// mika-template-version: 0.1.0
/**
 * Storefront display formatting for the copyable Astro template.
 * Maps Mika status codes to human labels, badge variants, dates, and counts.
 */
import type {
  AccountExportDTO,
  AdminActionResultDTO,
  AvailabilityStatus,
  CartDTO,
  CartQuoteStatusDTO,
  CheckoutPreviewStatusDTO,
  CheckoutStatusDTO,
  EntitlementStatus,
  OrderStatus,
  PaymentStatus,
  SubscriptionStatus,
  WebhookReceiveDTO,
} from "@bnomei/emdash-mika/types";

/** Kumo badge variant chosen from a Mika entity status. */
export type MikaTemplateBadgeVariant = "success" | "warning" | "error" | "neutral" | "secondary";

export type MikaTemplateKnownStatus =
  | AccountExportDTO["status"]
  | AdminActionResultDTO["status"]
  | AvailabilityStatus
  | CartDTO["status"]
  | CartQuoteStatusDTO
  | CheckoutPreviewStatusDTO
  | CheckoutStatusDTO
  | EntitlementStatus
  | OrderStatus
  | PaymentStatus
  | SubscriptionStatus
  | WebhookReceiveDTO["status"];

const statusLabels = {
  active: "Active",
  abandoned: "Abandoned",
  available: "In stock",
  backorder: "Backorder available",
  binding_mismatch: "Binding mismatch",
  cancel_at_period_end: "Cancels at period end",
  cancelled: "Cancelled",
  checkout_pending: "Checkout pending",
  changed: "Changed",
  completed: "Completed",
  converted: "Converted",
  created: "Created",
  duplicate: "Duplicate",
  expired: "Expired",
  failed: "Failed",
  incomplete: "Incomplete",
  inactive: "Inactive",
  low_stock: "Low stock",
  manual: "In stock",
  out_of_stock: "Out of stock",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  past_due: "Past due",
  pending: "Pending",
  queued: "Queued",
  ready: "Ready",
  received: "Received",
  redirected: "Redirected",
  requires_confirmation: "Requires confirmation",
  requires_payment_authorization: "Requires payment authorization",
  refunded: "Refunded",
  revoked: "Revoked",
  running: "Running",
  trialing: "Trialing",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
  untracked: "In stock",
  unpaid: "Unpaid",
  valid: "Valid",
} satisfies Partial<Record<MikaTemplateKnownStatus, string>>;

const statusVariants = {
  active: "success",
  abandoned: "error",
  available: "success",
  backorder: "warning",
  binding_mismatch: "error",
  cancel_at_period_end: "warning",
  cancelled: "error",
  checkout_pending: "warning",
  changed: "warning",
  completed: "success",
  converted: "success",
  created: "warning",
  duplicate: "warning",
  expired: "error",
  failed: "error",
  incomplete: "warning",
  inactive: "neutral",
  low_stock: "warning",
  manual: "secondary",
  out_of_stock: "error",
  paid: "success",
  partially_refunded: "warning",
  past_due: "warning",
  pending: "warning",
  queued: "warning",
  ready: "success",
  received: "success",
  redirected: "warning",
  requires_confirmation: "warning",
  requires_payment_authorization: "warning",
  refunded: "neutral",
  revoked: "error",
  running: "warning",
  trialing: "success",
  unavailable: "error",
  unsupported: "neutral",
  untracked: "secondary",
  unpaid: "warning",
  valid: "success",
} satisfies Partial<Record<MikaTemplateKnownStatus, MikaTemplateBadgeVariant>>;

const statusLabelsByCode: Partial<Record<string, string>> = statusLabels;
const statusVariantsByCode: Partial<Record<string, MikaTemplateBadgeVariant>> = statusVariants;

const checkoutStatusMessages = {
  created: "Checkout created.",
  pending: "Payment pending.",
  redirected: "Checkout started.",
  completed: "Order complete.",
  cancelled: "Checkout cancelled.",
  expired: "Checkout expired.",
  failed: "Checkout failed.",
  binding_mismatch: "Checkout could not be verified.",
} satisfies Record<CheckoutStatusDTO, string>;

const checkoutStatusMessagesByCode: Partial<Record<string, string>> = checkoutStatusMessages;

export type MikaTemplateStatusInput = MikaTemplateKnownStatus | (string & {});

/** Label overrides accepted by stock badges for known availability statuses. */
export type MikaTemplateAvailabilityLabels = Partial<Record<AvailabilityStatus, string>>;

/** Human-readable label for a Mika status code, with underscore fallback formatting. */
export function mikaTemplateStatusLabel(status: MikaTemplateStatusInput | undefined): string {
  if (!status) return "Unknown";
  return (
    statusLabelsByCode[status] ??
    status.replaceAll("_", " ").replace(/^\w/, (value) => value.toUpperCase())
  );
}

/** Maps a status code to a {@link MikaTemplateBadgeVariant} for Kumo badge rendering. */
export function mikaTemplateStatusVariant(
  status: MikaTemplateStatusInput | undefined,
): MikaTemplateBadgeVariant {
  if (!status) return "neutral";
  return statusVariantsByCode[status] ?? "neutral";
}

/** Buyer-facing checkout status message for the checkout return page. */
export function mikaTemplateCheckoutStatusMessage(
  status: CheckoutStatusDTO | (string & {}) | undefined,
): string {
  if (!status) return "Checkout received.";
  return checkoutStatusMessagesByCode[status] ?? "Checkout received.";
}

/** Human-readable stock label for a known availability status. */
export function mikaTemplateAvailabilityStatusLabel(
  status: AvailabilityStatus | undefined,
  labels: MikaTemplateAvailabilityLabels = {},
): string {
  const resolvedStatus = status ?? "untracked";
  return labels[resolvedStatus] ?? mikaTemplateStatusLabel(resolvedStatus);
}

/** Stock badge variant for a known availability status. */
export function mikaTemplateAvailabilityStatusVariant(
  status: AvailabilityStatus | undefined,
): MikaTemplateBadgeVariant {
  return mikaTemplateStatusVariant(status ?? "untracked");
}

/** Locale-aware short date for ISO timestamps, or "Not set" when absent. */
export function mikaTemplateDateLabel(isoDate: string | undefined): string {
  if (!isoDate) return "Not set";
  return new Date(isoDate).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Counted noun phrase, e.g. "1 item" or "3 items". */
export function mikaTemplatePlural(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Sum of line quantities across an open cart. */
export function mikaTemplateCartItemCount(cart: CartDTO | null | undefined): number {
  return cart?.items.reduce((total, line) => total + line.quantity, 0) ?? 0;
}
