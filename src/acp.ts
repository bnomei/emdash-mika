/**
 * Agentic Commerce Protocol (ACP) support: product feeds, checkout session HTTP handlers backed
 * by MikaApi cart/checkout, session storage, delegated Stripe payments, and order webhooks.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "astro/zod";

import {
  createMikaRequestContext,
  type MikaRequestContext,
  type MikaSessionAccess,
} from "./api/context";
import type {
  CartDTO,
  CartLineDTO,
  CartQuoteLineDTO,
  CartQuoteDTO,
  CheckoutCustomerInput,
  CheckoutPreviewDTO,
  CheckoutSessionDTO,
  MikaError,
  MikaErrorCode,
  MikaApiResult,
  MoneyDTO,
  SellableDTO,
  VariantOptionValueDTO,
} from "./api/types";
import type { MikaApi } from "./server";
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
} from "./provider";
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  type CurrencyCode,
  type ISODateTime,
  type MikaId,
  type ProviderName,
} from "./types/primitives";

/** ACP API version header value supported by Mika checkout handlers. */
export const MIKA_ACP_API_VERSION = "2025-09-12";

/** Default prefix for generated ACP checkout session ids. */
export const MIKA_ACP_DEFAULT_SESSION_PREFIX = "acp_checkout";

const MIKA_ACP_DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
// Must comfortably exceed the slowest handler run, including provider SDK timeouts (80s+ for
// some Stripe operations); an expired-but-live claim reopens the key to concurrent execution.
const MIKA_ACP_DEFAULT_IDEMPOTENCY_CLAIM_TTL_MS = 120_000;
const MIKA_ACP_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
// Bounds handleAcpComplete's retry past an incidental expiry write (see
// acpRecordIsOnlyIncidentallyExpired) — a handful of attempts absorbs a few bystander GETs ticking
// the lazy expiry sweep during a slow payment attempt without looping unboundedly.
const MIKA_ACP_COMPLETE_WRITE_RETRIES = 3;

/** Seller identity and policy links attached to ACP catalog products. */
export interface MikaAcpSeller {
  readonly name: string;
  readonly links: readonly MikaAcpLink[];
}

/** Typed policy or FAQ URL included in ACP seller metadata. */
export interface MikaAcpLink {
  readonly type:
    | "terms_of_use"
    | "terms_of_service"
    | "privacy_policy"
    | "refund_policy"
    | "shipping_policy"
    | "seller_shop_policies"
    | "faq";
  readonly url: string;
  readonly title?: string;
}

/** Mika sellable bundle used to build one ACP product feed entry. */
export interface MikaAcpFeedProductInput {
  readonly id: string;
  readonly title?: string;
  readonly description?: MikaAcpDescription;
  readonly url?: string;
  readonly media?: readonly MikaAcpMedia[];
  readonly seller?: MikaAcpSeller;
  readonly sellables: readonly SellableDTO[];
}

/** ACP product feed envelope with optional target country and product list. */
export interface MikaAcpProductFeed {
  readonly target_country?: string;
  readonly products: readonly MikaAcpProduct[];
}

/** Flat merchant file-upload row derived from sellables for feed ingestion. */
export interface MikaAcpFileUploadProductRow {
  readonly is_eligible_search: boolean;
  readonly is_eligible_checkout: boolean;
  readonly item_id: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly brand: string;
  readonly image_url: string;
  /** Decimal major-unit amount with ISO currency suffix (e.g. "19.99 USD"), not minor units. */
  readonly price: string;
  readonly availability: "in_stock" | "out_of_stock" | "pre_order" | "backorder";
  readonly seller_name: string;
  readonly seller_url: string;
  readonly return_policy: string;
  readonly target_countries: string;
  readonly store_country: string;
  readonly availability_date?: string;
  readonly seller_privacy_policy?: string;
  readonly seller_tos?: string;
}

/** Batch input for generating newline-delimited merchant catalog rows. */
export interface MikaAcpFileUploadRowsInput {
  readonly products: readonly MikaAcpFeedProductInput[];
  readonly brand: string;
  readonly sellerName: string;
  readonly sellerUrl: string;
  readonly returnPolicy: string;
  readonly targetCountries: readonly string[];
  readonly storeCountry: string;
  readonly checkoutEnabled?: boolean;
  readonly sellerPrivacyPolicy?: string;
  readonly sellerTos?: string;
}

/** ACP catalog product with variants projected from Mika sellables. */
export interface MikaAcpProduct {
  readonly id: string;
  readonly title?: string;
  readonly description?: MikaAcpDescription;
  readonly url?: string;
  readonly media?: readonly MikaAcpMedia[];
  readonly variants: readonly MikaAcpVariant[];
}

/** Purchasable variant with price, availability, and seller metadata. */
export interface MikaAcpVariant {
  readonly id: string;
  readonly title: string;
  readonly description?: MikaAcpDescription;
  readonly url?: string;
  readonly price?: MikaAcpPrice;
  readonly availability?: MikaAcpAvailability;
  readonly variant_options?: readonly MikaAcpVariantOption[];
  readonly media?: readonly MikaAcpMedia[];
  readonly seller?: MikaAcpSeller;
}

/** Multi-format product description (plain, HTML, or markdown). */
export interface MikaAcpDescription {
  readonly plain?: string;
  readonly html?: string;
  readonly markdown?: string;
}

/** Minor-unit price amount and ISO currency for an ACP variant. */
export interface MikaAcpPrice {
  readonly amount: number;
  readonly currency: string;
}

/** Stock and availability status for an ACP variant. */
export interface MikaAcpAvailability {
  readonly available?: boolean;
  readonly status?: "in_stock" | "backorder" | "preorder" | "out_of_stock" | "discontinued";
}

/** Named option value pairing for a sellable variant. */
export interface MikaAcpVariantOption {
  readonly name: string;
  readonly value: string;
}

