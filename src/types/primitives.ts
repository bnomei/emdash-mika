/**
 * Branded primitives and domain enumerations for the commerce document model.
 * Runtime constructors and type guards enforce contracts at storage and API boundaries.
 */
declare const mikaIdBrand: unique symbol;
declare const isoDateTimeBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;
declare const providerNameBrand: unique symbol;

/** Branded id for every persisted document, aggregate, and operational record. */
export type MikaId = string & { readonly [mikaIdBrand]: "MikaId" };
/** Branded ISO-8601 timestamp used for lifecycle and lease expiry fields. */
export type ISODateTime = string & { readonly [isoDateTimeBrand]: "ISODateTime" };
/** Branded ISO 4217 currency code carried on money and cart totals. */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: "CurrencyCode" };
/** Branded payment-provider identifier referenced by checkout and ledger documents. */
export type ProviderName = string & { readonly [providerNameBrand]: "ProviderName" };
/** Current schema version stamped on every aggregate payload. */
export type MikaSchemaVersion = 1;

/** Scalar JSON value accepted in metadata and resume state. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value tree stored in document metadata fields. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
/** JSON object envelope for document metadata and workflow resume state. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T/;

/** Constructs a branded id from a non-empty trimmed string. */
export function createMikaId(value: string): MikaId {
  return nonEmptyTrimmed(value, "MikaId") as MikaId;
}

/** Constructs a branded, canonical-UTC (`Z`) ISO datetime after parse validation. */
export function createISODateTime(value: string): ISODateTime {
  const dateTime = nonEmptyTrimmed(value, "ISODateTime");
  const match = ISO_DATE_TIME_PATTERN.exec(dateTime);
  if (!match || !isValidCalendarDate(match) || Number.isNaN(Date.parse(dateTime))) {
    throw new TypeError(`Invalid ISODateTime '${value}'.`);
  }

  return new Date(dateTime).toISOString() as ISODateTime;
}

/** Constructs a branded three-letter currency code. */
export function createCurrencyCode(value: string): CurrencyCode {
  const currency = nonEmptyTrimmed(value, "CurrencyCode");
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new TypeError(`Invalid CurrencyCode '${value}'.`);
  }

  return currency as CurrencyCode;
}

/** Constructs a branded provider name from a non-empty trimmed string. */
export function createProviderName(value: string): ProviderName {
  return nonEmptyTrimmed(value, "ProviderName") as ProviderName;
}

/** Type guard for branded id shape without full construction. */
export function isMikaId(value: unknown): value is MikaId {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** Type guard for branded ISO datetime strings. */
export function isISODateTime(value: unknown): value is ISODateTime {
  const match = typeof value === "string" ? ISO_DATE_TIME_PATTERN.exec(value) : null;

  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    match !== null &&
    isValidCalendarDate(match) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Type guard for branded currency codes. */
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value);
}

/** Type guard for branded provider names. */
export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** Type guard for finite, acyclic JSON object trees. */
export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && isRecord(value);
}

/** Type guard for finite, acyclic JSON values. */
export function isJsonValue(value: unknown): value is JsonValue {
  type JsonValueFrame =
    | { readonly value: unknown; readonly depth: number }
    | { readonly leave: object };
  const stack: JsonValueFrame[] = [{ value, depth: 0 }];
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

function isValidCalendarDate(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable reference to catalog content backing a sellable. */
export interface ContentRef {
  readonly collection: string;
  readonly id: string;
  readonly locale?: string;
}

/** Monetary amount paired with a branded currency code. */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** Created and updated timestamps shared by documents and records. */
export interface Timestamped {
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Base contract for versioned aggregate payloads embedded in documents. */
export interface AggregatePayload {
  readonly schemaVersion: MikaSchemaVersion;
}

/** Checkout purchase mode for one-time payment or subscription. */
export type PurchaseMode = "payment" | "subscription";

/** Post-purchase fulfillment channel attached to a price. */
export type FulfillmentKind = "none" | "entitlement" | "download" | "license" | "external";

/** Inventory policy governing reservation and availability behavior. */
export type StockPolicy = "untracked" | "finite" | "backorder" | "manual";

/** Cart document lifecycle from open session through conversion or expiry. */
export type CartStatus = "open" | "checkout_pending" | "converted" | "abandoned" | "expired";

/** Wishlist document lifecycle for session and customer ownership. */
export type WishlistStatus = "active" | "merged" | "expired";

/** Checkout session document lifecycle through provider redirect and completion. */
export type CheckoutStatus =
  | "created"
  | "redirected"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

/** Order document payment and fulfillment lifecycle. */
export type OrderStatus =
  | "pending"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "cancelled"
  | "failed";

/** Provider-reported payment state mirrored on order documents. */
export type PaymentStatus = "unpaid" | "paid" | "refunded" | "partially_refunded" | "failed";

/** Subscription document lifecycle aligned with provider billing state. */
export type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "cancel_at_period_end"
  | "cancelled"
  | "expired";

/** Entitlement record access state for grants and revocations. */
export type EntitlementStatus = "active" | "inactive" | "revoked" | "expired";

/** Ephemeral token record lifecycle for one-time and time-bound credentials. */
export type TokenStatus = "pending" | "consumed" | "expired" | "revoked" | "superseded";

/** Purpose discriminator for ephemeral token records. */
export type TokenPurpose =
  | "magic_link"
  | "download"
  | "account_export"
  | "account_delete"
  | "admin_confirm";

/** Webhook event record ingestion and replay lifecycle. */
export type WebhookStatus =
  | "received"
  | "processing"
  | "processed"
  | "duplicate"
  | "failed"
  | "replayed";

/** Email message record delivery lifecycle with lease-backed retries. */
export type EmailStatus = "queued" | "sent" | "skipped" | "failed";

/** Stock reservation event lifecycle from hold through release or consumption. */
export type StockReservationStatus = "active" | "released" | "consumed" | "expired";

/** Reason code recorded on stock movement events for audit trails. */
export type StockMovementReason =
  | "manual_adjustment"
  | "reservation"
  | "release"
  | "sale"
  | "refund"
  | "sync";
