import type { CartDTO } from "@bnomei/emdash-mika/types";

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

export function mikaTemplateStatusLabel(status: string | undefined): string {
  if (!status) return "Unknown";
  return (
    statusLabels[status] ??
    status.replaceAll("_", " ").replace(/^\w/, (value) => value.toUpperCase())
  );
}

export function mikaTemplateStatusVariant(status: string | undefined): MikaTemplateBadgeVariant {
  if (!status) return "neutral";
  if (successStatuses.has(status)) return "success";
  if (warningStatuses.has(status)) return "warning";
  if (errorStatuses.has(status)) return "error";
  return "neutral";
}

export function mikaTemplateDateLabel(isoDate: string | undefined): string {
  if (!isoDate) return "Not set";
  return new Date(isoDate).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function mikaTemplatePlural(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function mikaTemplateCartItemCount(cart: CartDTO | null | undefined): number {
  return cart?.items.reduce((total, line) => total + line.quantity, 0) ?? 0;
}