/** Image or video asset URL with optional dimensions and alt text. */
export interface MikaAcpMedia {
  readonly type: "image" | "video";
  readonly url: string;
  readonly alt_text?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Structural validation failure with JSON path and message. */
export interface MikaAcpValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Persisted ACP checkout session state linking cart, checkout, buyer, and payment authorization. */
export interface MikaAcpSessionRecord {
  /** ACP checkout session id (URL path param); distinct from the Mika cart/request session. */
  readonly id: string;
  /** Isolated Mika session id used for cart and checkout API calls. */
  readonly sessionId: string;
  readonly cartId?: MikaId;
  readonly checkoutId?: MikaId;
  readonly status: MikaAcpCheckoutSessionStatus;
  readonly buyer?: MikaAcpBuyer;
  readonly items: readonly MikaAcpItem[];
  readonly fulfillmentAddress?: MikaAcpAddress;
  readonly fulfillmentOptionId?: string;
  readonly currency?: CurrencyCode;
  readonly provider?: ProviderName;
  readonly paymentAuthorizationId?: string;
  /** Hash of checkout.preview input captured at delegated-payment handoff. */
  readonly quoteInputHash?: string;
  /** Frozen quote projection paired with quoteInputHash for completion replay checks. */
  readonly quoteSnapshot?: MikaAcpSessionSnapshot;
  readonly expiresAt?: ISODateTime;
  readonly expiredAt?: ISODateTime;
  /** Scheduled purge time for terminal sessions retained after completion or cancel. */
  readonly purgeAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  /**
   * Monotonically incremented on every write. Optimistic-concurrency writes (see
   * {@link MikaAcpSessionStore.putIfUnchanged}) compare this instead of relying on the fencing
   * tokens that guard idempotency-key bookkeeping alone — those only protect the claim map, not
   * this record itself, so a handler reclaimed mid-flight could otherwise still overwrite a newer
   * write with its own stale one. Optional (not `undefined`-hostile) because records persisted
   * before this field existed have none at runtime despite any type claiming otherwise.
   */
  readonly version?: number;
}

/** Frozen ACP quote projection captured before delegated payment handoff. */
export interface MikaAcpSessionSnapshot {
  readonly capturedAt: ISODateTime;
  readonly quoteInputHash?: string;
  readonly currency: string;
  readonly lineItems: readonly MikaAcpLineItem[];
  readonly fulfillmentOptions: readonly MikaAcpFulfillmentOption[];
  readonly fulfillmentOptionId?: string;
  readonly totals: readonly MikaAcpTotal[];
  readonly messages: readonly MikaAcpMessage[];
}

/** Input for optional ACP session store cleanup. */
export interface MikaAcpSessionCleanupInput {
  readonly now: ISODateTime;
  readonly limit?: number;
  readonly terminalRetentionMs?: number;
}

/** Counts from expiring and purging ACP sessions. */
export interface MikaAcpSessionCleanupResult {
  readonly scanned: number;
  readonly expired: number;
  readonly purged: number;
  readonly hasMore: boolean;
}

/** Expiry window handed to {@link MikaAcpSessionStore.claimIdempotencyKey} for crash recovery. */
export interface MikaAcpIdempotencyLeaseWindow {
  readonly now: ISODateTime;
  readonly expiresAt: ISODateTime;
}

/** Pluggable store for ACP session records with atomic idempotency-key coordination. */
export interface MikaAcpSessionStore {
  get(id: string): Promise<MikaAcpSessionRecord | undefined>;
  /** Unconditional write, for records with no prior state to protect (only session creation). */
  put(record: MikaAcpSessionRecord): Promise<void>;
  /**
   * Optimistic-concurrency write: persists `record` only if the store's currently-stored version
   * for `record.id` still equals `expectedVersion`, and reports whether the write landed. Every
   * handler that reads a record and later writes a mutated copy of it must use this instead of
   * `put` — the idempotency-key fencing tokens above only protect the claim bookkeeping, not this
   * record, so without this a handler reclaimed mid-flight (its lease TTL expired while it was
   * merely slow, not crashed) could still silently overwrite a newer write already committed by
   * whoever reclaimed it. `expectedVersion` is `undefined` when the caller read a record persisted
   * before `version` existed, or when writing brand-new state with nothing to compare against —
   * implementations must allow the write in that case rather than always rejecting it.
   *
   * This protects the *record* from a reclaimed handler's stale write; it does not and cannot
   * prevent the reclaimed handler's own upstream side effects (e.g. handleAcpComplete's
   * checkout.start call) from having already run before it lost this race — a reclaim scenario
   * still means checkout.start executes once per handler attempt. Hosts wiring a real payment
   * provider should size `idempotencyClaimTtlMs` well above realistic handler latency to make
   * reclaims rare, and treat them as a known, bounded risk rather than one this method eliminates.
   */
  putIfUnchanged(
    record: MikaAcpSessionRecord,
    expectedVersion: number | undefined,
  ): Promise<boolean>;
  /**
   * Claim before mutating; replay returns the stored record, conflict returns the other session
   * id. Stores must treat a PENDING (unbound) claim whose `expiresAt` lies at or before
   * `lease.now` as expired and grant the new claim — otherwise a handler crash between claim and
   * bind/release leaves the key `in_progress` forever and, for the completion lock, permanently
   * bricks completion of that session. Bound keys never expire.
   *
   * A `"claimed"` result carries a `fencingToken` that must be unique to *this* claim and change
   * on every reclaim of the same key (a monotonically increasing counter is sufficient — it need
   * not be unguessable). The claim TTL is a heuristic (`idempotencyClaimTtlMs`): a handler that is
   * merely slow, not crashed, can still be running when its lease is reclaimed by a retry. Without
   * a fencing token, that original handler's later `bindIdempotencyKey`/`releaseIdempotencyKey`
   * call has no way to tell it no longer holds the key, and can silently overwrite or release the
   * reclaiming handler's in-progress or already-committed work.
   */
  claimIdempotencyKey(
    key: string,
    id: string,
    lease?: MikaAcpIdempotencyLeaseWindow,
  ): Promise<MikaAcpIdempotencyClaim>;
  /**
   * Bind after successful handler completion so replays return the committed record. `fencingToken`
   * must match the token returned by the `"claimed"` claim this bind corresponds to — stores must
   * reject (no-op) a bind whose token no longer matches the key's current claim, e.g. because the
   * original claim expired and was reclaimed by another handler in the meantime.
   */
  bindIdempotencyKey(key: string, id: string, fencingToken: string): Promise<void>;
  /**
   * Release after handler failure so the key can be retried. `fencingToken` must match the token
   * returned by the `"claimed"` claim this release corresponds to, for the same reclaim-safety
   * reason as {@link bindIdempotencyKey}.
   */
  releaseIdempotencyKey(key: string, id: string, fencingToken: string): Promise<void>;
  /**
   * Bulk-expires stale sessions and purges retained terminal ones. Implementations must apply the
   * same optimistic-concurrency discipline as {@link putIfUnchanged} to each record they mutate —
   * the in-memory reference implementation gets this for free because its whole scan-and-mutate
   * loop runs synchronously with no `await` in between, so nothing can interleave with a
   * concurrent `putIfUnchanged`, but that's an artifact of that specific implementation, not a
   * guarantee this interface provides. A host store (database-backed, possibly multi-process) that
   * bulk-updates records here without a per-record CAS reintroduces exactly the class of bug
   * `putIfUnchanged` exists to close — e.g. clobbering a session a concurrent handleAcpComplete is
   * mid-write on.
   */
  cleanupExpired?(input: MikaAcpSessionCleanupInput): Promise<MikaAcpSessionCleanupResult>;
}

/** Result of claiming an ACP idempotency key before creating or replaying a checkout session. */
export type MikaAcpIdempotencyClaim =
  | { readonly status: "claimed"; readonly fencingToken: string }
  | { readonly status: "replayed"; readonly record: MikaAcpSessionRecord }
  | { readonly status: "conflict"; readonly id: string }
  | { readonly status: "in_progress"; readonly id: string };

/** Wiring for ACP checkout HTTP handlers: MikaApi, session store, seller metadata, and auth secrets. */
export interface CreateMikaAcpCheckoutHandlersOptions {
  readonly api: MikaApi;
  readonly store: MikaAcpSessionStore;
  readonly seller: MikaAcpSeller;
  readonly provider?: ProviderName;
  /** Bearer token checked against the Authorization header; at least one auth secret is required. */
  readonly apiKey?: string;
  /** HMAC secret for Signature header verification; at least one auth secret is required. */
  readonly signatureSecret?: string;
  /** Public base URL for ACP session links returned in responses. */
  readonly baseUrl?: string | URL;
  readonly now?: () => Date;
  /** Active-session TTL applied on create and update. */
  readonly sessionTtlMs?: number;
  /** Retention window for completed or canceled sessions before purge. */
  readonly terminalRetentionMs?: number;
  /**
   * TTL for pending idempotency claims; must exceed the slowest expected handler run. After a
   * crash mid-handler, a retry with the same Idempotency-Key can re-execute once this elapses.
   */
  readonly idempotencyClaimTtlMs?: number;
  /** Generator for ACP checkout session ids; defaults to a crypto-safe id. */
  readonly createSessionId?: () => string;
  readonly orderUrl?: (input: {
    readonly checkoutId?: MikaId;
    readonly sessionId: string;
  }) => string;
  /**
   * Observer for errors the handlers swallow (unhandled throws mapped to generic 500s,
   * best-effort lease releases). Without it those failures are invisible to operators.
   * Observer throws are ignored.
   */
  readonly onError?: (context: { readonly scope: string; readonly error: unknown }) => void;
}

/** Request handlers for the ACP checkout session lifecycle (create, update, complete, get, cancel). */
export interface MikaAcpCheckoutHandlers {
  create(request: Request): Promise<Response>;
  update(request: Request, checkoutSessionId: string): Promise<Response>;
  complete(request: Request, checkoutSessionId: string): Promise<Response>;
  get(request: Request, checkoutSessionId: string): Promise<Response>;
  cancel(request: Request, checkoutSessionId: string): Promise<Response>;
}

/** Request body for creating an ACP checkout session with items. */
export interface MikaAcpCheckoutCreateRequest {
  readonly buyer?: MikaAcpBuyer;
  readonly items: readonly MikaAcpItem[];
  readonly fulfillment_address?: MikaAcpAddress;
}

/** Partial update for buyer, items, address, or fulfillment option on a checkout session. */
export interface MikaAcpCheckoutUpdateRequest {
  readonly buyer?: MikaAcpBuyer;
  readonly items?: readonly MikaAcpItem[];
  readonly fulfillment_address?: MikaAcpAddress;
  readonly fulfillment_option_id?: string;
}

/** Payment token and buyer data submitted to complete an ACP checkout session. */
export interface MikaAcpCheckoutCompleteRequest {
  readonly buyer?: MikaAcpBuyer;
  readonly payment_data: MikaAcpPaymentData;
}

/** Buyer contact fields carried through the ACP checkout session lifecycle. */
export interface MikaAcpBuyer {
  readonly name?: string;
  readonly email?: string;
  readonly phone_number?: string;
}

/** Sellable id and quantity line referenced by ACP checkout requests. */
export interface MikaAcpItem {
  readonly id: string;
  readonly quantity: number;
}

/** Structured fulfillment or billing address on ACP checkout sessions. */
export interface MikaAcpAddress {
  readonly name: string;
  readonly line_one: string;
  readonly line_two?: string;
  readonly city: string;
  readonly state: string;
  readonly country: string;
  readonly postal_code: string;
  readonly phone_number?: string;
}

/** Delegated payment token and provider submitted at checkout completion. */
export interface MikaAcpPaymentData {
  readonly token: string;
  readonly provider: "stripe" | "adyen" | "braintree";
  readonly billing_address?: MikaAcpAddress;
}

// ACP agents commonly serialize omitted optionals as explicit JSON null; accept both.
function acpOptional<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return schema.nullish().transform((value) => value ?? undefined);
}

const acpBuyerSchema = z.object({
  name: acpOptional(z.string()),
  email: acpOptional(z.string()),
  phone_number: acpOptional(z.string()),
}) satisfies z.ZodType<MikaAcpBuyer>;

const acpItemSchema = z.object({
  id: z.string().min(1),
  quantity: z.number().int().positive(),
}) satisfies z.ZodType<MikaAcpItem>;

const acpAddressSchema = z.object({
  name: z.string(),
  line_one: z.string(),
  line_two: acpOptional(z.string()),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  postal_code: z.string(),
  phone_number: acpOptional(z.string()),
}) satisfies z.ZodType<MikaAcpAddress>;

const acpPaymentDataSchema = z.object({
  token: z.string().min(1),
  provider: z.enum(["stripe", "adyen", "braintree"]),
  billing_address: acpOptional(acpAddressSchema),
}) satisfies z.ZodType<MikaAcpPaymentData>;

const acpCheckoutCreateRequestSchema = z.object({
  buyer: acpOptional(acpBuyerSchema),
  items: z.array(acpItemSchema).min(1, "items must be a non-empty array."),
  fulfillment_address: acpOptional(acpAddressSchema),
}) satisfies z.ZodType<MikaAcpCheckoutCreateRequest>;

const acpCheckoutUpdateRequestSchema = z.object({
  buyer: acpOptional(acpBuyerSchema),
  items: acpOptional(z.array(acpItemSchema).min(1, "items must be a non-empty array.")),
  fulfillment_address: acpOptional(acpAddressSchema),
  fulfillment_option_id: acpOptional(z.string().min(1)),
}) satisfies z.ZodType<MikaAcpCheckoutUpdateRequest>;

const acpCheckoutCompleteRequestSchema = z.object({
  buyer: acpOptional(acpBuyerSchema),
  payment_data: acpPaymentDataSchema,
}) satisfies z.ZodType<MikaAcpCheckoutCompleteRequest>;

/** ACP checkout session lifecycle state from cart reconciliation through payment. */
export type MikaAcpCheckoutSessionStatus =
  | "not_ready_for_payment"
  | "ready_for_payment"
  | "completed"
  | "canceled";

