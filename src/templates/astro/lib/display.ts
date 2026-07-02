// mika-template-version: 0.0.0
/**
 * Storefront display formatting for the copyable Astro template.
 * Maps Mika status codes to human labels, badge variants, dates, and counts.
 */
import type { CartDTO } from "@bnomei/emdash-mika/types";

/** Kumo badge variant chosen from a Mika entity status. */
export type MikaTemplateBadgeVariant = "success" | "warning" | "error" | "neutral";

const statusLabels: Record<string, string> = {
  active: "Active",
  available: "In stock",
  backorder: "Backorder available",
  cancel_at_period_end: "Cancels at period end",
  cancelled: "Cancelled",
  completed: "Completed",
  expired: "Expired",
  failed: "Failed",
  incomplete: "Incomplete",
  inactive: "Inactive",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  past_due: "Past due",
  pending: "Pending",
  ready: "Ready",
  refunded: "Refunded",
  revoked: "Revoked",
  running: "Running",
  trialing: "Trialing",
  unpaid: "Unpaid",
};

const successStatuses = new Set(["active", "available", "completed", "paid", "ready", "trialing"]);
const warningStatuses = new Set([
  "backorder",
  "cancel_at_period_end",
  "incomplete",
  "low_stock",
  "past_due",
  "pending",
  "running",
  "unpaid",
]);
const errorStatuses = new Set(["cancelled", "expired", "failed", "out_of_stock", "revoked"]);

/** Human-readable label for a Mika status code, with underscore fallback formatting. */
export function mikaTemplateStatusLabel(status: string | undefined): string {
  if (!status) return "Unknown";
  return (
    statusLabels[status] ??
    status.replaceAll("_", " ").replace(/^\w/, (value) => value.toUpperCase())
  );
}

/** Maps a status code to a {@link MikaTemplateBadgeVariant} for Kumo badge rendering. */
export function mikaTemplateStatusVariant(status: string | undefined): MikaTemplateBadgeVariant {
  if (!status) return "neutral";
  if (successStatuses.has(status)) return "success";
  if (warningStatuses.has(status)) return "warning";
  if (errorStatuses.has(status)) return "error";
  return "neutral";
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
