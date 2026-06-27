import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
  MikaApiResult,
  MoneyDTO,
  SellableDTO,
  VariantOptionValueDTO,
} from "./api/types";
import type { MikaApi } from "./server";
import {
  MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY,
} from "./stripe";
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

export const MIKA_ACP_API_VERSION = "2025-09-12";
export const MIKA_ACP_DEFAULT_SESSION_PREFIX = "acp_checkout";

export interface MikaAcpSeller {
  readonly name: string;
  readonly links: readonly MikaAcpLink[];
}

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

export interface MikaAcpFeedProductInput {
  readonly id: string;
  readonly title?: string;
  readonly description?: MikaAcpDescription;
  readonly url?: string;
  readonly media?: readonly MikaAcpMedia[];
  readonly seller?: MikaAcpSeller;
  readonly sellables: readonly SellableDTO[];
}

export interface MikaAcpProductFeed {
  readonly target_country?: string;
  readonly products: readonly MikaAcpProduct[];
}

export interface MikaAcpFileUploadProductRow {
  readonly is_eligible_search: boolean;
  readonly is_eligible_checkout: boolean;
  readonly item_id: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly brand: string;
  readonly image_url: string;
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

export interface MikaAcpProduct {
  readonly id: string;
  readonly title?: string;
  readonly description?: MikaAcpDescription;
  readonly url?: string;
  readonly media?: readonly MikaAcpMedia[];
  readonly variants: readonly MikaAcpVariant[];
}

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

export interface MikaAcpDescription {
  readonly plain?: string;
  readonly html?: string;
  readonly markdown?: string;
}

export interface MikaAcpPrice {
  readonly amount: number;
  readonly currency: string;
}

export interface MikaAcpAvailability {
  readonly available?: boolean;
  readonly status?: "in_stock" | "backorder" | "preorder" | "out_of_stock" | "discontinued";
}

export interface MikaAcpVariantOption {
  readonly name: string;
  readonly value: string;
}

export interface MikaAcpMedia {
  readonly type: "image" | "video";
  readonly url: string;
  readonly alt_text?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface MikaAcpValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface MikaAcpSessionRecord {
  readonly id: string;
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
  readonly quoteInputHash?: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface MikaAcpSessionStore {
  get(id: string): Promise<MikaAcpSessionRecord | undefined>;
  put(record: MikaAcpSessionRecord): Promise<void>;
  claimIdempotencyKey?(key: string, id: string): Promise<MikaAcpIdempotencyClaim>;
  getByIdempotencyKey?(key: string): Promise<MikaAcpSessionRecord | undefined>;
  bindIdempotencyKey?(key: string, id: string): Promise<void>;
  releaseIdempotencyKey?(key: string, id: string): Promise<void>;
}

export type MikaAcpIdempotencyClaim =
  | { readonly status: "claimed" }
  | { readonly status: "replayed"; readonly record: MikaAcpSessionRecord }
  | { readonly status: "conflict"; readonly id: string }
  | { readonly status: "in_progress"; readonly id: string };

export interface CreateMikaAcpCheckoutHandlersOptions {
  readonly api: MikaApi;
  readonly store: MikaAcpSessionStore;
  readonly seller: MikaAcpSeller;
  readonly provider?: ProviderName;
  readonly apiKey?: string;
  readonly signatureSecret?: string;
  readonly baseUrl?: string | URL;
  readonly now?: () => Date;
  readonly createSessionId?: () => string;
  readonly orderUrl?: (input: {
    readonly checkoutId?: MikaId;
    readonly sessionId: string;
  }) => string;
}

export interface MikaAcpCheckoutHandlers {
  create(request: Request): Promise<Response>;
  update(request: Request, checkoutSessionId: string): Promise<Response>;
  complete(request: Request, checkoutSessionId: string): Promise<Response>;
  get(request: Request, checkoutSessionId: string): Promise<Response>;
  cancel(request: Request, checkoutSessionId: string): Promise<Response>;
}

export interface MikaAcpCheckoutCreateRequest {
  readonly buyer?: MikaAcpBuyer;
  readonly items: readonly MikaAcpItem[];
  readonly fulfillment_address?: MikaAcpAddress;
}

export interface MikaAcpCheckoutUpdateRequest {
  readonly buyer?: MikaAcpBuyer;
  readonly items?: readonly MikaAcpItem[];
  readonly fulfillment_address?: MikaAcpAddress;
  readonly fulfillment_option_id?: string;
}

export interface MikaAcpCheckoutCompleteRequest {
  readonly buyer?: MikaAcpBuyer;
  readonly payment_data: MikaAcpPaymentData;
}

export interface MikaAcpBuyer {
  readonly name?: string;
  readonly email?: string;
  readonly phone_number?: string;
}

export interface MikaAcpItem {
  readonly id: string;
  readonly quantity: number;
}

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

export interface MikaAcpPaymentData {
  readonly token: string;
  readonly provider: "stripe" | "adyen" | "braintree";
  readonly billing_address?: MikaAcpAddress;
}

export type MikaAcpCheckoutSessionStatus =
  | "not_ready_for_payment"
  | "ready_for_payment"
  | "completed"
  | "canceled";

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

export interface MikaAcpPaymentProvider {
  readonly provider: "stripe" | "adyen" | "braintree";
  readonly supported_payment_methods: readonly ["card"];
}

export interface MikaAcpLineItem {
  readonly id: string;
  readonly item: MikaAcpItem;
  readonly base_amount: number;
  readonly discount: number;
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
}

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

export interface MikaAcpCheckoutLink {
  readonly type: "terms_of_use" | "privacy_policy" | "seller_shop_policies";
  readonly url: string;
}

export interface MikaAcpOrder {
  readonly id: string;
  readonly checkout_session_id: string;
  readonly permalink_url: string;
}

export interface MikaAcpError {
  readonly type: "invalid_request";
  readonly code:
    | "request_not_idempotent"
    | "invalid_request"
    | "unauthorized"
    | "signature_invalid";
  readonly message: string;
  readonly param?: string;
}

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

export function createMikaAcpProductFeed(input: {
  readonly targetCountry?: string;
  readonly products: readonly MikaAcpFeedProductInput[];
}): MikaAcpProductFeed {
  return {
    ...(input.targetCountry ? { target_country: input.targetCountry } : {}),
    products: input.products.map((product) => ({
      id: product.id,
      ...(product.title ? { title: product.title } : {}),
      ...(product.description ? { description: product.description } : {}),
      ...(product.url ? { url: product.url } : {}),
      ...(product.media ? { media: product.media } : {}),
      variants: product.sellables.flatMap((sellable) =>
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
      ),
    })),
  };
}

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
          price: `${price.amount} ${price.currency}`,
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

export function serializeMikaAcpFileUploadRows(
  rows: readonly MikaAcpFileUploadProductRow[],
): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

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

export function serializeMikaAcpProductFeed(feed: MikaAcpProductFeed): string {
  const issues = validateMikaAcpProductFeed(feed);
  if (issues.length > 0) {
    throw new Error(`ACP product feed is invalid: ${issues[0]!.path} ${issues[0]!.message}`);
  }

  return JSON.stringify(feed, null, 2);
}

export function createMemoryMikaAcpSessionStore(): MikaAcpSessionStore {
  const sessions = new Map<string, MikaAcpSessionRecord>();
  const idempotencyKeys = new Map<string, { readonly id: string; readonly pending: boolean }>();

  return {
    async get(id) {
      return sessions.get(id);
    },
    async put(record) {
      sessions.set(record.id, record);
    },
    async claimIdempotencyKey(key, id) {
      const existing = idempotencyKeys.get(key);
      if (existing) {
        if (existing.id !== id) return { status: "conflict", id: existing.id };
        const record = sessions.get(existing.id);

        return record && !existing.pending
          ? { status: "replayed", record }
          : { status: "in_progress", id: existing.id };
      }

      idempotencyKeys.set(key, { id, pending: true });

      return { status: "claimed" };
    },
    async getByIdempotencyKey(key) {
      const binding = idempotencyKeys.get(key);
      if (!binding || binding.pending) return undefined;

      return sessions.get(binding.id);
    },
    async bindIdempotencyKey(key, id) {
      idempotencyKeys.set(key, { id, pending: false });
    },
    async releaseIdempotencyKey(key, id) {
      const binding = idempotencyKeys.get(key);
      if (binding?.id === id && binding.pending) idempotencyKeys.delete(key);
    },
  };
}

export function createMikaAcpCheckoutHandlers(
  options: CreateMikaAcpCheckoutHandlersOptions,
): MikaAcpCheckoutHandlers {
  return {
    create: async (request) => handleAcpCreate(options, request),
    update: async (request, checkoutSessionId) =>
      handleAcpUpdate(options, request, checkoutSessionId),
    complete: async (request, checkoutSessionId) =>
      handleAcpComplete(options, request, checkoutSessionId),
    get: async (request, checkoutSessionId) => handleAcpGet(options, request, checkoutSessionId),
    cancel: async (request, checkoutSessionId) =>
      handleAcpCancel(options, request, checkoutSessionId),
  };
}

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

  const body = await readJson<MikaAcpCheckoutCreateRequest>(request);
  if (!body.ok) return acpError(request, 400, "invalid_request", body.message);
  if (!Array.isArray(body.data.items) || body.data.items.length === 0) {
    return acpError(request, 400, "invalid_request", "items must be a non-empty array.", "$.items");
  }

  const now = nowIso(options);
  const session: MikaAcpSessionRecord = {
    id: options.createSessionId?.() ?? createDefaultAcpSessionId(),
    sessionId: `${MIKA_ACP_DEFAULT_SESSION_PREFIX}:${cryptoSafeId()}`,
    status: "not_ready_for_payment",
    buyer: body.data.buyer,
    items: body.data.items,
    fulfillmentAddress: body.data.fulfillment_address,
    provider: options.provider ?? createProviderName("stripe"),
    createdAt: now,
    updatedAt: now,
  };
  const idempotency = await beginAcpIdempotency(options, request, session.id, 201);
  if (!idempotency.ok) return idempotency.response;

  const reconciled = await reconcileAcpCart(options, request, session, body.data.items);
  if (!reconciled.ok) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, 400, "invalid_request", reconciled.message);
  }
  await options.store.put(reconciled.record);
  await commitAcpIdempotency(options, idempotency.lease);