/** ACP checkout session response shape projected from Mika cart quote and checkout state. */
export interface MikaAcpCheckoutSession {
  readonly id: string;
  readonly buyer?: MikaAcpBuyer;
  readonly payment_provider: MikaAcpPaymentProvider;
  readonly status: MikaAcpCheckoutSessionStatus;
  readonly currency: string;
  readonly line_items: readonly MikaAcpLineItem[];
  readonly fulfillment_address?: MikaAcpAddress;
  readonly fulfillment_options: readonly MikaAcpFulfillmentOption[];
  readonly fulfillment_option_id?: string;
  readonly totals: readonly MikaAcpTotal[];
  readonly messages: readonly MikaAcpMessage[];
  readonly links: readonly MikaAcpCheckoutLink[];
  readonly order?: MikaAcpOrder;
}

/** Supported delegated payment provider and payment methods for the checkout session. */
export interface MikaAcpPaymentProvider {
  readonly provider: "stripe" | "adyen" | "braintree";
  readonly supported_payment_methods: readonly ["card"];
}

/** Quoted line with base amount, discounts, tax, and total for the checkout session. */
export interface MikaAcpLineItem {
  readonly id: string;
  readonly item: MikaAcpItem;
  readonly base_amount: number;
  readonly discount: number;
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
}

/** Digital or shipping fulfillment choice with priced subtotals. */
export type MikaAcpFulfillmentOption =
  | {
      readonly type: "digital";
      readonly id: string;
      readonly title: string;
      readonly subtitle?: string;
      readonly subtotal: number;
      readonly tax: number;
      readonly total: number;
    }
  | {
      readonly type: "shipping";
      readonly id: string;
      readonly title: string;
      readonly subtitle: string;
      readonly carrier: string;
      readonly earliest_delivery_time: string;
      readonly latest_delivery_time: string;
      readonly subtotal: number;
      readonly tax: number;
      readonly total: number;
    };

/** Labeled monetary total bucket (subtotal, tax, fulfillment, etc.) on a checkout session. */
export interface MikaAcpTotal {
  readonly type:
    | "items_base_amount"
    | "items_discount"
    | "subtotal"
    | "discount"
    | "fulfillment"
    | "tax"
    | "fee"
    | "total";
  readonly display_text: string;
  readonly amount: number;
}

/** Info or error message surfaced to the agent during checkout. */
export type MikaAcpMessage =
  | {
      readonly type: "info";
      readonly param: string;
      readonly content_type: "plain" | "markdown";
      readonly content: string;
    }
  | {
      readonly type: "error";
      readonly code:
        | "missing"
        | "invalid"
        | "out_of_stock"
        | "payment_declined"
        | "requires_sign_in"
        | "requires_3ds";
      readonly param?: string;
      readonly content_type: "plain" | "markdown";
      readonly content: string;
    };

/** Policy link exposed on the ACP checkout session response. */
export interface MikaAcpCheckoutLink {
  readonly type: "terms_of_use" | "privacy_policy" | "seller_shop_policies";
  readonly url: string;
}

/** Completed order reference with permalink returned on successful checkout. */
export interface MikaAcpOrder {
  readonly id: string;
  readonly checkout_session_id: string;
  readonly permalink_url: string;
}

/** ACP HTTP error envelope for invalid, unauthorized, or non-idempotent requests. */
export interface MikaAcpError {
  readonly type: "invalid_request";
  readonly code:
    | "request_not_idempotent"
    | "invalid_request"
    | "unauthorized"
    | "signature_invalid"
    | Lowercase<MikaErrorCode>;
  readonly message: string;
  readonly param?: string;
  readonly retry_after?: number;
}

/** ACP order webhook payload emitted after checkout completion or order status changes. */
export interface MikaAcpOrderWebhookEvent {
  readonly type: "order_created" | "order_updated";
  readonly data: {
    readonly type: "order";
    readonly checkout_session_id: string;
    readonly permalink_url: string;
    readonly status:
      | "created"
      | "manual_review"
      | "confirmed"
      | "canceled"
      | "shipped"
      | "fulfilled";
    readonly refunds: readonly {
      readonly type: "store_credit" | "original_payment";
      readonly amount: number;
    }[];
  };
}

/** Builds an ACP product feed from Mika sellables and active prices for agent discovery. */
export function createMikaAcpProductFeed(input: {
  readonly targetCountry?: string;
  readonly products: readonly MikaAcpFeedProductInput[];
}): MikaAcpProductFeed {
  return {
    ...(input.targetCountry ? { target_country: input.targetCountry } : {}),
    products: input.products.flatMap((product) => {
      const variants = product.sellables.flatMap((sellable) =>
        sellable.prices
          .filter((price) => price.active)
          .map((price) => ({
            id: `${sellable.id}:${price.id}`,
            title: priceTitle(sellable, price.id),
            ...(product.description ? { description: product.description } : {}),
            ...(product.url ? { url: product.url } : {}),
            price: {
              amount: price.amount,
              currency: price.currency,
            },
            availability: acpAvailability(sellable),
            variant_options: acpVariantOptions(sellable.variantOptions),
            ...(sellable.imageRef
              ? { media: [{ type: "image" as const, url: sellable.imageRef }] }
              : {}),
            ...(product.seller ? { seller: product.seller } : {}),
          })),
      );
      if (variants.length === 0) return [];

      return [
        {
          id: product.id,
          ...(product.title ? { title: product.title } : {}),
          ...(product.description ? { description: product.description } : {}),
          ...(product.url ? { url: product.url } : {}),
          ...(product.media ? { media: product.media } : {}),
          variants,
        },
      ];
    }),
  };
}

/**
 * Format a minor-unit amount as the merchant-feed `price` string `"<decimal> <ISO currency>"`
 * (e.g. `"12.00 EUR"`). The file-upload / Google-Merchant catalog convention is a DECIMAL major-unit
 * value, not the raw integer minor units, so divide by the currency's fraction digits — matching the
 * package's other money→string renderers (astro.ts, email.ts, ProductStructuredData.astro).
 */
function acpFeedPriceString(amount: number, currency: string): string {
  const fractionDigits =
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return `${(amount / 10 ** fractionDigits).toFixed(fractionDigits)} ${currency}`;
}

/** Flattens sellables into ACP file-upload catalog rows for merchant feed ingestion. */
export function createMikaAcpFileUploadRows(
  input: MikaAcpFileUploadRowsInput,
): readonly MikaAcpFileUploadProductRow[] {
  return input.products.flatMap((product) =>
    product.sellables.flatMap((sellable) =>
      sellable.prices
        .filter((price) => price.active)
        .map((price) => ({
          is_eligible_search: true,
          is_eligible_checkout: input.checkoutEnabled ?? false,
          item_id: `${sellable.id}:${price.id}`,
          title: priceTitle(sellable, price.id),
          description: descriptionText(product.description) || product.title || sellable.title,
          url: requiredProductField(product.url, "url"),
          brand: input.brand,
          image_url: requiredProductField(
            sellable.imageRef ?? product.media?.[0]?.url,
            "image_url",
          ),
          price: acpFeedPriceString(price.amount, price.currency),
          availability: acpFileAvailability(sellable),
          seller_name: input.sellerName,
          seller_url: input.sellerUrl,
          return_policy: input.returnPolicy,
          target_countries: input.targetCountries.join(","),
          store_country: input.storeCountry,
          ...(input.checkoutEnabled && input.sellerPrivacyPolicy
            ? { seller_privacy_policy: input.sellerPrivacyPolicy }
            : {}),
          ...(input.checkoutEnabled && input.sellerTos ? { seller_tos: input.sellerTos } : {}),
        })),
    ),
  );
}

/** Serializes ACP file-upload catalog rows to newline-delimited JSON for merchant feeds. */
export function serializeMikaAcpFileUploadRows(
  rows: readonly MikaAcpFileUploadProductRow[],
): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/** Validates an ACP product feed and returns structural issues with JSON paths. */
export function validateMikaAcpProductFeed(
  feed: MikaAcpProductFeed,
): readonly MikaAcpValidationIssue[] {
  const issues: MikaAcpValidationIssue[] = [];

  feed.products.forEach((product, productIndex) => {
    const productPath = `$.products[${productIndex}]`;
    if (!product.id) issues.push({ path: `${productPath}.id`, message: "Product id is required." });
    if (product.url) validateUrl(product.url, `${productPath}.url`, issues);
    if (!product.variants.length) {
      issues.push({
        path: `${productPath}.variants`,
        message: "At least one variant is required.",
      });
    }
    product.media?.forEach((media, mediaIndex) =>
      validateUrl(media.url, `${productPath}.media[${mediaIndex}].url`, issues),
    );

    product.variants.forEach((variant, variantIndex) => {
      const variantPath = `${productPath}.variants[${variantIndex}]`;
      if (!variant.id)
        issues.push({ path: `${variantPath}.id`, message: "Variant id is required." });
      if (!variant.title) {
        issues.push({ path: `${variantPath}.title`, message: "Variant title is required." });
      }
      if (variant.url) validateUrl(variant.url, `${variantPath}.url`, issues);
      if (variant.price && (!Number.isInteger(variant.price.amount) || variant.price.amount < 0)) {
        issues.push({
          path: `${variantPath}.price.amount`,
          message: "Price amount must be a non-negative integer.",
        });
      }
      variant.media?.forEach((media, mediaIndex) =>
        validateUrl(media.url, `${variantPath}.media[${mediaIndex}].url`, issues),
      );
      variant.seller?.links.forEach((link, linkIndex) =>
        validateUrl(link.url, `${variantPath}.seller.links[${linkIndex}].url`, issues),
      );
    });
  });

  return issues;
}

/** Serializes a validated ACP product feed to pretty-printed JSON. */
export function serializeMikaAcpProductFeed(feed: MikaAcpProductFeed): string {
  const issues = validateMikaAcpProductFeed(feed);
  if (issues.length > 0) {
    throw new Error(`ACP product feed is invalid: ${issues[0]!.path} ${issues[0]!.message}`);
  }

  return JSON.stringify(feed, null, 2);
}

