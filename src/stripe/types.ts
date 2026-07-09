/**
 * Stripe adapter types and public metadata key constants.
 */
import type { AdminActionResultDTO, MikaProviderCapability } from "../api/types";
import type { JsonObject, ProviderName } from "../types/primitives";
import { createProviderName } from "../types/primitives";
import {
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  type MikaProviderSyncInput,
} from "../provider";

/** Default provider id for the Stripe adapter. */
export const MIKA_STRIPE_PROVIDER_ID = createProviderName("stripe");

/** Checkout metadata key carrying an ACP delegated payment token for PaymentIntent creation. */
export const MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY =
  MIKA_DELEGATED_PAYMENT_TOKEN_METADATA_KEY;

/** Checkout metadata key naming the ACP payment provider (stripe, adyen, braintree). */
export const MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY =
  MIKA_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY;

/** Checkout metadata key storing the ACP payment authorization id after completion. */
export const MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY =
  MIKA_DELEGATED_PAYMENT_AUTHORIZATION_METADATA_KEY;

/** Minimal Stripe SDK surface required by `createMikaStripeProvider`; inject a real or mock client. */
export interface MikaStripeClient {
  readonly checkout?: {
    readonly sessions: {
      create(
        params: MikaStripeCheckoutSessionCreateParams,
        options?: MikaStripeRequestOptions,
      ): Promise<MikaStripeCheckoutSession>;
      retrieve(
        id: string,
        params?: JsonObject,
        options?: MikaStripeRequestOptions,
      ): Promise<MikaStripeCheckoutSession>;
    };
  };
  readonly paymentIntents?: {
    create(
      params: MikaStripePaymentIntentCreateParams,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripePaymentIntent>;
    retrieve?(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripePaymentIntent>;
    cancel?(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripePaymentIntent>;
  };
  readonly billingPortal?: {
    readonly sessions: {
      create(
        params: MikaStripePortalSessionCreateParams,
        options?: MikaStripeRequestOptions,
      ): Promise<MikaStripePortalSession>;
    };
  };
  readonly invoices?: {
    retrieve(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeInvoice>;
  };
  readonly refunds?: {
    create(
      params: MikaStripeRefundCreateParams,
      options?: MikaStripeRequestOptions,
    ): Promise<{
      readonly id: string;
      readonly status?: string | null;
    }>;
  };
  readonly coupons?: {
    create(
      params: MikaStripeCouponCreateParams,
      options?: MikaStripeRequestOptions,
    ): Promise<{ readonly id: string }>;
  };
  readonly subscriptions?: {
    cancel(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeSubscription>;
    update(
      id: string,
      params: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeSubscription>;
    resume?(
      id: string,
      params?: JsonObject,
      options?: MikaStripeRequestOptions,
    ): Promise<MikaStripeSubscription>;
  };
  readonly webhooks?: {
    constructEvent(payload: string, signature: string, secret: string): unknown;
  };
}

/** Configuration for the Stripe provider adapter including client, webhook secret, and optional catalog sync. */
export interface CreateMikaStripeProviderOptions {
  /** Stripe SDK client with the namespaces the adapter will call. */
  readonly stripe: MikaStripeClient;
  readonly id?: ProviderName;
  /** Webhook signing secret for constructEvent verification. */
  readonly webhookSecret?: string;
  /** Capability override; defaults are inferred from available Stripe client namespaces. */
  readonly capabilities?: readonly MikaProviderCapability[];
  /** Optional catalog sync handler for admin provider.sync operations. */
  readonly catalogSync?: (input: MikaProviderSyncInput) => Promise<AdminActionResultDTO>;
  readonly now?: () => Date;
}

/** Per-request Stripe SDK options forwarded by the adapter, primarily for idempotency keys. */
export interface MikaStripeRequestOptions {
  readonly idempotencyKey?: string;
}

/** Parameters for creating a Stripe Checkout Session from Mika cart lines and redirect URLs. */
export interface MikaStripeCheckoutSessionCreateParams {
  readonly mode: string;
  readonly line_items: readonly MikaStripeJsonObject[];
  readonly success_url: string;
  readonly cancel_url: string;
  readonly customer_email?: string;
  readonly client_reference_id?: string;
  readonly metadata?: Record<string, string>;
  readonly discounts?: readonly { readonly coupon: string }[];
}

/** Parameters for creating a one-time Stripe coupon used to apply a checkout discount. */
export interface MikaStripeCouponCreateParams {
  readonly amount_off: number;
  readonly currency: string;
  readonly duration: "once";
  readonly name?: string;
  readonly max_redemptions?: number;
  readonly metadata?: Record<string, string>;
}

/** Stripe Checkout Session resource shape used by the adapter for status and redirect mapping. */
export interface MikaStripeCheckoutSession {
  readonly id: string;
  readonly object?: string;
  readonly status?: string | null;
  readonly payment_status?: string | null;
  readonly mode?: string | null;
  readonly url?: string | null;
  readonly expires_at?: number | null;
  readonly customer?: string | null | { readonly id?: string };
  readonly payment_intent?: string | null | { readonly id?: string };
  readonly subscription?: string | null | { readonly id?: string };
  readonly metadata?: Record<string, string> | null;
  readonly [key: string]: unknown;
}

/** Parameters for creating a confirmed delegated PaymentIntent from an ACP shared payment token. */
export interface MikaStripePaymentIntentCreateParams {
  readonly amount: number;
  readonly currency: string;
  readonly confirm: boolean;
  readonly payment_method_data: MikaStripeJsonObject;
  readonly metadata?: Record<string, string>;
}

/** Stripe PaymentIntent resource shape used for delegated checkout and webhook normalization. */
export interface MikaStripePaymentIntent {
  readonly id: string;
  readonly object?: string;
  readonly status?: string | null;
  readonly amount?: number | null;
  readonly currency?: string | null;
  readonly customer?: string | null | { readonly id?: string };
  readonly latest_charge?: string | null | { readonly id?: string };
  readonly next_action?: JsonObject | null;
  readonly metadata?: Record<string, string> | null;
  readonly [key: string]: unknown;
}

/** Parameters for creating a Stripe Billing Portal session for subscription self-service. */
export interface MikaStripePortalSessionCreateParams {
  readonly customer: string;
  readonly return_url: string;
}

/** Stripe Billing Portal session resource with redirect URL and expiry timestamp. */
export interface MikaStripePortalSession {
  readonly url?: string | null;
  readonly expires_at?: number | null;
  readonly [key: string]: unknown;
}

/** Stripe Invoice resource consulted when resolving hosted invoice URLs for orders. */
export interface MikaStripeInvoice {
  readonly id: string;
  readonly hosted_invoice_url?: string | null;
  readonly status?: string | null;
  readonly [key: string]: unknown;
}

/** Parameters for issuing a full or partial refund against a payment intent or charge. */
export interface MikaStripeRefundCreateParams {
  readonly payment_intent?: string;
  readonly charge?: string;
  readonly amount?: number;
  readonly reason?: string;
}

/** Stripe Subscription resource shape used for lifecycle actions and webhook reconciliation. */
export interface MikaStripeSubscription {
  readonly id: string;
  readonly status?: string | null;
  readonly customer?: string | null | { readonly id?: string };
  readonly current_period_start?: number | null;
  readonly current_period_end?: number | null;
  readonly cancel_at_period_end?: boolean | null;
  readonly items?: {
    readonly data?: readonly {
      readonly price?: { readonly id?: string | null };
    }[];
  };
  readonly [key: string]: unknown;
}

/** Loose JSON object type for Stripe SDK payloads not modeled as dedicated interfaces. */
export type MikaStripeJsonObject = JsonObject;
