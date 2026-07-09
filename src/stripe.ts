/**
 * Stripe implementation of MikaProviderAdapter: hosted checkout, delegated ACP payment intents,
 * subscription lifecycle, refunds, and webhook event normalization into Mika payment events.
 */

export {
  MIKA_STRIPE_PROVIDER_ID,
  MIKA_STRIPE_DELEGATED_PAYMENT_TOKEN_METADATA_KEY,
  MIKA_STRIPE_DELEGATED_PAYMENT_PROVIDER_METADATA_KEY,
  MIKA_STRIPE_PAYMENT_AUTHORIZATION_METADATA_KEY,
  type MikaStripeClient,
  type CreateMikaStripeProviderOptions,
  type MikaStripeRequestOptions,
  type MikaStripeCheckoutSessionCreateParams,
  type MikaStripeCouponCreateParams,
  type MikaStripeCheckoutSession,
  type MikaStripePaymentIntentCreateParams,
  type MikaStripePaymentIntent,
  type MikaStripePortalSessionCreateParams,
  type MikaStripePortalSession,
  type MikaStripeInvoice,
  type MikaStripeRefundCreateParams,
  type MikaStripeSubscription,
  type MikaStripeJsonObject,
} from "./stripe/types";

export { createMikaStripeProvider } from "./stripe/provider";
