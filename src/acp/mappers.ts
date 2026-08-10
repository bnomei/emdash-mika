/**
 * ACP mappers: session projection, error envelopes, and response helpers.
 */
import { omitUndefined } from "../internal/object";
import type {
  CartDTO,
  CartLineDTO,
  CartQuoteLineDTO,
  CartQuoteDTO,
  CheckoutCustomerInput,
  CheckoutSessionDTO,
  MikaError,
  MikaErrorCode,
  MikaApiResult,
  MoneyDTO,
} from "../api/types";
import {
  createCurrencyCode,
  createISODateTime,
  createPriceId,
  createSellableId,
  type ISODateTime,
  type FulfillmentKind,
  type PriceId,
  type ProviderName,
  type SellableId,
} from "../types/primitives";
import type {
  MikaAcpBuyer,
  MikaAcpCheckoutSessionStatus,
  MikaAcpFulfillmentOption,
  MikaAcpLineItem,
  MikaAcpMessage,
  MikaAcpSessionRecord,
  MikaAcpSessionSnapshot,
  MikaAcpTotal,
} from "../api/acp-session";
import type {
  CreateMikaAcpCheckoutHandlersOptions,
  MikaAcpCheckoutLink,
  MikaAcpCheckoutSession,
  MikaAcpError,
  MikaAcpLink,
  MikaAcpPaymentProvider,
  MikaAcpSeller,
} from "./types";
import { MIKA_ACP_API_VERSION } from "./constants";

export function acpSessionSnapshotFromQuote(
  record: MikaAcpSessionRecord,
  quote: CartQuoteDTO,
  capturedAt: ISODateTime,
  quoteInputHash?: string,
): MikaAcpSessionSnapshot {
  return {
    capturedAt,
    ...(quoteInputHash ? { quoteInputHash } : {}),
    currency: quote.currency.toLowerCase(),
    lineItems: quote.items.map((line, index) => acpLineItem(line, index)),
    fulfillmentOptions: fulfillmentOptions(quote),
    ...(record.fulfillmentOptionId ? { fulfillmentOptionId: record.fulfillmentOptionId } : {}),
    totals: acpTotals(quote),
    messages: acpMessages(quote),
  };
}

export function acpCheckoutSessionFromSnapshot(input: {
  readonly record: MikaAcpSessionRecord;
  readonly snapshot: MikaAcpSessionSnapshot;
  readonly status: MikaAcpCheckoutSessionStatus;
  readonly seller: MikaAcpSeller;
  readonly orderUrl?: string;
  readonly checkout?: CheckoutSessionDTO;
}): MikaAcpCheckoutSession {
  const orderId = input.checkout?.orderId ?? input.checkout?.id ?? input.record.checkoutId;

  return {
    id: input.record.id,
    ...(input.record.buyer ? { buyer: input.record.buyer } : {}),
    payment_provider: {
      provider: providerToAcp(input.record.provider),
      supported_payment_methods: ["card"],
    },
    status: input.status,
    currency: input.snapshot.currency,
    line_items: input.snapshot.lineItems,
    ...(input.record.fulfillmentAddress
      ? { fulfillment_address: input.record.fulfillmentAddress }
      : {}),
    fulfillment_options: input.snapshot.fulfillmentOptions,
    ...(input.snapshot.fulfillmentOptionId
      ? { fulfillment_option_id: input.snapshot.fulfillmentOptionId }
      : {}),
    totals: input.snapshot.totals,
    messages: input.snapshot.messages,
    links: input.seller.links.flatMap((link) => acpCheckoutLink(link)),
    ...(input.status === "completed" && orderId && input.orderUrl
      ? {
          order: {
            id: orderId,
            checkout_session_id: input.record.id,
            permalink_url: acpAbsoluteUri(input.orderUrl, "order URL"),
          },
        }
      : {}),
  };
}