/**
 * Increments an ACP session record's optimistic-concurrency version, tolerating a missing
 * `current` (a record persisted before this field existed, or a brand-new record) by treating it
 * as version 0 rather than producing NaN — which would otherwise permanently fail every
 * `putIfUnchanged` CAS check against that record from here on (NaN !== NaN).
 */
function nextAcpVersion(current: number | undefined): number {
  return (current ?? 0) + 1;
}

/** In-memory `MikaAcpSessionStore` for development and tests. */
export function createMemoryMikaAcpSessionStore(): MikaAcpSessionStore {
  const sessions = new Map<string, MikaAcpSessionRecord>();
  const idempotencyKeys = new Map<
    string,
    {
      readonly id: string;
      readonly pending: boolean;
      readonly expiresAt?: ISODateTime;
      readonly fencingToken: string;
    }
  >();
  // Monotonically increasing, not required to be unguessable — every (re)claim of a key gets a
  // fresh token, so a stale claim holder's bind/release can be told apart from the current one.
  let nextFencingToken = 0;

  return {
    async get(id) {
      return sessions.get(id);
    },
    async put(record) {
      sessions.set(record.id, record);
    },
    async putIfUnchanged(record, expectedVersion) {
      const current = sessions.get(record.id);
      if (current && current.version !== undefined && current.version !== expectedVersion) {
        return false;
      }
      sessions.set(record.id, record);

      return true;
    },
    async claimIdempotencyKey(key, id, lease) {
      const existing = idempotencyKeys.get(key);
      const existingExpired =
        existing?.pending === true &&
        existing.expiresAt !== undefined &&
        lease !== undefined &&
        new Date(existing.expiresAt).getTime() <= new Date(lease.now).getTime();
      if (existing && !existingExpired) {
        if (existing.id !== id) return { status: "conflict", id: existing.id };
        const record = sessions.get(existing.id);

        return record && !existing.pending
          ? { status: "replayed", record }
          : { status: "in_progress", id: existing.id };
      }

      nextFencingToken += 1;
      const fencingToken = String(nextFencingToken);
      idempotencyKeys.set(key, { id, pending: true, expiresAt: lease?.expiresAt, fencingToken });

      return { status: "claimed", fencingToken };
    },
    async bindIdempotencyKey(key, id, fencingToken) {
      const binding = idempotencyKeys.get(key);
      if (binding?.fencingToken !== fencingToken) return;

      idempotencyKeys.set(key, { ...binding, id, pending: false });
    },
    async releaseIdempotencyKey(key, id, fencingToken) {
      const binding = idempotencyKeys.get(key);
      if (binding?.id === id && binding.pending && binding.fencingToken === fencingToken) {
        idempotencyKeys.delete(key);
      }
    },
    async cleanupExpired(input) {
      const limit = input.limit ?? 50;
      const terminalRetentionMs =
        input.terminalRetentionMs ?? MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS;
      const records = [...sessions.values()].sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt),
      );
      let scanned = 0;
      let expired = 0;
      let purged = 0;
      const purgedIds = new Set<string>();

      for (const record of records) {
        if (scanned >= limit) break;
        scanned += 1;

        if (record.purgeAt && new Date(record.purgeAt).getTime() <= new Date(input.now).getTime()) {
          sessions.delete(record.id);
          purgedIds.add(record.id);
          purged += 1;
          continue;
        }

        if (acpRecordIsExpired(record, input.now) && !record.expiredAt) {
          sessions.set(record.id, {
            ...record,
            status: "not_ready_for_payment",
            expiredAt: input.now,
            purgeAt: addMilliseconds(input.now, terminalRetentionMs),
            updatedAt: input.now,
            version: nextAcpVersion(record.version),
          });
          expired += 1;
        }
      }

      for (const [key, binding] of idempotencyKeys) {
        if (purgedIds.has(binding.id)) idempotencyKeys.delete(key);
      }

      return {
        scanned,
        expired,
        purged,
        hasMore: records.length > scanned,
      };
    },
  };
}

/** Creates authenticated ACP checkout HTTP handlers backed by MikaApi cart and checkout ops. */
export function createMikaAcpCheckoutHandlers(
  options: CreateMikaAcpCheckoutHandlersOptions,
): MikaAcpCheckoutHandlers {
  if (!options.apiKey && !options.signatureSecret) {
    throw new Error(
      "createMikaAcpCheckoutHandlers requires an apiKey or signatureSecret; refusing to expose ACP checkout sessions without authentication.",
    );
  }
  assertAcpAtomicIdempotencyStore(options.store);

  return {
    create: async (request) =>
      safelyHandleAcpRequest(options, "create", request, () => handleAcpCreate(options, request)),
    update: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "update", request, () =>
        handleAcpUpdate(options, request, checkoutSessionId),
      ),
    complete: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "complete", request, () =>
        handleAcpComplete(options, request, checkoutSessionId),
      ),
    get: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "get", request, () =>
        handleAcpGet(options, request, checkoutSessionId),
      ),
    cancel: async (request, checkoutSessionId) =>
      safelyHandleAcpRequest(options, "cancel", request, () =>
        handleAcpCancel(options, request, checkoutSessionId),
      ),
  };
}

/** Reports a swallowed ACP failure to the host observer; never throws. */
function observeAcpError(
  options: Pick<CreateMikaAcpCheckoutHandlersOptions, "onError">,
  scope: string,
  error: unknown,
): void {
  try {
    options.onError?.({ scope, error });
  } catch {
    // Observer bugs must not break the protocol response.
  }
}

// Maps unexpected throws to a generic ACP 500 without leaking stack details.
async function safelyHandleAcpRequest(
  options: CreateMikaAcpCheckoutHandlersOptions,
  scope: string,
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    observeAcpError(options, `acp.${scope}.unhandled`, error);

    return acpUnhandledFailure(request);
  }
}

function assertAcpAtomicIdempotencyStore(store: MikaAcpSessionStore): void {
  if (
    typeof store.claimIdempotencyKey !== "function" ||
    typeof store.bindIdempotencyKey !== "function" ||
    typeof store.releaseIdempotencyKey !== "function" ||
    typeof store.putIfUnchanged !== "function"
  ) {
    throw new Error(
      "createMikaAcpCheckoutHandlers requires an ACP session store with atomic claimIdempotencyKey, bindIdempotencyKey, releaseIdempotencyKey, and putIfUnchanged methods.",
    );
  }
}

/** Factory for ACP `order_created` / `order_updated` webhook event payloads. */
export function createMikaAcpOrderWebhookEvent(input: {
  readonly checkoutSessionId: string;
  readonly permalinkUrl: string;
  readonly status?: MikaAcpOrderWebhookEvent["data"]["status"];
  readonly type?: MikaAcpOrderWebhookEvent["type"];
  readonly refunds?: MikaAcpOrderWebhookEvent["data"]["refunds"];
}): MikaAcpOrderWebhookEvent {
  return {
    type: input.type ?? "order_updated",
    data: {
      type: "order",
      checkout_session_id: input.checkoutSessionId,
      permalink_url: input.permalinkUrl,
      status: input.status ?? "confirmed",
      refunds: input.refunds ?? [],
    },
  };
}

/** Signs an ACP order webhook body with the merchant HMAC header expected by receivers. */
export async function signMikaAcpWebhook(input: {
  readonly payload: string;
  readonly secret: string;
  readonly merchantName: string;
}): Promise<Headers> {
  const signature = await hmacBase64(input.secret, input.payload);
  const headers = new Headers();
  headers.set(`${input.merchantName}-Signature`, signature);
  headers.set("Content-Type", "application/json");

  return headers;
}