  return acpJson(request, await recordToAcpSession(options, request, reconciled.record), 201);
}

async function handleAcpUpdate(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  const record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  const terminalStatus = await acpTerminalStatus(options, record);
  if (terminalStatus) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpTerminalError(request, terminalStatus, "updated");
  }

  const body = await readJson<MikaAcpCheckoutUpdateRequest>(request);
  if (!body.ok) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, 400, "invalid_request", body.message);
  }

  // Once `complete` has bound a (still non-terminal) Mika checkout, the priced
  // lines are locked for payment handoff. Reconciling the cart to new items here
  // would desync the delegated-payment total from the bound checkout (the buyer
  // could be charged for a different cart). Reject item changes after bind;
  // buyer/fulfillment-only updates still pass.
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
    updatedAt: nowIso(options),
  };
  const reconciled = body.data.items
    ? await reconcileAcpCart(options, request, next, body.data.items)
    : { ok: true as const, record: next };
  if (!reconciled.ok) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, 400, "invalid_request", reconciled.message);
  }
  await options.store.put(reconciled.record);
  await commitAcpIdempotency(options, idempotency.lease);

  return acpJson(request, await recordToAcpSession(options, request, reconciled.record), 200);
}

async function handleAcpComplete(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  const record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  const terminalStatus = await acpTerminalStatus(options, record);
  if (terminalStatus === "completed") {
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, record), 200);
  }
  if (terminalStatus === "canceled") {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpTerminalError(request, terminalStatus, "completed");
  }

  // A prior complete already started the Mika checkout for this ACP session and
  // it is not yet terminal (terminal cases handled above). Resume that checkout
  // instead of starting a second provider checkout, which would create
  // duplicate reservations. This binding must hold even when the retry arrives
  // with a different client Idempotency-Key.
  if (record.checkoutId) {
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, record), 200);
  }

  const body = await readJson<MikaAcpCheckoutCompleteRequest>(request);
  if (!body.ok) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, 400, "invalid_request", body.message);
  }
  if (!body.data.payment_data?.token || !body.data.payment_data.provider) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(
      request,
      400,
      "invalid_request",
      "payment_data.token and provider are required.",
      "$.payment_data",
    );
  }
  const expectedProvider = providerToAcp(record.provider);
  if (body.data.payment_data.provider !== expectedProvider) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(
      request,
      400,
      "invalid_request",
      `payment_data.provider must be '${expectedProvider}' for this checkout session.`,
      "$.payment_data.provider",
    );
  }
  if (body.data.payment_data.provider !== "stripe") {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(
      request,
      400,
      "invalid_request",
      "ACP delegated checkout currently supports Stripe shared payment tokens only.",
      "$.payment_data.provider",
    );
  }

  const preview = await previewAcpCheckout(options, request, record);
  if (!preview.ok) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, preview.status, "invalid_request", resultMessage(preview));
  }
  if (!preview.data.inputHash || preview.data.status !== "requires_payment_authorization") {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, 409, "invalid_request", "Checkout session is not ready for payment.");
  }

  const proofId = `acp_payment_authorization_${cryptoSafeId()}`;
  const ctx = acpContext(options, request, record.sessionId);
  const checkout = await options.api.checkout.start(ctx, {
    cartId: record.cartId,
    provider: record.provider,
    customer: buyerToCustomer(body.data.buyer ?? record.buyer),
    customFields: {
      [MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY]: body.data.payment_data.token,
      [MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY]: body.data.payment_data.provider,
      [MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY]: proofId,
      acpCheckoutSessionId: record.id,
      acpPaymentAuthorizationInputHash: preview.data.inputHash,
    },
  });
  if (!checkout.ok) {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpError(request, checkout.status, "invalid_request", resultMessage(checkout));
  }

  const completed: MikaAcpSessionRecord = {
    ...record,
    buyer: body.data.buyer ?? record.buyer,
    checkoutId: checkout.data.id,
    status: checkout.data.status === "completed" ? "completed" : "ready_for_payment",
    paymentAuthorizationId: proofId,
    quoteInputHash: preview.data.inputHash,
    updatedAt: nowIso(options),
  };
  await options.store.put(completed);
  await commitAcpIdempotency(options, idempotency.lease);

  return acpJson(request, await recordToAcpSession(options, request, completed), 200);
}