/** Projects persisted session state plus Mika quote/checkout DTOs into an ACP checkout session. */
export function acpCheckoutSessionFromState(input: {
  readonly record: MikaAcpSessionRecord;
  readonly quote: CartQuoteDTO;
  readonly checkout?: CheckoutSessionDTO;
  readonly seller: MikaAcpSeller;
  readonly orderUrl?: string;
}): MikaAcpCheckoutSession {
  const status =
    input.checkout?.status === "completed" || input.record.status === "completed"
      ? "completed"
      : input.checkout?.status === "cancelled" || input.record.status === "canceled"
        ? "canceled"
        : input.record.expiredAt
          ? "not_ready_for_payment"
          : input.quote.status === "valid" || input.quote.status === "changed"
            ? "ready_for_payment"
            : "not_ready_for_payment";
  const orderId = input.checkout?.orderId ?? input.checkout?.id ?? input.record.checkoutId;

  return {
    id: input.record.id,
    ...(input.record.buyer ? { buyer: input.record.buyer } : {}),
    payment_provider: {
      provider: providerToAcp(input.record.provider),
      supported_payment_methods: ["card"],
    },
    status,
    currency: input.quote.currency.toLowerCase(),
    line_items: input.quote.items.map((line, index) => acpLineItem(line, index)),
    ...(input.record.fulfillmentAddress
      ? { fulfillment_address: input.record.fulfillmentAddress }
      : {}),
    fulfillment_options: fulfillmentOptions(input.quote),
    ...(input.record.fulfillmentOptionId
      ? { fulfillment_option_id: input.record.fulfillmentOptionId }
      : {}),
    totals: acpTotals(input.quote),
    messages: acpMessages(input.quote),
    links: input.seller.links.flatMap((link) => acpCheckoutLink(link)),
    ...(status === "completed" && orderId && input.orderUrl
      ? {
          order: {
            id: orderId,
            checkout_session_id: input.record.id,
            permalink_url: acpAbsoluteUri(input.orderUrl, "order URL"),
          },
        }
      : {}),
  };
}

export function parseAcpItemId(id: string): {
  readonly sellableId: SellableId;
  readonly priceId?: PriceId;
} {
  const [sellableId, priceId] = id.split(":");
  if (!sellableId) throw new Error("ACP item id must include a sellable id.");

  return {
    sellableId: createSellableId(sellableId),
    ...(priceId ? { priceId: createPriceId(priceId) } : {}),
  };
}

export function acpStatusFromCart(
  cart: CartDTO,
  record: MikaAcpSessionRecord,
): MikaAcpCheckoutSessionStatus {
  if (record.status === "canceled" || record.status === "completed") return record.status;
  if (cart.errors?.length) return "not_ready_for_payment";

  return "ready_for_payment";
}

export function acpLineItem(line: CartQuoteLineDTO | CartLineDTO, index: number): MikaAcpLineItem {
  const unitAmount = line.unitAmount?.amount ?? 0;
  const subtotal = line.subtotal?.amount ?? unitAmount * line.quantity;
  const total = line.total?.amount ?? subtotal;

  return {
    id: "id" in line && line.id ? line.id : `line_item_${index + 1}`,
    item: {
      id: line.priceId ? `${line.sellableId}:${line.priceId}` : line.sellableId,
      quantity: line.quantity,
    },
    base_amount: unitAmount * line.quantity,
    discount: 0,
    subtotal,
    tax: 0,
    total,
  };
}

const ACP_DIGITAL_FULFILLMENT_KINDS = new Set<FulfillmentKind>([
  "download",
  "license",
  "entitlement",
]);

export function fulfillmentOptions(quote: CartQuoteDTO): readonly MikaAcpFulfillmentOption[] {
  const isSupportedDigitalQuote =
    quote.items.length > 0 &&
    quote.status !== "expired" &&
    quote.status !== "unavailable" &&
    !quote.errors?.length &&
    quote.items.every(
      (line) =>
        line.fulfillmentKind !== undefined &&
        ACP_DIGITAL_FULFILLMENT_KINDS.has(line.fulfillmentKind),
    );

  return isSupportedDigitalQuote
    ? [
        {
          type: "digital",
          id: "digital_delivery",
          title: "Digital delivery",
          subtitle: "Delivered by the merchant after payment confirmation.",
          subtotal: quote.shipping?.amount ?? 0,
          tax: 0,
          total: quote.shipping?.amount ?? 0,
        },
      ]
    : [];
}