async function handleAcpCreate(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  const body = await readAcpBody(request, acpCheckoutCreateRequestSchema);
  if (!body.ok) return acpError(request, 400, "invalid_request", body.message, body.path);

  const now = nowIso(options);
  // id = ACP URL session; sessionId = isolated Mika cart/checkout session.
  const session: MikaAcpSessionRecord = {
    id: options.createSessionId?.() ?? createDefaultAcpSessionId(),
    sessionId: `${MIKA_ACP_DEFAULT_SESSION_PREFIX}:${cryptoSafeId()}`,
    status: "not_ready_for_payment",
    buyer: body.data.buyer,
    items: body.data.items,
    fulfillmentAddress: body.data.fulfillment_address,
    provider: options.provider ?? createProviderName("stripe"),
    expiresAt: addMilliseconds(now, acpSessionTtlMs(options)),
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const idempotency = await beginAcpIdempotency(options, request, session.id, 201, true);
  if (!idempotency.ok) return idempotency.response;

  try {
    const reconciled = await reconcileAcpCart(options, request, session, body.data.items);
    if (!reconciled.ok) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return reconciled.response;
    }
    await options.store.put(reconciled.record);
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, reconciled.record), 201);
  } catch (error) {
    observeAcpError(options, "acp.create.unhandled", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
}

async function handleAcpUpdate(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);
  if (acpRecordIsExpired(record, nowIso(options))) return acpExpiredError(request);
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  try {
    const terminalStatus = await acpTerminalStatus(options, record);
    if (terminalStatus) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpTerminalError(request, terminalStatus, "updated");
    }

    const body = await readAcpBody(request, acpCheckoutUpdateRequestSchema);
    if (!body.ok) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(request, 400, "invalid_request", body.message, body.path);
    }

    // Item mutations are blocked once checkout.start has bound a checkoutId.
    if (record.checkoutId && body.data.items) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(
        request,
        409,
        "invalid_request",
        "Cart items cannot be changed after checkout has started.",
      );
    }

    const next: MikaAcpSessionRecord = {
      ...record,
      buyer: body.data.buyer ?? record.buyer,
      items: body.data.items ?? record.items,
      fulfillmentAddress: body.data.fulfillment_address ?? record.fulfillmentAddress,
      fulfillmentOptionId: body.data.fulfillment_option_id ?? record.fulfillmentOptionId,
      expiresAt: addMilliseconds(nowIso(options), acpSessionTtlMs(options)),
      updatedAt: nowIso(options),
      version: nextAcpVersion(record.version),
    };
    const reconciled = body.data.items
      ? await reconcileAcpCart(options, request, next, body.data.items)
      : { ok: true as const, record: next };
    if (!reconciled.ok) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return reconciled.response;
    }
    const written = await options.store.putIfUnchanged(reconciled.record, record.version);
    if (!written) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session was modified concurrently; refetch and retry the update.",
      );
    }
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, reconciled.record), 200);
  } catch (error) {
    observeAcpError(options, "acp.update.unhandled", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
}

async function handleAcpComplete(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);
  if (acpRecordIsExpired(record, nowIso(options))) return acpExpiredError(request);
  // Captured now, before any further mutation below, as the CAS baseline for this handler's own
  // writes — see the putIfUnchanged calls at the end of this function.
  const expectedVersion = record.version;
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  // Second idempotency lease serializes concurrent completion on the same session.
  let completion: MikaAcpIdempotencyBegin;
  try {
    completion = await beginAcpIdempotency(
      options,
      request,
      checkoutSessionId,
      409,
      false,
      `acp_complete_lock:${checkoutSessionId}`,
    );
  } catch (error) {
    observeAcpError(options, "acp.complete.claimCompletionLock", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
  if (!completion.ok) {
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return completion.response;
  }
  // Every exit funnels through `finally`: success paths flag the main lease for commit (so
  // Idempotency-Key replays return the committed record); all other exits release both leases.
  let commitMainLease = false;
  try {
    const terminalStatus = await acpTerminalStatus(options, record);
    if (terminalStatus === "completed") {
      commitMainLease = true;

      return acpJson(request, await recordToAcpSession(options, request, record), 200);
    }
    if (terminalStatus === "canceled") {
      return acpTerminalError(request, terminalStatus, "completed");
    }

    if (record.checkoutId) {
      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session already has a payment attempt in progress. Create a new ACP checkout session to retry payment.",
      );
    }

    const body = await readAcpBody(request, acpCheckoutCompleteRequestSchema);
    if (!body.ok) {
      return acpError(request, 400, "invalid_request", body.message, body.path);
    }
    const expectedProvider = providerToAcp(record.provider);
    if (body.data.payment_data.provider !== expectedProvider) {
      return acpError(
        request,
        400,
        "invalid_request",
        `payment_data.provider must be '${expectedProvider}' for this checkout session.`,
        "$.payment_data.provider",
      );
    }
    if (body.data.payment_data.provider !== "stripe") {
      return acpError(
        request,
        400,
        "invalid_request",
        "ACP delegated checkout currently supports Stripe shared payment tokens only.",
        "$.payment_data.provider",
      );
    }

    const customer = buyerToCustomer(body.data.buyer ?? record.buyer);
    const preview = await previewAcpCheckout(options, request, record, customer);
    if (!preview.ok) {
      return acpErrorFromResult(request, preview);
    }
    if (!preview.data.inputHash || preview.data.status !== "requires_payment_authorization") {
      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session is not ready for payment.",
      );
    }

    const proofId = `acp_payment_authorization_${cryptoSafeId()}`;
    const ctx = acpContext(options, request, record.sessionId);
    const checkout = await options.api.checkout.start(ctx, {
      cartId: record.cartId,
      provider: record.provider,
      customer,
      customFields: {
        [MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: body.data.payment_data.token,
        [MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY]: body.data.payment_data.provider,
        [MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY]: proofId,
        [MIKA_DELEGATED_PAYMENT_CHECKOUT_SESSION_ID_METADATA_KEY]: record.id,
        [MIKA_DELEGATED_PAYMENT_AUTHORIZATION_INPUT_HASH_METADATA_KEY]: preview.data.inputHash,
      },
    });
    if (!checkout.ok) {
      return acpErrorFromResult(request, checkout);
    }
    if (acpCheckoutStartTerminalStatus(checkout.data.status)) {
      // Compensating write: reflect this attempt's own terminal failure. If it loses the CAS
      // race to a genuine competing decision, someone else already moved the session forward
      // concurrently (reverting to not_ready_for_payment over their write would be wrong) —
      // report what's actually persisted instead of this attempt's now-moot terminal-failure
      // verdict. A loss to nothing more than a bystander expiry sweep isn't a real conflict and
      // is retried past, same as the final completion write below — otherwise this attempt's own
      // legitimate buyer/etc. update would be silently lost to an unrelated concurrent GET.
      const buildReverted = (version: number | undefined): MikaAcpSessionRecord => ({
        ...record,
        buyer: body.data.buyer ?? record.buyer,
        status: "not_ready_for_payment",
        updatedAt: nowIso(options),
        version: nextAcpVersion(version),
      });
      const reverted = await putAcpRecordRetryingIncidentalExpiry(
        options,
        checkoutSessionId,
        record,
        buildReverted,
      );
      if (!reverted) {
        commitMainLease = true;
        const current =
          (await options.store.get(checkoutSessionId)) ?? buildReverted(expectedVersion);

        return acpJson(request, await recordToAcpSession(options, request, current), 200);
      }

      return acpError(
        request,
        409,
        "invalid_request",
        `Checkout session is ${checkout.data.status} and cannot be completed.`,
      );
    }
    if (!preview.data.quote) {
      return acpError(
        request,
        409,
        "invalid_request",
        "Checkout session is not ready for payment.",
      );
    }

    const now = nowIso(options);

    const completedBase: Omit<MikaAcpSessionRecord, "version"> = {
      ...record,
      buyer: body.data.buyer ?? record.buyer,
      checkoutId: checkout.data.id,
      status: checkout.data.status === "completed" ? "completed" : "ready_for_payment",
      paymentAuthorizationId: proofId,
      quoteInputHash: preview.data.inputHash,
      quoteSnapshot: acpSessionSnapshotFromQuote(
        { ...record, fulfillmentOptionId: record.fulfillmentOptionId },
        preview.data.quote,
        now,
        preview.data.inputHash,
      ),
      ...(checkout.data.status === "completed"
        ? { purgeAt: addMilliseconds(now, acpTerminalRetentionMs(options)) }
        : {}),
      updatedAt: now,
    };

    // checkout.start above already happened and cannot be undone from here, so the write below
    // must land somewhere sound. A CAS loss against a genuine competing decision (another
    // completion, cancellation, or checkout attempt) means this attempt truly lost and must defer
    // to what's persisted. A CAS loss against nothing more than expireAcpRecordIfNeeded's lazy
    // sweep ticking on a bystander request (e.g. a plain GET polling this session while this
    // handler was merely slow, not crashed) isn't a real conflict — retry past it a bounded number
    // of times rather than silently discarding a successful payment.
    const buildCompleted = (version: number | undefined): MikaAcpSessionRecord => ({
      ...completedBase,
      version: nextAcpVersion(version),
    });
    const persisted = await putAcpRecordRetryingIncidentalExpiry(
      options,
      checkoutSessionId,
      record,
      buildCompleted,
    );
    commitMainLease = true;
    if (!persisted) {
      // Lost to a genuine competing decision — report whatever is actually stored instead of this
      // attempt's own now-stale computation, same as an idempotency replay. The `?? buildCompleted`
      // fallback only matters if the record vanished between the failed write and this read (e.g.
      // a concurrent purge sweep) — far-fetched given purgeAt retention is minutes-to-days by
      // default, but falling back to this attempt's own view is still strictly better than a 500
      // for a payment that, per checkout.start above, already genuinely went through.
      const current =
        (await options.store.get(checkoutSessionId)) ?? buildCompleted(expectedVersion);

      return acpJson(request, await recordToAcpSession(options, request, current), 200);
    }

    return acpJson(request, await recordToAcpSession(options, request, persisted), 200);
  } catch (error) {
    observeAcpError(options, "acp.complete.unhandled", error);

    return acpUnhandledFailure(request);
  } finally {
    if (commitMainLease) {
      try {
        await commitAcpIdempotency(options, idempotency.lease);
      } catch (error) {
        // Bind failed after a committed session: release instead, so a replayed request rebuilds
        // the committed response from the stored record rather than staying in_progress.
        observeAcpError(options, "acp.complete.bindIdempotency", error);
        commitMainLease = false;
      }
    }
    if (!commitMainLease) await releaseAcpIdempotencyQuietly(options, idempotency.lease);
    await releaseAcpIdempotencyQuietly(options, completion.lease);
  }
}

// checkout.start can return terminal failure states that must block ACP complete with 409.
function acpCheckoutStartTerminalStatus(status: CheckoutSessionDTO["status"]): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "expired" ||
    status === "binding_mismatch"
  );
}

async function handleAcpGet(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, false);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);

  return acpJson(request, await recordToAcpSession(options, request, record), 200);
}

async function handleAcpCancel(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  let record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  record = await expireAcpRecordIfNeeded(options, record);
  if (acpRecordIsExpired(record, nowIso(options))) return acpExpiredError(request);
  const expectedVersion = record.version;
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  try {
    const terminalStatus = await acpTerminalStatus(options, record);
    if (terminalStatus === "completed") {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpTerminalError(request, terminalStatus, "canceled");
    }
    if (terminalStatus === "canceled") {
      await commitAcpIdempotency(options, idempotency.lease);

      return acpJson(request, await recordToAcpSession(options, request, record), 200);
    }

    if (record.checkoutId) {
      const cancellation = await options.api.checkout.cancel(
        acpContext(options, request, record.sessionId),
        { checkoutId: record.checkoutId },
      );
      if (!cancellation.ok && cancellation.status !== 404) {
        await releaseAcpIdempotency(options, idempotency.lease);

        return acpErrorFromResult(request, cancellation);
      }
    }

    const canceled: MikaAcpSessionRecord = {
      ...record,
      status: "canceled",
      purgeAt: addMilliseconds(nowIso(options), acpTerminalRetentionMs(options)),
      updatedAt: nowIso(options),
      version: nextAcpVersion(expectedVersion),
    };
    const written = await options.store.putIfUnchanged(canceled, expectedVersion);
    await commitAcpIdempotency(options, idempotency.lease);
    if (!written) {
      // Lost the race — another concurrent request already wrote a newer version (e.g. its own
      // cancel, or a completion that landed first). Report whatever's actually persisted rather
      // than this handler's own stale computation, same as handleAcpComplete's CAS-loss path.
      const current = (await options.store.get(checkoutSessionId)) ?? canceled;

      return acpJson(request, await recordToAcpSession(options, request, current), 200);
    }

    return acpJson(request, await recordToAcpSession(options, request, canceled), 200);
  } catch (error) {
    observeAcpError(options, "acp.cancel.unhandled", error);
    await releaseAcpIdempotencyQuietly(options, idempotency.lease);

    return acpUnhandledFailure(request);
  }
}

