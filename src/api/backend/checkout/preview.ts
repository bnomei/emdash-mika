/**
 * Checkout preview and delegated-payment authorization proof.
 */
import { omitUndefined } from "../../../internal/object";
import type { JsonObject, ProviderName, PurchaseMode } from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import type {
  CartQuoteDTO,
  CheckoutPreviewDTO,
  CheckoutPreviewInput,
  StartCheckoutInput,
} from "../../types";
import type { MikaBackendDependencies } from "../ports";
import { createCartQuote, findQuoteCart, selectCartPrice } from "../quote";
import { defaultBackendCurrency, stableJsonStringify } from "../shared";
import {
  DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
  checkoutCustomMetadata,
  filterJsonObject,
} from "./helpers";

export async function createCheckoutPreview(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  previewInput: CheckoutPreviewInput,
): Promise<CheckoutPreviewDTO> {
  const quote = await createCartQuote(input, ctx, previewInput);
  const mode = await resolveCheckoutPreviewMode(input, ctx, previewInput);
  const provider = previewInput.provider ?? input.defaults?.provider;
  const inputHash = await delegatedPaymentProofHash(input, previewInput, quote, mode, provider);
  const hasPaymentAuthorization =
    previewInput.proofRefs?.some(
      (proof) =>
        proof.kind === "payment_authorization" &&
        proof.inputHash !== undefined &&
        proof.inputHash === inputHash,
    ) ?? false;
  const requiredProofs = [
    omitUndefined({
      kind: "payment_authorization" as const,
      required: true,
      reason: "Checkout start requires payment confirmation before provider handoff.",
      inputHash,
      expiresAt: quote.expiresAt,
    }),
  ];
  const status =
    quote.status === "expired"
      ? "expired"
      : quote.status === "unavailable"
        ? "unavailable"
        : hasPaymentAuthorization
          ? "ready"
          : "requires_payment_authorization";

  return omitUndefined({
    id: input.createId("checkout_preview"),
    quoteId: previewInput.quoteId ?? quote.id,
    status,
    mode,
    provider,
    quote,
    requiredProofs,
    acceptedProofs: ["consent", "mandate", "payment_authorization"],
    proofRefs: previewInput.proofRefs,
    expiresAt: quote.expiresAt,
    inputHash,
    warnings: quote.warnings,
    errors: quote.errors,
  });
}

export async function delegatedPaymentProofHash(
  input: MikaBackendDependencies,
  checkoutInput: StartCheckoutInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
): Promise<string> {
  return input.hash(
    stableJsonStringify(delegatedPaymentProofProjection(checkoutInput, quote, mode, provider)),
  );
}

export function delegatedPaymentProofProjection(
  checkoutInput: StartCheckoutInput,
  quote: CartQuoteDTO,
  mode: PurchaseMode | undefined,
  provider: ProviderName | undefined,
): unknown {
  return {
    cartId: checkoutInput.cartId ?? quote.cartId,
    sellableId: checkoutInput.sellableId,
    priceId: checkoutInput.priceId,
    quantity: checkoutInput.quantity,
    provider,
    couponCode: checkoutInput.couponCode,
    mode,
    customer: checkoutInput.customer,
    customFields: delegatedPaymentProofCustomFields(checkoutInput.customFields),
    successPath: checkoutInput.successPath,
    cancelPath: checkoutInput.cancelPath,
    returnTo: checkoutInput.returnTo,
    quote: {
      cartId: quote.cartId,
      status: quote.status,
      currency: quote.currency,
      items: quote.items,
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      shipping: quote.shipping,
      total: quote.total,
      adjustments: quote.adjustments,
      coupon: quote.coupon,
      expiresAt: quote.expiresAt,
      warnings: quote.warnings,
      errors: quote.errors,
    },
  } satisfies Record<string, unknown>;
}

export function delegatedPaymentProofCustomFields(
  customFields: JsonObject | undefined,
): JsonObject | undefined {
  const filtered = filterJsonObject(
    checkoutCustomMetadata(customFields),
    DELEGATED_PAYMENT_PROOF_VOLATILE_METADATA_KEYS,
  );

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export async function resolveCheckoutPreviewMode(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  previewInput: CheckoutPreviewInput,
): Promise<PurchaseMode | undefined> {
  if (previewInput.sellableId) {
    const catalog = await input.repositories.catalog.findItemBySellableId(previewInput.sellableId);
    const sellable = catalog?.aggregate.sellables.find(
      (item) => item.id === previewInput.sellableId,
    );
    return sellable
      ? selectCartPrice(sellable, previewInput.priceId, defaultBackendCurrency(input))?.mode
      : undefined;
  }

  const cartResult = await findQuoteCart(
    input,
    ctx,
    previewInput.cartId,
    defaultBackendCurrency(input),
  );
  const modes = new Set(cartResult.cart?.aggregate.items.map((line) => line.item.mode) ?? []);
  return modes.size === 1 ? modes.values().next().value : undefined;
}