export function acpTotals(quote: CartQuoteDTO): readonly MikaAcpTotal[] {
  return [
    {
      type: "items_base_amount",
      display_text: "Item(s) total",
      amount: quote.subtotal.amount,
    },
    {
      type: "subtotal",
      display_text: "Subtotal",
      amount: quote.subtotal.amount,
    },
    ...(quote.discount
      ? [{ type: "discount" as const, display_text: "Discount", amount: quote.discount.amount }]
      : []),
    ...(quote.shipping
      ? [
          {
            type: "fulfillment" as const,
            display_text: "Fulfillment",
            amount: quote.shipping.amount,
          },
        ]
      : []),
    ...(quote.tax ? [{ type: "tax" as const, display_text: "Tax", amount: quote.tax.amount }] : []),
    {
      type: "total",
      display_text: "Total",
      amount: quote.total.amount,
    },
  ];
}

export function acpMessages(quote: CartQuoteDTO): readonly MikaAcpMessage[] {
  const warnings: MikaAcpMessage[] =
    quote.warnings?.map((content) => ({
      type: "info" as const,
      param: "$",
      content_type: "plain" as const,
      content,
    })) ?? [];
  const errors: MikaAcpMessage[] =
    quote.errors?.map((error) => ({
      type: "error" as const,
      code: error.code === "OUT_OF_STOCK" ? "out_of_stock" : "invalid",
      param: "$",
      content_type: "plain" as const,
      content: error.message,
    })) ?? [];

  return [...warnings, ...errors];
}

export function acpCheckoutLink(link: MikaAcpLink): readonly MikaAcpCheckoutLink[] {
  if (
    link.type === "terms_of_use" ||
    link.type === "privacy_policy" ||
    link.type === "seller_shop_policies"
  ) {
    return [{ type: link.type, url: acpAbsoluteUri(link.url, "seller link") }];
  }
  if (link.type === "terms_of_service") {
    return [{ type: "terms_of_use", url: acpAbsoluteUri(link.url, "seller link") }];
  }

  return [];
}

export function acpAbsoluteUri(value: string, field: string): string {
  if (!URL.canParse(value)) throw new Error(`ACP ${field} must be an absolute URI.`);

  return value;
}

export const MIKA_ACP_PAYMENT_PROVIDERS = ["stripe"] as const;

/**
 * Maps a Mika provider to the pinned ACP wire protocol's Stripe-only payment-provider union.
 * Throws for any other provider instead of silently reporting "stripe" — the wrong provider on
 * `payment_provider` would make an agent generate a shared payment token shaped for a provider
 * that isn't actually handling the charge, a payment-routing failure worse than a loud error.
 * All call sites run inside a handler that converts an unhandled throw to a generic ACP 500.
 */
export function providerToAcp(
  provider: ProviderName | undefined,
): MikaAcpPaymentProvider["provider"] {
  const value = provider as string | undefined;
  const match = MIKA_ACP_PAYMENT_PROVIDERS.find((candidate) => candidate === value);
  if (!match) {
    throw new Error(
      `ACP does not support payment provider '${value ?? "(none)"}'; expected one of ${MIKA_ACP_PAYMENT_PROVIDERS.join(", ")}.`,
    );
  }

  return match;
}

export function buyerToCustomer(
  buyer: MikaAcpBuyer | undefined,
): CheckoutCustomerInput | undefined {
  if (!buyer) return undefined;

  return omitUndefined({
    email: buyer.email,
    name: `${buyer.first_name} ${buyer.last_name}`.trim(),
  });
}

export function emptyQuote(record: MikaAcpSessionRecord): CartQuoteDTO {
  const currency = record.currency ?? createCurrencyCode("USD");
  const zero: MoneyDTO = { amount: 0, currency };

  return omitUndefined({
    cartId: record.cartId,
    status: "unavailable",
    currency,
    items: [],
    subtotal: zero,
    total: zero,
    warnings: ["Checkout session is not ready."],
  });
}

export function resultMessage(result: MikaApiResult<unknown>): string {
  return result.ok ? "OK" : result.error.message;
}

/**
 * Explicit Mika → ACP error-code allowlist. Prefer stable ACP wire codes over
 * auto-lowercasing every future {@link MikaErrorCode} (which would leak new
 * internal codes onto the ACP surface without review).
 */