async function handleAcpGet(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, false);
  if (preflight) return preflight;

  const record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");

  return acpJson(request, await recordToAcpSession(options, request, record), 200);
}

async function handleAcpCancel(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
): Promise<Response> {
  const preflight = await verifyAcpRequest(options, request, true);
  if (preflight) return preflight;

  const record = await options.store.get(checkoutSessionId);
  if (!record) return acpError(request, 404, "invalid_request", "Checkout session was not found.");
  const idempotency = await beginAcpIdempotency(options, request, checkoutSessionId, 200);
  if (!idempotency.ok) return idempotency.response;
  const terminalStatus = await acpTerminalStatus(options, record);
  if (terminalStatus === "completed") {
    await releaseAcpIdempotency(options, idempotency.lease);

    return acpTerminalError(request, terminalStatus, "canceled");
  }
  if (terminalStatus === "canceled") {
    await commitAcpIdempotency(options, idempotency.lease);

    return acpJson(request, await recordToAcpSession(options, request, record), 200);
  }

  // Cancel the bound Mika checkout before flipping the local record so the
  // provider session is abandoned and its stock reservations are released.
  // Without this the ACP record reads "canceled" while the underlying Mika
  // checkout stays live, orphaning reservations and leaving the cart locked.
  if (record.checkoutId) {
    const cancellation = await options.api.checkout.cancel(
      acpContext(options, request, record.sessionId),
      { checkoutId: record.checkoutId },
    );
    // A 404 means the bound checkout is already gone, so the ACP record can
    // still proceed to `canceled`; any other failure must surface so we never
    // report a cancellation we did not perform.
    if (!cancellation.ok && cancellation.status !== 404) {
      await releaseAcpIdempotency(options, idempotency.lease);

      return acpError(request, cancellation.status, "invalid_request", resultMessage(cancellation));
    }
  }

  const canceled: MikaAcpSessionRecord = {
    ...record,
    status: "canceled",
    updatedAt: nowIso(options),
  };
  await options.store.put(canceled);
  await commitAcpIdempotency(options, idempotency.lease);

  return acpJson(request, await recordToAcpSession(options, request, canceled), 200);
}

