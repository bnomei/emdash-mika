/**
 * Stripe adapter pure helpers: metadata, money, JSON accessors, and action results.
 */
import type { AdminActionResultDTO, CheckoutCustomerInput, MoneyDTO } from "../api/types";
import {
  createISODateTime,
  createMikaId,
  isCurrencyCode,
  type JsonObject,
  type SubscriptionStatus,
} from "../types/primitives";
import type { MikaStripeRequestOptions } from "./types";

export function stripeCustomerInput(email: string | undefined): CheckoutCustomerInput | undefined {
  return email ? { email } : undefined;
}

export function stripeInvoiceEventIsPaid(type: string, object: JsonObject): boolean {
  if (type !== "invoice.paid" && type !== "invoice.payment_succeeded") return false;
  return booleanChild(object, "paid") === true || stringChild(object, "status") === "paid";
}

export function stripeCheckoutSessionIsPaid(object: JsonObject): boolean {
  const paymentStatus = stringChild(object, "payment_status");
  return paymentStatus === "paid" || paymentStatus === "no_payment_required";
}

export function moneyTotalsFromStripeAmount(
  object: JsonObject,
): { readonly total?: MoneyDTO } | undefined {
  const amount =
    numberChild(object, "amount_total") ??
    numberChild(object, "amount_paid") ??
    numberChild(object, "amount_received") ??
    numberChild(object, "amount");
  const currency = stringChild(object, "currency")?.toUpperCase();
  if (amount === undefined || !isCurrencyCode(currency)) return undefined;

  return {
    total: {
      amount,
      currency,
    },
  };
}

export function stripeRefundActionStatus(
  status: string | null | undefined,
): AdminActionResultDTO["status"] {
  switch (status) {
    case "succeeded":
      return "completed";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "running";
  }
}

export function stripeSubscriptionStatus(status: string | undefined): SubscriptionStatus {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "unpaid":
      return "past_due";
    default:
      return "incomplete";
  }
}

export function firstSubscriptionPriceId(object: JsonObject): string | undefined {
  const items = jsonObjectChild(object, "items");
  const data = items?.["data"];
  if (!Array.isArray(data)) return undefined;
  const first = data.find(isJsonObjectLike);
  const price = jsonObjectChild(first, "price");

  return stringChild(price, "id");
}

export function requestOptions(
  idempotencyKey: string | undefined,
): MikaStripeRequestOptions | undefined {
  return idempotencyKey ? { idempotencyKey } : undefined;
}

export function stripeMetadata(input: JsonObject | undefined): Record<string, string> | undefined {
  const metadata = Object.fromEntries(
    Object.entries(input ?? {}).flatMap(([key, value]) => {
      if (value === undefined || value === null) return [];
      if (typeof value === "string") return [[key, value]];
      if (typeof value === "number" || typeof value === "boolean") return [[key, String(value)]];

      return [[key, JSON.stringify(value)]];
    }),
  );

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function stripeTimestamp(
  value: number | null | undefined,
): ReturnType<typeof createISODateTime> | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;

  return createISODateTime(new Date(value * 1000).toISOString());
}

export function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isJsonObjectLike(value)) return stringChild(value, "id");

  return undefined;
}

export function stripeRaw(input: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(input)) as JsonObject;
}

export function requiredString(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`${label} is missing.`);

  return value;
}

export function completedAction(id: string, message?: string): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "completed",
    ...(message ? { message } : {}),
  };
}

export function unsupportedAction(
  id: string,
  message = "Stripe action is not supported.",
): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "unsupported",
    message,
  };
}

export function failedAction(id: string, message: string): AdminActionResultDTO {
  return {
    id: createMikaId(id),
    status: "failed",
    message,
  };
}

export function stripeActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Stripe action failed.";
}

export function stringChild(input: JsonObject | undefined, key: string): string | undefined {
  const value = input?.[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberChild(input: JsonObject | undefined, key: string): number | undefined {
  const value = input?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanChild(input: JsonObject | undefined, key: string): boolean | undefined {
  const value = input?.[key];

  return typeof value === "boolean" ? value : undefined;
}

export function jsonObjectChild(
  input: JsonObject | undefined | null,
  key: string,
): JsonObject | undefined {
  const value = input?.[key];

  return isJsonObjectLike(value) ? value : undefined;
}

export function isJsonObjectLike(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
