/**
 * ACP public types: product feed, checkout handlers wiring, session response, and webhook events.
 */
import type { MikaErrorCode, SellableDTO } from "../api/types";
import type { MikaApi } from "../api/server";
import type {
  MikaAcpAddress,
  MikaAcpBuyer,
  MikaAcpCheckoutSessionStatus,
  MikaAcpFulfillmentOption,
  MikaAcpItem,
  MikaAcpLineItem,
  MikaAcpMessage,
  MikaAcpSessionStore,
  MikaAcpTotal,
} from "../api/acp-session";
import type { MikaId, ProviderName } from "../types/primitives";

/** ACP session-store contracts and embedded wire types (defined in ../api/acp-session). */
export type {
  MikaAcpAddress,
  MikaAcpBuyer,
  MikaAcpCheckoutSessionStatus,
  MikaAcpFulfillmentOption,
  MikaAcpIdempotencyClaim,
  MikaAcpIdempotencyLeaseWindow,
  MikaAcpItem,
  MikaAcpLineItem,
  MikaAcpMessage,
  MikaAcpSessionCleanupInput,
  MikaAcpSessionCleanupResult,
  MikaAcpSessionRecord,
  MikaAcpSessionSnapshot,
  MikaAcpSessionStore,
  MikaAcpTotal,
} from "../api/acp-session";

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

/** Delegated payment token and provider submitted at checkout completion. */
export interface MikaAcpPaymentData {
  readonly token: string;
  readonly provider: "stripe";
  readonly billing_address?: MikaAcpAddress;
}

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
  readonly provider: "stripe";
  readonly supported_payment_methods: readonly ["card"];
}

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
  readonly type:
    | "invalid_request"
    | "request_not_idempotent"
    | "processing_error"
    | "service_unavailable";
  readonly code:
    | "request_not_idempotent"
    | "invalid_request"
    | "unauthorized"
    | "signature_invalid"
    | Lowercase<MikaErrorCode>;
  readonly message: string;
  readonly param?: string;
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
