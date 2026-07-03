/**
 * Clock, currency, and JSON-shape primitives shared across the backend modules: default currency
 * resolution, ISO timestamp helpers, and the JSON child-extraction helpers used to parse provider
 * webhook payloads and reconstruct DTOs from stored JSON.
 */
import type { MikaProviderLineItem, MikaProviderPaymentEvent } from "../../provider";
import { createCurrencyCode, createISODateTime, createMikaId } from "../../types/primitives";
import type {
  CurrencyCode,
  FulfillmentKind,
  ISODateTime,
  JsonObject,
  JsonValue,
  MikaId,
  SubscriptionStatus,
} from "../../types/primitives";
import type { MoneyDTO } from "../types";
import type { MikaBackendDefaults, MikaBackendDependencies } from "./ports";

const DEFAULT_BACKEND_CURRENCY = createCurrencyCode("EUR");

export function defaultBackendCurrency(input: {
  readonly defaults?: MikaBackendDefaults;
}): CurrencyCode {
  return input.defaults?.currency ?? DEFAULT_BACKEND_CURRENCY;
}

export function jsonObject(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  ) as JsonObject;
}

export function moneyToJson(money: MoneyDTO): JsonObject {
  return jsonObject({
    amount: money.amount,
    currency: money.currency,
  });
}

export function providerLineToJson(line: MikaProviderLineItem): JsonObject {
  return jsonObject({
    sellableId: line.sellableId,
    priceId: line.priceId,
    contentRef: jsonObject({
      collection: line.contentRef.collection,
      id: line.contentRef.id,
      locale: line.contentRef.locale,
    }),
    sku: line.sku,
    title: line.title,
    variantKey: line.variantKey,
    variantOptions: line.variantOptions?.map((option) =>
      jsonObject({
        option: option.option,
        value: option.value,
        label: option.label,
      }),
    ),
    providerProductId: line.providerProductId,
    providerPriceId: line.providerPriceId,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    currency: line.currency,
    mode: line.mode,
    fulfillmentKind: line.fulfillmentKind,
    entitlementKey: line.entitlementKey,
    metadata: line.metadata,
  });
}