interface MikaAcpIdempotencyLease {
  readonly key: string;
  readonly id: string;
  readonly fencingToken: string;
}

type MikaAcpIdempotencyBegin =
  | { readonly ok: true; readonly lease?: MikaAcpIdempotencyLease }
  | { readonly ok: false; readonly response: Response };

async function beginAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
  replayStatus: number,
  replayExistingBinding = false,
  storeKeyOverride?: string,
): Promise<MikaAcpIdempotencyBegin> {
  const key = storeKeyOverride ?? acpIdempotencyStoreKey(request);
  if (!key) return { ok: true };

  const now = nowIso(options);
  const claim = await options.store.claimIdempotencyKey(key, checkoutSessionId, {
    now,
    expiresAt: addMilliseconds(
      now,
      options.idempotencyClaimTtlMs ?? MIKA_ACP_DEFAULT_IDEMPOTENCY_CLAIM_TTL_MS,
    ),
  });
  if (claim.status === "claimed") {
    return { ok: true, lease: { key, id: checkoutSessionId, fencingToken: claim.fencingToken } };
  }
  if (claim.status === "replayed") {
    return {
      ok: false,
      response: acpJson(
        request,
        await recordToAcpSession(options, request, claim.record),
        replayStatus,
      ),
    };
  }

  if (replayExistingBinding && claim.status === "conflict") {
    const bound = await options.store.get(claim.id);

    return {
      ok: false,
      response: bound
        ? acpJson(request, await recordToAcpSession(options, request, bound), replayStatus)
        : acpError(
            request,
            409,
            "request_not_idempotent",
            "Idempotency-Key replay is already in progress.",
          ),
    };
  }

  return {
    ok: false,
    response: acpError(
      request,
      409,
      "request_not_idempotent",
      claim.status === "conflict"
        ? "Idempotency-Key is already bound to another checkout session."
        : "Idempotency-Key replay is already in progress.",
    ),
  };
}

async function commitAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  if (lease) await options.store.bindIdempotencyKey(lease.key, lease.id, lease.fencingToken);
}

async function releaseAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  if (lease) await options.store.releaseIdempotencyKey(lease.key, lease.id, lease.fencingToken);
}

async function releaseAcpIdempotencyQuietly(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  try {
    await releaseAcpIdempotency(options, lease);
  } catch (error) {
    // Best-effort cleanup after an ACP storage/API failure; callers still receive a protocol error.
    observeAcpError(options, "acp.idempotency.release", error);
  }
}

function acpIdempotencyStoreKey(request: Request): string | undefined {
  const key = request.headers.get("Idempotency-Key");
  if (!key) return undefined;

  return `${request.method}:${new URL(request.url).pathname}:${key}`;
}

async function acpTerminalStatus(
  options: CreateMikaAcpCheckoutHandlersOptions,
  record: MikaAcpSessionRecord,
): Promise<MikaAcpCheckoutSessionStatus | undefined> {
  if (record.status === "completed" || record.status === "canceled") return record.status;
  if (!record.checkoutId) return undefined;
  const checkout = await options.api.checkout.status(
    createMikaRequestContext({
      sessionId: record.sessionId,
      session: createStaticSession(record.sessionId),
      now: options.now?.(),
    }),
    { checkoutId: record.checkoutId },
  );
  if (!checkout.ok) return undefined;
  if (checkout.data.status === "completed") return "completed";
  if (checkout.data.status === "cancelled") return "canceled";

  return undefined;
}

function acpSessionTtlMs(options: CreateMikaAcpCheckoutHandlersOptions): number {
  return options.sessionTtlMs ?? MIKA_ACP_DEFAULT_SESSION_TTL_MS;
}

function acpTerminalRetentionMs(options: CreateMikaAcpCheckoutHandlersOptions): number {
  return options.terminalRetentionMs ?? MIKA_ACP_DEFAULT_TERMINAL_RETENTION_MS;
}

function acpRecordIsTerminal(record: MikaAcpSessionRecord): boolean {
  return record.status === "completed" || record.status === "canceled";
}

function acpRecordIsExpired(record: MikaAcpSessionRecord, now: ISODateTime): boolean {
  if (acpRecordIsTerminal(record)) return false;
  if (record.expiredAt) return true;
  if (!record.expiresAt) return false;

  return new Date(record.expiresAt).getTime() <= new Date(now).getTime();
}

/**
 * Structural equality for plain JSON-shaped values (every MikaAcpSessionRecord field is one:
 * strings, arrays, and nested plain objects — no Dates, Maps, or class instances). Deliberately
 * not a `===`/reference check: a real (non-memory) MikaAcpSessionStore commonly deserializes a
 * fresh object graph on every `get()` (e.g. `JSON.parse` of a stored row), so two reads of
 * content-identical data are never the same reference even when nothing changed. Object key order
 * is ignored (compares by key set, not insertion order) since a storage round-trip has no
 * obligation to preserve it. An explicit `key: undefined` is treated as equivalent to `key` being
 * absent entirely (both read as `undefined` through bracket access) — matching how `JSON.stringify`
 * itself drops undefined-valued keys, so this stays a faithful "would these serialize the same"
 * comparison even before either side has actually round-tripped through JSON.
 */
function acpDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => acpDeepEqual(item, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);

  return [...keys].every((key) => acpDeepEqual(leftRecord[key], rightRecord[key]));
}

/**
 * True when `current` is exactly `original` with nothing but expireAcpRecordIfNeeded's lazy
 * expiry sweep applied on top — the only fields that differ are the ones that sweep touches
 * (`status`, `expiredAt`, `purgeAt`, `updatedAt`, `version`), and `status` landed on a
 * non-terminal value. Every other field (`checkoutId`, `buyer`, `items`,
 * `fulfillmentAddress`/`fulfillmentOptionId`, etc.) must be unchanged — a genuine concurrent write
 * (e.g. handleAcpUpdate legitimately changing `buyer` or `items`) has no `checkoutId` and a
 * non-terminal `status` either, so checking those two fields alone would misclassify a real
 * conflict as "merely incidental" and silently retry past it, discarding the other write. Compares
 * object/array-typed fields structurally (see acpDeepEqual), not by reference, since a real store
 * that deserializes on every read would otherwise make every field "different" every time,
 * defeating the retry this function exists to allow.
 *
 * expireAcpRecordIfNeeded runs unconditionally at the top of every handler, including plain GETs
 * with no locking of their own, so an ordinary concurrent status poll can legitimately tick a
 * session's TTL and bump its version while a slow (not crashed) handleAcpComplete is still mid
 * checkout.start — losing that handler's final CAS check to a bystander write, not a real
 * conflict. Without distinguishing the two, a genuinely successful completion would be silently
 * discarded: its own caller would be told the session is "not_ready_for_payment" while a real
 * payment already went through, and nothing ever revisits that record afterward to set it right.
 */
function acpRecordIsOnlyIncidentallyExpired(
  original: MikaAcpSessionRecord,
  current: MikaAcpSessionRecord,
): boolean {
  return (
    current.status !== "completed" &&
    current.status !== "canceled" &&
    current.cartId === original.cartId &&
    current.checkoutId === original.checkoutId &&
    current.fulfillmentOptionId === original.fulfillmentOptionId &&
    current.currency === original.currency &&
    current.provider === original.provider &&
    current.paymentAuthorizationId === original.paymentAuthorizationId &&
    current.quoteInputHash === original.quoteInputHash &&
    current.expiresAt === original.expiresAt &&
    acpDeepEqual(current.buyer, original.buyer) &&
    acpDeepEqual(current.items, original.items) &&
    acpDeepEqual(current.fulfillmentAddress, original.fulfillmentAddress) &&
    acpDeepEqual(current.quoteSnapshot, original.quoteSnapshot)
  );
}

/**
 * Persists `buildCandidate(version)` via putIfUnchanged, retrying past a CAS loss that turns out
 * to be nothing more than expireAcpRecordIfNeeded's lazy expiry sweep (see
 * acpRecordIsOnlyIncidentallyExpired) rather than a genuine competing decision, up to
 * MIKA_ACP_COMPLETE_WRITE_RETRIES attempts. Shared by both of handleAcpComplete's writes (the
 * early compensating revert and the final completion) so a bystander expiry sweep can't cause
 * either one to silently discard this attempt's own legitimate write — only a real conflict does.
 * Returns the persisted record, or `undefined` if every attempt lost to a genuine conflict (or the
 * record vanished); callers should then re-fetch and report whatever's actually stored.
 */
async function putAcpRecordRetryingIncidentalExpiry(
  options: CreateMikaAcpCheckoutHandlersOptions,
  checkoutSessionId: string,
  original: MikaAcpSessionRecord,
  buildCandidate: (version: number | undefined) => MikaAcpSessionRecord,
): Promise<MikaAcpSessionRecord | undefined> {
  let writeVersion = original.version;
  for (let attempt = 0; attempt < MIKA_ACP_COMPLETE_WRITE_RETRIES; attempt += 1) {
    const candidate = buildCandidate(writeVersion);
    if (await options.store.putIfUnchanged(candidate, writeVersion)) return candidate;
    const current = await options.store.get(checkoutSessionId);
    if (!current || !acpRecordIsOnlyIncidentallyExpired(original, current)) return undefined;
    writeVersion = current.version;
  }

  return undefined;
}