interface MikaAcpIdempotencyLease {
  readonly key: string;
  readonly id: string;
  readonly claimed: boolean;
}

type MikaAcpIdempotencyBegin =
  | { readonly ok: true; readonly lease?: MikaAcpIdempotencyLease }
  | { readonly ok: false; readonly response: Response };

async function beginAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  checkoutSessionId: string,
  replayStatus: number,
): Promise<MikaAcpIdempotencyBegin> {
  const key = acpIdempotencyStoreKey(request);
  if (!key) return { ok: true };

  if (options.store.claimIdempotencyKey) {
    const claim = await options.store.claimIdempotencyKey(key, checkoutSessionId);
    if (claim.status === "claimed") {
      return { ok: true, lease: { key, id: checkoutSessionId, claimed: true } };
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

  const replayed = await options.store.getByIdempotencyKey?.(key);
  if (!replayed) return { ok: true, lease: { key, id: checkoutSessionId, claimed: false } };
  if (replayed.id !== checkoutSessionId) {
    return {
      ok: false,
      response: acpError(
        request,
        409,
        "request_not_idempotent",
        "Idempotency-Key is already bound to another checkout session.",
      ),
    };
  }

  return {
    ok: false,
    response: acpJson(request, await recordToAcpSession(options, request, replayed), replayStatus),
  };
}

async function commitAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  if (lease) await options.store.bindIdempotencyKey?.(lease.key, lease.id);
}

async function releaseAcpIdempotency(
  options: CreateMikaAcpCheckoutHandlersOptions,
  lease: MikaAcpIdempotencyLease | undefined,
): Promise<void> {
  if (lease?.claimed) await options.store.releaseIdempotencyKey?.(lease.key, lease.id);
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
  | { readonly ok: false; readonly message: string }
> {
  const ctx = acpContext(options, request, record.sessionId);
  const cartResult = await options.api.cart.get(ctx);
  if (!cartResult.ok) return { ok: false, message: resultMessage(cartResult) };

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
        message: error instanceof Error ? error.message : "ACP item id is invalid.",
      };
    }
  }

  const originalCart = cartResult.data;
  let cart = cartResult.data;
  for (const line of cart.items) {
    const removed = await options.api.cart.remove(ctx, { lineId: line.id });
    if (!removed.ok) {
      const rollbackMessage = await restoreAcpCart(options, ctx, originalCart);

      return {
        ok: false,
        message: rollbackMessage
          ? `${resultMessage(removed)} Cart rollback failed: ${rollbackMessage}`
          : resultMessage(removed),
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
        message: rollbackMessage
          ? `${resultMessage(added)} Cart rollback failed: ${rollbackMessage}`
          : resultMessage(added),
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

  return acpCheckoutSessionFromState({
    record,
    quote: quote.ok ? quote.data : emptyQuote(record),
    checkout: checkoutStatus?.ok ? checkoutStatus.data : undefined,
    seller: options.seller,
    orderUrl: options.orderUrl?.({ checkoutId: record.checkoutId, sessionId: record.id }),
  });
}

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

  // Backorder sellables are purchasable regardless of on-hand quantity (the
  // reserve path accepts policy != finite / allow_backorder), so a zero
  // availableQuantity must not flip them to out_of_stock. Surface the real
  // backorder status so the feed advertises them correctly.
  if (status === "backorder") {
    return { available: true, status: "backorder" };
  }

  // Untracked stock is unbounded, so it is always in stock.
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
    if (request.headers.get("Authorization") !== expected) {
      return acpError(request, 401, "unauthorized", "ACP authorization failed.");
    }
  }
  if (bodyRequired && !request.headers.get("Idempotency-Key")) {
    return acpError(request, 400, "request_not_idempotent", "Idempotency-Key header is required.");
  }
  if (!options.signatureSecret) return undefined;

  const signature = request.headers.get("Signature");
  if (!signature)
    return acpError(request, 401, "signature_invalid", "Signature header is required.");
  const payload = await request.clone().text();
  const expected = await hmacBase64(options.signatureSecret, payload);
  if (!constantTimeEqual(signature, expected)) {
    return acpError(request, 401, "signature_invalid", "ACP request signature is invalid.");
  }

  return undefined;
}