export function jsonChild(input: JsonObject, key: string): JsonObject | undefined {
  const value = input[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function stringChild(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

export function metadataMikaId(metadata: JsonObject | undefined, key: string): MikaId | undefined {
  const value = metadataString(metadata, key);

  return value ? createMikaId(value) : undefined;
}

export function booleanChild(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

export function numberChild(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

export function isoChild(input: JsonObject, key: string): ISODateTime | undefined {
  const value = stringChild(input, key);
  return value ? createISODateTime(value) : undefined;
}

export function customerChild(
  input: JsonObject,
  key: string,
): MikaProviderPaymentEvent["customer"] | undefined {
  const value = jsonChild(input, key);
  if (!value) return undefined;

  return {
    email: stringChild(value, "email"),
    name: stringChild(value, "name"),
    company: stringChild(value, "company"),
    vatId: stringChild(value, "vatId"),
  };
}

function moneyChild(input: JsonObject, key: string): MoneyDTO | undefined {
  const value = jsonChild(input, key);
  const amount = value ? numberChild(value, "amount") : undefined;
  const currency = value ? stringChild(value, "currency") : undefined;
  if (amount === undefined || !currency) return undefined;

  return { amount, currency: createCurrencyCode(currency) };
}

export function totalsChild(
  input: JsonObject,
  key: string,
): MikaProviderPaymentEvent["totals"] | undefined {
  const value = jsonChild(input, key);
  if (!value) return undefined;

  return {
    subtotal: moneyChild(value, "subtotal"),
    discount: moneyChild(value, "discount"),
    tax: moneyChild(value, "tax"),
    total: moneyChild(value, "total"),
  };
}

function contentRefChild(
  input: JsonObject,
  key: string,
): MikaProviderLineItem["contentRef"] | undefined {
  const value = jsonChild(input, key);
  const collection = value ? stringChild(value, "collection") : undefined;
  const id = value ? stringChild(value, "id") : undefined;
  if (!value || !collection || !id) return undefined;

  return { collection, id, locale: stringChild(value, "locale") };
}

function variantOptionChildren(
  input: JsonObject,
  key: string,
): MikaProviderLineItem["variantOptions"] {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];

    const option = item as JsonObject;
    const optionName = stringChild(option, "option");
    const optionValue = stringChild(option, "value");
    if (!optionName || !optionValue) return [];

    return [{ option: optionName, value: optionValue, label: stringChild(option, "label") }];
  });
}

function mikaIdChild(input: JsonObject, key: string): MikaId | undefined {
  const value = stringChild(input, key);
  return value ? createMikaId(value) : undefined;
}

export function isSubscriptionStatus(value: string | undefined): value is SubscriptionStatus {
  return (
    value === "incomplete" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "cancel_at_period_end" ||
    value === "cancelled" ||
    value === "expired"
  );
}

const FULFILLMENT_KINDS = [
  "none",
  "entitlement",
  "download",
  "license",
  "external",
] as const satisfies readonly FulfillmentKind[];

type AssertAllFulfillmentKinds =
  Exclude<FulfillmentKind, (typeof FULFILLMENT_KINDS)[number]> extends never ? true : never;
const _assertAllFulfillmentKinds: AssertAllFulfillmentKinds = true;
void _assertAllFulfillmentKinds;

function isFulfillmentKind(value: string | undefined): value is FulfillmentKind {
  return value !== undefined && (FULFILLMENT_KINDS as readonly string[]).includes(value);
}

export function providerLineChildren(
  input: JsonObject,
  key: string,
): readonly MikaProviderLineItem[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];

    const line = item as JsonObject;
    const sellableId = stringChild(line, "sellableId");
    const title = stringChild(line, "title");
    const quantity = numberChild(line, "quantity");
    const unitAmount = numberChild(line, "unitAmount");
    const currency = stringChild(line, "currency");
    const mode = stringChild(line, "mode");
    const fulfillmentKind = stringChild(line, "fulfillmentKind");
    if (
      !sellableId ||
      !title ||
      quantity === undefined ||
      unitAmount === undefined ||
      !currency ||
      (mode !== "payment" && mode !== "subscription") ||
      !isFulfillmentKind(fulfillmentKind)
    ) {
      return [];
    }

    return [
      {
        sellableId: createMikaId(sellableId),
        priceId: mikaIdChild(line, "priceId"),
        contentRef: contentRefChild(line, "contentRef") ?? { collection: "", id: "" },
        sku: stringChild(line, "sku"),
        title,
        variantKey: stringChild(line, "variantKey"),
        variantOptions: variantOptionChildren(line, "variantOptions"),
        providerProductId: stringChild(line, "providerProductId"),
        providerPriceId: stringChild(line, "providerPriceId"),
        quantity,
        unitAmount,
        currency: createCurrencyCode(currency),
        mode,
        fulfillmentKind,
        entitlementKey: stringChild(line, "entitlementKey"),
        metadata: jsonChild(line, "metadata"),
      },
    ];
  });
}

export function moneyDTO(amount: number, currency: CurrencyCode): MoneyDTO {
  return { amount, currency };
}

export function currentBackendISODateTime(
  input: Pick<MikaBackendDependencies, "isoNow" | "now">,
): ISODateTime {
  return input.isoNow?.() ?? createISODateTime(input.now().toISOString());
}

export function addMilliseconds(value: ISODateTime, milliseconds: number): ISODateTime {
  return createISODateTime(new Date(Date.parse(value) + milliseconds).toISOString());
}

/**
 * Canonical pre-hash key for customer email lookups. Trims and lowercases here — backend
 * functions are host-callable without schema parsing, and webhook emails come from provider
 * events that never passed a trimming schema, so normalization cannot be left to callers.
 */
export function emailHashKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}