async function expireAcpRecordIfNeeded(
  options: CreateMikaAcpCheckoutHandlersOptions,
  record: MikaAcpSessionRecord,
): Promise<MikaAcpSessionRecord> {
  const now = nowIso(options);
  if (!acpRecordIsExpired(record, now) || record.expiredAt) return record;

  const expired: MikaAcpSessionRecord = {
    ...record,
    status: "not_ready_for_payment",
    expiredAt: now,
    purgeAt: addMilliseconds(now, acpTerminalRetentionMs(options)),
    updatedAt: now,
    version: nextAcpVersion(record.version),
  };
  const written = await options.store.putIfUnchanged(expired, record.version);
  if (written) return expired;

  // Lost the race — someone else already wrote a newer version (e.g. a genuine completion that
  // landed first). Return whatever's actually persisted rather than the stale expiry this handler
  // computed, so callers never act on a version that was never really committed.
  return (await options.store.get(record.id)) ?? expired;
}

function acpExpiredError(request: Request): Response {
  return acpError(
    request,
    409,
    "checkout_expired",
    "Checkout session has expired. Create a new ACP checkout session to continue.",
  );
}

function acpTerminalError(
  request: Request,
  status: MikaAcpCheckoutSessionStatus,
  action: "updated" | "completed" | "canceled",
): Response {
  return acpError(
    request,
    409,
    "invalid_request",
    `Checkout session is ${status} and cannot be ${action}.`,
  );
}

async function reconcileAcpCart(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
  items: readonly MikaAcpItem[],
): Promise<
  | { readonly ok: true; readonly record: MikaAcpSessionRecord }
  | { readonly ok: false; readonly response: Response }
> {
  const ctx = acpContext(options, request, record.sessionId);
  const cartResult = await options.api.cart.get(ctx);
  if (!cartResult.ok) return { ok: false, response: acpErrorFromResult(request, cartResult) };

  const parsedItems: {
    readonly item: MikaAcpItem;
    readonly ids: ReturnType<typeof parseAcpItemId>;
  }[] = [];
  for (const item of items) {
    try {
      parsedItems.push({ item, ids: parseAcpItemId(item.id) });
    } catch (error) {
      return {
        ok: false,
        response: acpError(
          request,
          400,
          "invalid_request",
          error instanceof Error ? error.message : "ACP item id is invalid.",
        ),
      };
    }
  }

  const originalCart = cartResult.data;
  // Wipe-and-rebuild cart sync; restore originalCart on any add/remove failure.
  let cart = cartResult.data;
  for (const line of cart.items) {
    const removed = await options.api.cart.remove(ctx, { lineId: line.id });
    if (!removed.ok) {
      const rollbackMessage = await restoreAcpCart(options, ctx, originalCart);

      return {
        ok: false,
        response: acpErrorFromResult(
          request,
          removed,
          rollbackMessage
            ? `${resultMessage(removed)} Cart rollback failed: ${rollbackMessage}`
            : undefined,
        ),
      };
    }
    cart = removed.data;
  }

  for (const { item, ids } of parsedItems) {
    const added = await options.api.cart.add(ctx, {
      sellableId: ids.sellableId,
      priceId: ids.priceId,
      quantity: item.quantity,
    });
    if (!added.ok) {
      const rollbackMessage = await restoreAcpCart(options, ctx, originalCart);

      return {
        ok: false,
        response: acpErrorFromResult(
          request,
          added,
          rollbackMessage
            ? `${resultMessage(added)} Cart rollback failed: ${rollbackMessage}`
            : undefined,
        ),
      };
    }
    cart = added.data;
  }

  return {
    ok: true,
    record: {
      ...record,
      cartId: cart.id,
      currency: cart.currency,
      items,
      status: acpStatusFromCart(cart, record),
      updatedAt: nowIso(options),
    },
  };
}

async function restoreAcpCart(
  options: CreateMikaAcpCheckoutHandlersOptions,
  ctx: MikaRequestContext,
  originalCart: CartDTO,
): Promise<string | undefined> {
  const currentResult = await options.api.cart.get(ctx);
  if (!currentResult.ok) return resultMessage(currentResult);

  let cart = currentResult.data;
  for (const line of cart.items) {
    const removed = await options.api.cart.remove(ctx, { lineId: line.id });
    if (!removed.ok) return resultMessage(removed);
    cart = removed.data;
  }

  for (const line of originalCart.items) {
    const restored = await options.api.cart.add(ctx, {
      sellableId: line.sellableId,
      priceId: line.priceId,
      quantity: line.quantity,
    });
    if (!restored.ok) return resultMessage(restored);
  }

  return undefined;
}

async function recordToAcpSession(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
): Promise<MikaAcpCheckoutSession> {
  const ctx = acpContext(options, request, record.sessionId);
  const quote = await options.api.cart.quote(ctx, { cartId: record.cartId });
  const checkoutStatus = record.checkoutId
    ? await options.api.checkout.status(ctx, { checkoutId: record.checkoutId })
    : undefined;
  const checkout = checkoutStatus?.ok ? checkoutStatus.data : undefined;
  const status =
    checkout?.status === "completed" || record.status === "completed"
      ? "completed"
      : checkout?.status === "cancelled" || record.status === "canceled"
        ? "canceled"
        : undefined;
  if (status === "completed" && record.quoteSnapshot) {
    return acpCheckoutSessionFromSnapshot({
      record,
      snapshot: record.quoteSnapshot,
      status,
      seller: options.seller,
      orderUrl: options.orderUrl?.({ checkoutId: record.checkoutId, sessionId: record.id }),
      checkout,
    });
  }

  return acpCheckoutSessionFromState({
    record,
    quote: quote.ok ? quote.data : emptyQuote(record),
    checkout,
    seller: options.seller,
    orderUrl: options.orderUrl?.({ checkoutId: record.checkoutId, sessionId: record.id }),
  });
}