async function readJson<T>(
  request: Request,
): Promise<
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string }
> {
  try {
    return { ok: true, data: (await request.json()) as T };
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }
}

async function previewAcpCheckout(
  options: CreateMikaAcpCheckoutHandlersOptions,
  request: Request,
  record: MikaAcpSessionRecord,
): Promise<MikaApiResult<CheckoutPreviewDTO>> {
  return options.api.checkout.preview(acpContext(options, request, record.sessionId), {
    cartId: record.cartId,
    provider: record.provider,
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

function providerToAcp(provider: ProviderName | undefined): MikaAcpPaymentProvider["provider"] {
  const value = provider as string | undefined;

  return value === "adyen" || value === "braintree" ? value : "stripe";
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

function nowIso(options: CreateMikaAcpCheckoutHandlersOptions): ISODateTime {
  return createISODateTime((options.now?.() ?? new Date()).toISOString());
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
): Response {
  const body: MikaAcpError = {
    type: "invalid_request",
    code,
    message,
    ...(param ? { param } : {}),
  };

  return new Response(JSON.stringify(body), {
    status,
    headers: acpResponseHeaders(request),
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

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function createDefaultAcpSessionId(): string {
  return `${MIKA_ACP_DEFAULT_SESSION_PREFIX}_${cryptoSafeId()}`;
}

function cryptoSafeId(): string {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
}
