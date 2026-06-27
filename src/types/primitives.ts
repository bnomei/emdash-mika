declare const mikaIdBrand: unique symbol;
declare const isoDateTimeBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;
declare const providerNameBrand: unique symbol;

export type MikaId = string & { readonly [mikaIdBrand]: "MikaId" };
export type ISODateTime = string & { readonly [isoDateTimeBrand]: "ISODateTime" };
export type CurrencyCode = string & { readonly [currencyCodeBrand]: "CurrencyCode" };
export type ProviderName = string & { readonly [providerNameBrand]: "ProviderName" };
export type MikaSchemaVersion = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

export function createMikaId(value: string): MikaId {
  return nonEmptyTrimmed(value, "MikaId") as MikaId;
}

export function createISODateTime(value: string): ISODateTime {
  const dateTime = nonEmptyTrimmed(value, "ISODateTime");
  if (!ISO_DATE_TIME_PATTERN.test(dateTime) || Number.isNaN(Date.parse(dateTime))) {
    throw new TypeError(`Invalid ISODateTime '${value}'.`);
  }

  return dateTime as ISODateTime;
}

export function createCurrencyCode(value: string): CurrencyCode {
  const currency = nonEmptyTrimmed(value, "CurrencyCode");
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new TypeError(`Invalid CurrencyCode '${value}'.`);
  }

  return currency as CurrencyCode;
}

export function createProviderName(value: string): ProviderName {
  return nonEmptyTrimmed(value, "ProviderName") as ProviderName;
}

export function isMikaId(value: unknown): value is MikaId {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isISODateTime(value: unknown): value is ISODateTime {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    ISO_DATE_TIME_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value);
}

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && isRecord(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  // DFS frame: a value to inspect, or a "leave" marker that pops an object off
  // the active path once its whole subtree has been traversed.
  type JsonValueFrame =
    | { readonly value: unknown; readonly depth: number }
    | { readonly leave: object };
  const stack: JsonValueFrame[] = [{ value, depth: 0 }];
  // Objects on the CURRENT DFS path only. Tracking the path (not a monotonic
  // global set) detects true cycles while still accepting a shared, non-cyclic
  // reference (the same object under two keys/indices), which is valid JSON.
  const path = new Set<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if ("leave" in current) {
      path.delete(current.leave);
      continue;
    }
    nodes += 1;
    // Node/depth caps bound traversal for DoS protection, including the
    // exponential expansion a deeply shared (diamond) DAG could otherwise cause.
    if (nodes > 10_000 || current.depth > 32) return false;

    const currentValue = current.value;
    if (currentValue === null) continue;

    switch (typeof currentValue) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(currentValue)) return false;
        continue;
      case "object": {
        if (path.has(currentValue)) return false;
        const children = Array.isArray(currentValue)
          ? currentValue
          : isRecord(currentValue)
            ? Object.values(currentValue)
            : null;
        if (!children) return false;
        path.add(currentValue);
        // LIFO: the leave marker is processed after all children below, so the
        // object stays on the path for the duration of its own subtree.
        stack.push({ leave: currentValue });
        for (const child of children) {
          stack.push({ value: child, depth: current.depth + 1 });
        }
        continue;
      }
      default:
        return false;
    }
  }

  return true;
}

function nonEmptyTrimmed(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ContentRef {
  readonly collection: string;
  readonly id: string;
  readonly locale?: string;
}

export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export interface Timestamped {
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface AggregatePayload {
  readonly schemaVersion: MikaSchemaVersion;
}

export type PurchaseMode = "payment" | "subscription";

export type FulfillmentKind = "none" | "entitlement" | "download" | "license" | "external";

export type StockPolicy = "untracked" | "finite" | "backorder" | "manual";

export type CartStatus = "open" | "checkout_pending" | "converted" | "abandoned" | "expired";

export type WishlistStatus = "active" | "merged" | "expired";

export type CheckoutStatus =
  | "created"
  | "redirected"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export type OrderStatus =
  | "pending"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "cancelled"
  | "failed";

export type PaymentStatus = "unpaid" | "paid" | "refunded" | "partially_refunded" | "failed";

export type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "cancel_at_period_end"
  | "cancelled"
  | "expired";

export type EntitlementStatus = "active" | "inactive" | "revoked" | "expired";

export type TokenStatus = "pending" | "consumed" | "expired" | "revoked" | "superseded";

export type TokenPurpose =
  | "magic_link"
  | "download"
  | "account_export"
  | "account_delete"
  | "admin_confirm";

export type WebhookStatus =
  | "received"
  | "processing"
  | "processed"
  | "duplicate"
  | "failed"
  | "replayed";

export type EmailStatus = "queued" | "sent" | "skipped" | "failed";

export type StockReservationStatus = "active" | "released" | "consumed" | "expired";

export type StockMovementReason =
  | "manual_adjustment"
  | "reservation"
  | "release"
  | "sale"
  | "refund"
  | "sync";