function acpSessionSnapshotFromQuote(
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

function acpCheckoutSessionFromSnapshot(input: {
  readonly record: MikaAcpSessionRecord;
  readonly snapshot: MikaAcpSessionSnapshot;
  readonly status: MikaAcpCheckoutSessionStatus;
  readonly seller: MikaAcpSeller;
  readonly orderUrl?: string;
  readonly checkout?: CheckoutSessionDTO;
}): MikaAcpCheckoutSession {
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
    ...(input.status === "completed" && input.checkout && input.orderUrl
      ? {
          order: {
            id: input.checkout.orderId ?? input.checkout.id,
            checkout_session_id: input.record.id,
            permalink_url: input.orderUrl,
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
    ...(status === "completed" && input.checkout && input.orderUrl
      ? {
          order: {
            id: input.checkout.orderId ?? input.checkout.id,
            checkout_session_id: input.record.id,
            permalink_url: input.orderUrl,
          },
        }
      : {}),
  };
}

function priceTitle(sellable: SellableDTO, priceId: MikaId): string {
  if (sellable.prices.length <= 1) return sellable.title;
  const price = sellable.prices.find((candidate) => candidate.id === priceId);

  return price?.mode === "subscription"
    ? `${sellable.title} subscription`
    : `${sellable.title} purchase`;
}

function descriptionText(description: MikaAcpDescription | undefined): string | undefined {
  return description?.plain ?? description?.markdown ?? stripHtml(description?.html);
}

function stripHtml(input: string | undefined): string | undefined {
  return (
    input
      ?.replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

function requiredProductField(value: string | undefined, field: string): string {
  if (!value) throw new Error(`ACP file-upload row requires ${field}.`);

  return value;
}

function acpAvailability(sellable: SellableDTO): MikaAcpAvailability {
  const status = sellable.availability?.status;

  if (!sellable.active || status === "out_of_stock" || status === "manual") {
    return { available: false, status: "out_of_stock" };
  }

  if (status === "backorder") {
    return { available: true, status: "backorder" };
  }

  if (status === "untracked") {
    return { available: true, status: "in_stock" };
  }

  const available = sellable.availability?.availableQuantity !== 0;

  return {
    available,
    status: available ? "in_stock" : "out_of_stock",
  };
}

function acpFileAvailability(sellable: SellableDTO): MikaAcpFileUploadProductRow["availability"] {
  const status = acpAvailability(sellable).status;

  return status === "backorder"
    ? "backorder"
    : status === "preorder"
      ? "pre_order"
      : status === "in_stock"
        ? "in_stock"
        : "out_of_stock";
}

function acpVariantOptions(
  options: readonly VariantOptionValueDTO[],
): readonly MikaAcpVariantOption[] | undefined {
  const values = options.map((option) => ({
    name: option.label ?? option.option,
    value: option.value,
  }));

  return values.length > 0 ? values : undefined;
}

function validateUrl(url: string, path: string, issues: MikaAcpValidationIssue[]): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      issues.push({ path, message: "URL must use http or https." });
    }
  } catch {
    issues.push({ path, message: "URL must be valid." });
  }
}

async function verifyAcpRequest(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  bodyRequired: boolean,
): Promise<Response | undefined> {
  if (options.apiKey) {
    const expected = `Bearer ${options.apiKey}`;
    if (!safeStringEqual(request.headers.get("Authorization") ?? "", expected)) {
      return acpError(request, 401, "unauthorized", "ACP authorization failed.");
    }
  }
  // Idempotency-Key is required for mutating requests; GET handlers pass bodyRequired=false.
  if (bodyRequired && !request.headers.get("Idempotency-Key")) {
    return acpError(request, 400, "request_not_idempotent", "Idempotency-Key header is required.");
  }
  if (!options.signatureSecret) return undefined;

  const signature = request.headers.get("Signature");
  if (!signature)
    return acpError(request, 401, "signature_invalid", "Signature header is required.");
  // The published ACP spec names this header "Timestamp" (RFC 3339), not "Signature-Timestamp".
  const timestamp = request.headers.get("Timestamp");
  if (!timestamp) {
    return acpError(request, 401, "signature_invalid", "Timestamp header is required.");
  }
  if (!acpSignatureTimestampIsFresh(timestamp, options.now?.() ?? new Date())) {
    return acpError(
      request,
      401,
      "signature_invalid",
      "ACP request signature timestamp is invalid.",
    );
  }
  const payload = await request.clone().text();
  const expected = await hmacBase64Url(
    options.signatureSecret,
    acpCanonicalSignaturePayload(request, payload, timestamp),
  );
  if (!safeStringEqual(signature, expected)) {
    return acpError(request, 401, "signature_invalid", "ACP request signature is invalid.");
  }

  return undefined;
}

async function readAcpBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<
  | { readonly ok: true; readonly data: z.infer<TSchema> }
  | { readonly ok: false; readonly message: string; readonly path?: string }
> {
  let parsedJson: unknown;
  try {
    parsedJson = await request.json();
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path =
      issue && issue.path.length > 0
        ? `$${issue.path
            .map((segment) =>
              typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`,
            )
            .join("")}`
        : undefined;

    return {
      ok: false,
      message: issue
        ? path
          ? `Request body is invalid at '${path}': ${issue.message}`
          : `Request body is invalid: ${issue.message}`
        : "Request body is invalid.",
      ...(path ? { path } : {}),
    };
  }

  return { ok: true, data: parsed.data as z.infer<TSchema> };
}

async function previewAcpCheckout(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
  customer: CheckoutCustomerInput | undefined,
): Promise<MikaApiResult<CheckoutPreviewDTO>> {
  return options.api.checkout.preview(acpContext(options, request, record.sessionId), {
    cartId: record.cartId,
    provider: record.provider,
    customer,
  });
}

function acpContext(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  sessionId: string,
): MikaRequestContext {
  return createMikaRequestContext({
    request,
    url: acpRequestUrl(options, request),
    sessionId,
    session: createStaticSession(sessionId),
    idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
    locale: request.headers.get("Accept-Language") ?? undefined,
    now: options.now?.(),
  });
}

function acpRequestUrl(options: CreateMikaAcpCheckoutHandlersOptions, request: Request): URL {
  const requestUrl = new URL(request.url);
  if (!options.baseUrl) return requestUrl;

  const baseUrl = new URL(options.baseUrl);
  return new URL(`${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`, baseUrl);
}

function createStaticSession(sessionID: string): MikaSessionAccess {
  const values = new Map<string, unknown>();

  return {
    sessionID,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      values.set(key, value);
    },
  };
}

function parseAcpItemId(id: string): { readonly sellableId: MikaId; readonly priceId?: MikaId } {
  const [sellableId, priceId] = id.split(":");
  if (!sellableId) throw new Error("ACP item id must include a sellable id.");

  return {
    sellableId: createMikaId(sellableId),
    ...(priceId ? { priceId: createMikaId(priceId) } : {}),
  };
}

function acpStatusFromCart(
  cart: CartDTO,
  record: MikaAcpSessionRecord,
): MikaAcpCheckoutSessionStatus {
  if (record.status === "canceled" || record.status === "completed") return record.status;
  if (cart.errors?.length) return "not_ready_for_payment";

  return "ready_for_payment";
}

function acpLineItem(line: CartQuoteLineDTO | CartLineDTO, index: number): MikaAcpLineItem {
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

function fulfillmentOptions(quote: CartQuoteDTO): readonly MikaAcpFulfillmentOption[] {
  const hasDigital = quote.items.length > 0;

  return hasDigital
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

function acpTotals(quote: CartQuoteDTO): readonly MikaAcpTotal[] {
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

function acpMessages(quote: CartQuoteDTO): readonly MikaAcpMessage[] {
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

function acpCheckoutLink(link: MikaAcpLink): readonly MikaAcpCheckoutLink[] {
  if (
    link.type === "terms_of_use" ||
    link.type === "privacy_policy" ||
    link.type === "seller_shop_policies"
  ) {
    return [{ type: link.type, url: link.url }];
  }
  if (link.type === "terms_of_service") return [{ type: "terms_of_use", url: link.url }];

  return [];
}

const MIKA_ACP_PAYMENT_PROVIDERS = ["stripe", "adyen", "braintree"] as const;

/**
 * Maps a Mika provider to the ACP wire protocol's closed payment-provider union. Throws for any
 * provider outside that set instead of silently reporting "stripe" — the wrong provider name on
 * `payment_provider` would make an agent generate a shared payment token shaped for a provider
 * that isn't actually handling the charge, a payment-routing failure worse than a loud error.
 * All call sites run inside a handler that converts an unhandled throw to a generic ACP 500.
 */
function providerToAcp(provider: ProviderName | undefined): MikaAcpPaymentProvider["provider"] {
  const value = provider as string | undefined;
  const match = MIKA_ACP_PAYMENT_PROVIDERS.find((candidate) => candidate === value);
  if (!match) {
    throw new Error(
      `ACP does not support payment provider '${value ?? "(none)"}'; expected one of ${MIKA_ACP_PAYMENT_PROVIDERS.join(", ")}.`,
    );
  }

  return match;
}

function buyerToCustomer(buyer: MikaAcpBuyer | undefined): CheckoutCustomerInput | undefined {
  if (!buyer) return undefined;

  return {
    email: buyer.email,
    name: buyer.name,
  };
}

function emptyQuote(record: MikaAcpSessionRecord): CartQuoteDTO {
  const currency = record.currency ?? createCurrencyCode("USD");
  const zero: MoneyDTO = { amount: 0, currency };

  return {
    cartId: record.cartId,
    status: "unavailable",
    currency,
    items: [],
    subtotal: zero,
    total: zero,
    warnings: ["Checkout session is not ready."],
  };
}

function resultMessage(result: MikaApiResult<unknown>): string {
  return result.ok ? "OK" : result.error.message;
}

function acpErrorCodeFromMika(error: MikaError): MikaAcpError["code"] {
  return error.code.toLowerCase() as Lowercase<MikaErrorCode>;
}

function acpErrorFromResult(
  request: Request,
  result: Extract<MikaApiResult<unknown>, { readonly ok: false }>,
  message?: string,
): Response {
  const fieldName = Object.keys(result.error.fieldErrors ?? {})[0];

  return acpError(
    request,
    result.status,
    acpErrorCodeFromMika(result.error),
    message ?? result.error.message,
    fieldName ? `$.${fieldName}` : undefined,
    { retryAfter: result.error.retryAfter },
  );
}

function acpUnhandledFailure(request: Request): Response {
  return acpError(request, 500, "provider_failed", "ACP checkout operation failed.");
}

function nowIso(options: CreateMikaAcpCheckoutHandlersOptions): ISODateTime {
  return createISODateTime((options.now?.() ?? new Date()).toISOString());
}

function addMilliseconds(value: ISODateTime, milliseconds: number): ISODateTime {
  return createISODateTime(new Date(Date.parse(value) + milliseconds).toISOString());
}

function acpJson(request: Request, body: MikaAcpCheckoutSession, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: acpResponseHeaders(request),
  });
}

function acpError(
  request: Request,
  status: number,
  code: MikaAcpError["code"],
  message: string,
  param?: string,
  options: { readonly retryAfter?: number } = {},
): Response {
  const body: MikaAcpError = {
    type: "invalid_request",
    code,
    message,
    ...(param ? { param } : {}),
    ...(options.retryAfter !== undefined ? { retry_after: options.retryAfter } : {}),
  };
  const headers = acpResponseHeaders(request);
  if (options.retryAfter !== undefined) headers.set("Retry-After", String(options.retryAfter));

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function acpResponseHeaders(request: Request): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const requestId = request.headers.get("Request-Id");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (requestId) headers.set("Request-Id", requestId);

  return headers;
}

async function hmacBase64(secret: string, payload: string): Promise<string> {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

/**
 * Base64url-encoded HMAC for incoming request signature verification. The published ACP spec's
 * Signature header for the checkout session API is documented as a base64url-encoded detached
 * signature (see the spec's request-signing header table), distinct from the outgoing webhook
 * signature ({@link signMikaAcpWebhook}), which is not documented to use the same encoding.
 */
async function hmacBase64Url(secret: string, payload: string): Promise<string> {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Canonical string signed for request verification. The published ACP spec documents the
 * Signature header as covering the request body plus a separate Timestamp header, without
 * specifying the exact body-serialization scheme (canonical JSON vs. raw bytes) in the parts of
 * the spec reviewed. Mika deliberately extends the signed payload with the HTTP method and
 * path+query — binding the signature to the exact request being authorized closes a
 * cross-endpoint replay gap a body-and-timestamp-only scheme leaves open (a signature valid for
 * one path/method could otherwise be replayed against another). This is intentional hardening
 * beyond the spec's documented minimum, not an oversight; a merchant integrating with a
 * strictly spec-minimal ACP client should verify that client signs the same fields before
 * enabling `signatureSecret` in production.
 */
function acpCanonicalSignaturePayload(
  request: Request,
  rawBody: string,
  timestamp: string,
): string {
  const url = new URL(request.url);

  return [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    sha256Hex(rawBody),
    timestamp,
  ].join("\n");
}

function acpSignatureTimestampIsFresh(timestamp: string, now: Date): boolean {
  const parsed = parseAcpSignatureTimestamp(timestamp);
  if (!parsed) return false;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return false;

  return Math.abs(nowMs - parsed.getTime()) <= MIKA_ACP_SIGNATURE_TOLERANCE_MS;
}

function parseAcpSignatureTimestamp(timestamp: string): Date | undefined {
  const value = timestamp.trim();
  if (!value) return undefined;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? value.length >= 13
      ? numeric
      : numeric * 1000
    : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const parsed = new Date(ms);

  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256Buffer(left), sha256Buffer(right));
}

function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function createDefaultAcpSessionId(): string {
  return `${MIKA_ACP_DEFAULT_SESSION_PREFIX}_${cryptoSafeId()}`;
}

function cryptoSafeId(): string {
  return randomBytes(16).toString("hex");
}