export const MIKA_TO_ACP_ERROR_CODES = {
  OUT_OF_STOCK: "out_of_stock",
  STOCK_CONFLICT: "out_of_stock",
  VALIDATION_FAILED: "validation_failed",
  NOT_FOUND: "not_found",
  SELLABLE_NOT_FOUND: "sellable_not_found",
  SELLABLE_INACTIVE: "sellable_inactive",
  PRICE_INACTIVE: "price_inactive",
  VARIANT_INVALID: "variant_invalid",
  MAX_PER_ORDER_EXCEEDED: "max_per_order_exceeded",
  CHECKOUT_EMPTY: "checkout_empty",
  CHECKOUT_EXPIRED: "checkout_expired",
  CHECKOUT_BINDING_MISMATCH: "checkout_binding_mismatch",
  TOKEN_INVALID: "token_invalid",
  TOKEN_EXPIRED: "token_expired",
  TOKEN_USED: "token_used",
  DOWNLOAD_REVOKED: "download_revoked",
  WEBHOOK_INVALID: "webhook_invalid",
  AUTH_REQUIRED: "unauthorized",
  FORBIDDEN: "unauthorized",
  CSRF_INVALID: "unauthorized",
  RATE_LIMITED: "rate_limited",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  PAYMENT_PENDING: "payment_pending",
  PROVIDER_UNSUPPORTED: "provider_unsupported",
  PROVIDER_FAILED: "provider_failed",
  // Generic CAS/concurrency conflicts stay "conflict"; only explicit idempotency
  // mismatches use ACP request_not_idempotent.
  CONFLICT: "conflict",
  IDEMPOTENCY_MISMATCH: "request_not_idempotent",
  WEBHOOK_DEFERRED: "webhook_deferred",
  INTERNAL: "internal",
  NOT_IMPLEMENTED: "not_implemented",
} as const satisfies Record<MikaErrorCode, MikaAcpError["code"]>;

export function acpErrorCodeFromMika(error: MikaError): MikaAcpError["code"] {
  return MIKA_TO_ACP_ERROR_CODES[error.code];
}

export function acpErrorFromResult(
  request: Request,
  result: Extract<MikaApiResult<unknown>, { readonly ok: false }>,
  message?: string,
  paramOverride?: string,
): Response {
  const fieldName = Object.keys(result.error.fieldErrors ?? {})[0];

  return acpError(
    request,
    result.status,
    acpErrorCodeFromMika(result.error),
    message ?? result.error.message,
    paramOverride ?? (fieldName ? `$.${fieldName}` : undefined),
    omitUndefined({ retryAfter: result.error.retryAfter }),
  );
}

export function acpUnhandledFailure(request: Request): Response {
  return acpError(request, 500, "provider_failed", "ACP checkout operation failed.");
}

export function nowIso(options: CreateMikaAcpCheckoutHandlersOptions): ISODateTime {
  return createISODateTime((options.now?.() ?? new Date()).toISOString());
}

export function addMilliseconds(value: ISODateTime, milliseconds: number): ISODateTime {
  return createISODateTime(new Date(Date.parse(value) + milliseconds).toISOString());
}

export function acpJson(request: Request, body: MikaAcpCheckoutSession, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: acpResponseHeaders(request),
  });
}

export function acpError(
  request: Request,
  status: number,
  code: MikaAcpError["code"],
  message: string,
  param?: string,
  options: { readonly retryAfter?: number } = {},
): Response {
  const body: MikaAcpError = {
    type:
      code === "request_not_idempotent"
        ? "request_not_idempotent"
        : status === 503
          ? "service_unavailable"
          : status >= 500
            ? "processing_error"
            : "invalid_request",
    code,
    message,
    ...(param ? { param } : {}),
  };
  const headers = acpResponseHeaders(request);
  if (options.retryAfter !== undefined) headers.set("Retry-After", String(options.retryAfter));

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function acpResponseHeaders(request: Request): Headers {
  const headers = new Headers({
    "API-Version": MIKA_ACP_API_VERSION,
    "Content-Type": "application/json",
  });
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const requestId = request.headers.get("Request-Id");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (requestId) headers.set("Request-Id", requestId);

  return headers;
}
