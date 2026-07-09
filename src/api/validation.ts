/**
 * Zod input schemas and parsers for Mika operations, form posts, and search-param transports.
 * Public operation `*Input` types are derived via `z.infer` from these schemas (source of truth).
 * Wire DTOs stay hand-written in {@link ./types}. Re-exports `z` for co-located definitions.
 */
import { z } from "astro/zod";

import type { MikaApiResult } from "./types";
import { omitUndefined } from "../internal/object";
import {
  createCurrencyCode,
  createISODateTime,
  createMikaId,
  createProviderName,
  isJsonObject,
  type CurrencyCode,
  type ISODateTime,
  type JsonObject,
  type MikaId,
  type ProviderName,
  type StockMovementReason,
} from "../types/primitives";

/** Astro Zod re-export for co-located operation schemas and action input definitions. */
export { z };

/** Local validation outcome before mapping to a {@link MikaApiResult} failure. */
export type MikaValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly result: MikaApiResult<never> };

/** Primitive string, branded id, quantity, and JSON object schemas shared across operations. */
const requiredStringSchema = z.string().trim().min(1);
/** Trimmed non-empty string, or undefined when the form field is empty. */
const optionalStringSchema = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

/** Branded {@link MikaId} string validated through {@link createMikaId}. */
const mikaIdSchema = brandedStringSchema(createMikaId, "MikaId");
/** Optional branded {@link MikaId}; empty form values become undefined. */
const optionalMikaIdSchema = z.preprocess(emptyToUndefined, mikaIdSchema.optional());
/** Branded {@link ISODateTime} string validated through {@link createISODateTime}. */
const isoDateTimeSchema = brandedStringSchema(createISODateTime, "ISODateTime");
/** Optional branded {@link ISODateTime}; empty form values become undefined. */
const optionalISODateTimeSchema = z.preprocess(emptyToUndefined, isoDateTimeSchema.optional());
/** Branded {@link CurrencyCode} string validated through {@link createCurrencyCode}. */
const currencyCodeSchema = brandedStringSchema(createCurrencyCode, "CurrencyCode");
/** Branded {@link ProviderName} string validated through {@link createProviderName}. */
const providerNameSchema = brandedStringSchema(createProviderName, "ProviderName");
/** Optional branded {@link ProviderName}; empty form values become undefined. */
const optionalProviderNameSchema = z.preprocess(emptyToUndefined, providerNameSchema.optional());

/** Positive integer quantity; empty form values default to 1. */
const quantitySchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? 1 : Number(value)),
  z.number().int().positive(),
);
/** Required positive integer quantity; empty or missing values are rejected. */
const requiredQuantitySchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().positive(),
);
/** Optional positive integer quantity; empty form values become undefined. */
const optionalQuantitySchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().positive().optional(),
);
/** Optional coupon override; explicit empty strings are preserved so callers can clear a coupon. */
const optionalCouponCodeSchema = z.preprocess(
  (value) => (value === null || value === undefined ? undefined : value),
  z.string().trim().optional(),
);
/** Signed integer parsed from string or numeric form values. */
const integerSchema = z.preprocess((value) => Number(value), z.number().int());
/** Optional non-negative money amount in minor units. */
const optionalAmountSchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().finite().nonnegative().optional(),
);

/** Plain JSON object guard used for custom fields and provider metadata. */
const jsonObjectSchema = z.custom<JsonObject>(isJsonObject, {
  message: "Expected JSON object.",
});
/** Optional JSON object parsed from hidden form fields or request bodies. */
const optionalJsonObjectSchema = z.preprocess(parseJsonFormValue, jsonObjectSchema.optional());
/** Stock ledger movement reason accepted by admin stock adjustments. */
export const stockMovementReasonSchema = z.enum([
  "manual_adjustment",
  "reservation",
  "release",
  "sale",
  "refund",
  "sync",
]) satisfies z.ZodType<StockMovementReason>;
/** Variant axis selections keyed by option name, parsed from JSON form transport. */
const variantOptionsSchema = z.preprocess(
  parseJsonFormValue,
  z.record(z.string(), z.string()).optional(),
);

/**
 * Wraps an object-like Zod schema with {@link omitUndefined} so parsed optionals
 * match exact-optional property contracts. Infers output from the schema (no hand type param).
 * Preserves a `shape` getter for {@link schemaAcceptsIdempotencyKey}-style detection through
 * the transform wrapper (ZodEffects has no shape of its own).
 */
function exactOptionalObject<TSchema extends z.ZodTypeAny & { readonly shape?: unknown }>(
  schema: TSchema,
): z.ZodType<
  z.output<TSchema> extends object ? ReturnType<typeof omitUndefined<z.output<TSchema>>> : never
> &
  Pick<TSchema, "shape"> {
  const transformed = schema.transform((value) =>
    omitUndefined(value as z.output<TSchema> & object),
  ) as unknown as z.ZodType<
    z.output<TSchema> extends object ? ReturnType<typeof omitUndefined<z.output<TSchema>>> : never
  > &
    Pick<TSchema, "shape">;
  Object.defineProperty(transformed, "shape", {
    configurable: true,
    get: () => schema.shape,
  });

  return transformed;
}

/** Catalog content reference and stock availability lookup schemas. */
export const contentRefInputSchema = exactOptionalObject(
  z.object({
    collection: requiredStringSchema,
    id: requiredStringSchema,
    locale: optionalStringSchema,
  }),
);

/** Sellable id for on-hand stock availability lookups. */
export const stockAvailabilityInputSchema = z.object({
  sellableId: mikaIdSchema,
}) satisfies z.ZodType<{ readonly sellableId: MikaId }>;

/** Checkout session id and optional polling token for {@link CheckoutStatusInput}. */
export const checkoutStatusInputSchema = exactOptionalObject(
  z.object({
    checkoutId: mikaIdSchema,
    token: optionalStringSchema,
  }),
);

/** Checkout session id for abandoning an in-flight checkout. */
export const checkoutCancelInputSchema = exactOptionalObject(
  z.object({
    checkoutId: mikaIdSchema,
    token: optionalStringSchema,
  }),
);

/** Export job id for polling account export readiness. */
export const accountExportStatusInputSchema = z.object({
  exportId: mikaIdSchema,
});

/**
 * Export id and optional download token for account export retrieval.
 *
 * Deliberately narrower than {@link AccountExportDownloadInput}: `consumeToken` is server-only —
 * the internal accountExportDownloadConsume operation force-sets it, and letting clients pass it
 * over the wire would let them opt out of single-use token consumption.
 * test/schema-contracts.ts pins the exact parsed shape against
 * `Omit<AccountExportDownloadInput, "consumeToken">`.
 */
export const accountExportDownloadInputSchema = exactOptionalObject(
  z.object({
    exportId: mikaIdSchema,
    token: optionalStringSchema,
  }),
);

/** Signed download token for entitlement file resolution. */
export const downloadResolveInputSchema = z.object({
  token: requiredStringSchema,
}) satisfies z.ZodType<{ readonly token: string }>;

/** Order id and optional invoice token for customer invoice access. */
export const orderInvoiceInputSchema = exactOptionalObject(
  z.object({
    orderId: mikaIdSchema,
    token: optionalStringSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Optional post-action redirect path shared by account export, delete, and portal inputs. */
export const returnToInputSchema = exactOptionalObject(
  z.object({
    returnTo: optionalStringSchema,
  }),
);

/** Sellable, price, quantity, and variant fields for {@link AddCartItemInput}. */
export const addCartItemInputSchema = exactOptionalObject(
  z.object({
    sellableId: mikaIdSchema,
    priceId: optionalMikaIdSchema,
    quantity: optionalQuantitySchema,
    variantKey: optionalStringSchema,
    variantOptions: variantOptionsSchema,
    returnTo: optionalStringSchema,
  }),
);

/** HTML form transport for add-to-cart posts, including purchase mode shortcuts. */
const cartAddFormInputBaseSchema = z.object({
  sellableId: optionalMikaIdSchema,
  priceId: optionalMikaIdSchema,
  purchase: optionalStringSchema,
  variantKey: optionalStringSchema,
  variantOptions: variantOptionsSchema,
  quantity: quantitySchema,
  returnTo: optionalStringSchema,
});

export const cartAddFormInputSchema = exactOptionalObject(cartAddFormInputBaseSchema);

/** Line id and target quantity for cart line quantity updates. */
export const updateCartItemInputSchema = exactOptionalObject(
  z.object({
    lineId: mikaIdSchema,
    quantity: requiredQuantitySchema,
    returnTo: optionalStringSchema,
  }),
);

/** Line id for removing a single cart line. */
export const removeCartItemInputSchema = exactOptionalObject(
  z.object({
    lineId: mikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Anonymous session cart merged into the current or target cart. */
export const mergeCartInputSchema = exactOptionalObject(
  z.object({
    sourceSessionId: optionalStringSchema,
    targetCartId: optionalMikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Coupon code applied to the active or specified cart. */
export const applyCouponInputSchema = exactOptionalObject(
  z.object({
    code: requiredStringSchema,
    cartId: optionalMikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Clears the applied coupon from the active or specified cart. */
export const removeCouponInputSchema = exactOptionalObject(
  z.object({
    cartId: optionalMikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Sellable and optional price for adding a wishlist item. */
export const wishlistItemInputSchema = exactOptionalObject(
  z.object({
    sellableId: mikaIdSchema,
    priceId: optionalMikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Wishlist item id for removal. */
export const removeWishlistItemInputSchema = exactOptionalObject(
  z.object({
    itemId: mikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Wishlist item moved into the cart with optional quantity override. */
export const moveWishlistItemToCartInputSchema = exactOptionalObject(
  z.object({
    itemId: mikaIdSchema,
    quantity: optionalQuantitySchema,
    returnTo: optionalStringSchema,
  }),
);

/** Cart line saved to the wishlist without deleting the sellable selection. */
export const saveCartLineForLaterInputSchema = exactOptionalObject(
  z.object({
    lineId: mikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Anonymous session wishlist merged into the current or target wishlist. */
export const mergeWishlistInputSchema = exactOptionalObject(
  z.object({
    sourceSessionId: optionalStringSchema,
    targetWishlistId: optionalMikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Optional email address; empty form values become undefined, malformed ones fail field validation. */
const optionalEmailSchema = z.preprocess(emptyToUndefined, z.string().trim().email().optional());

/** Flattened checkout customer fields shared by the nested and HTML-form transports. */
const checkoutCustomerShape = {
  email: optionalEmailSchema,
  name: optionalStringSchema,
  company: optionalStringSchema,
  vatId: optionalStringSchema,
} as const;

const checkoutCustomerInputSchema = exactOptionalObject(z.object(checkoutCustomerShape));

/** Quote, checkout start, preview, and HTML form transport schemas. */
export const cartQuoteInputSchema = exactOptionalObject(
  z.object({
    cartId: optionalMikaIdSchema,
    sellableId: optionalMikaIdSchema,
    priceId: optionalMikaIdSchema,
    quantity: optionalQuantitySchema,
    couponCode: optionalCouponCodeSchema,
    customer: checkoutCustomerInputSchema.optional(),
    customFields: optionalJsonObjectSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Cart or direct purchase handoff fields for {@link StartCheckoutInput}. */
const startCheckoutInputBaseSchema = z.object({
  cartId: optionalMikaIdSchema,
  sellableId: optionalMikaIdSchema,
  priceId: optionalMikaIdSchema,
  quantity: optionalQuantitySchema,
  provider: optionalProviderNameSchema,
  couponCode: optionalCouponCodeSchema,
  customer: checkoutCustomerInputSchema.optional(),
  customFields: optionalJsonObjectSchema,
  successPath: optionalStringSchema,
  cancelPath: optionalStringSchema,
  returnTo: optionalStringSchema,
});

export const startCheckoutInputSchema = exactOptionalObject(startCheckoutInputBaseSchema);

const proofRefBaseShape = {
  id: requiredStringSchema,
  issuer: optionalStringSchema,
  subject: optionalStringSchema,
  issuedAt: optionalISODateTimeSchema,
  expiresAt: optionalISODateTimeSchema,
  inputHash: optionalStringSchema,
  raw: optionalJsonObjectSchema,
} as const;

/** Discriminated agent proof references attached to checkout preview and sensitive operations. */
export const agentProofRefSchema = exactOptionalObject(
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("consent"),
      ...proofRefBaseShape,
    }),
    z.object({
      kind: z.literal("mandate"),
      ...proofRefBaseShape,
      mandateType: optionalStringSchema,
    }),
    z.object({
      kind: z.literal("payment_authorization"),
      ...proofRefBaseShape,
      handlerId: optionalStringSchema,
      maxAmount: z
        .object({
          amount: z.number().finite().nonnegative(),
          currency: currencyCodeSchema,
        })
        .optional(),
    }),
    z.object({
      kind: z.literal("receipt"),
      ...proofRefBaseShape,
      status: z.enum(["pending", "settled", "failed", "refunded"]).optional(),
    }),
  ]),
);

/** Checkout handoff fields plus quote binding and agent proof refs for {@link CheckoutPreviewInput}. */
export const checkoutPreviewInputSchema = exactOptionalObject(
  startCheckoutInputBaseSchema.extend({
    quoteId: optionalMikaIdSchema,
    proofRefs: z.array(agentProofRefSchema).optional(),
  }),
);

/** HTML form transport for checkout start posts with flattened customer fields. */
const checkoutStartFormInputBaseSchema = startCheckoutInputBaseSchema
  .omit({ customer: true })
  .extend(checkoutCustomerShape);

export const checkoutStartFormInputSchema = exactOptionalObject(checkoutStartFormInputBaseSchema);

/** Account magic-link auth and subscription lifecycle action schemas. */
export const magicLinkRequestInputSchema = exactOptionalObject(
  z.object({
    email: z.string().trim().email(),
    returnTo: optionalStringSchema,
  }),
);

/** One-time token and return path to complete magic-link authentication. */
export const magicLinkVerifyInputSchema = exactOptionalObject(
  z.object({
    token: requiredStringSchema,
    returnTo: optionalStringSchema,
  }),
);

/**
 * Subscription id for cancel-at-period-end or immediate cancellation.
 * Deliberately omits {@link SubscriptionActionInput}'s `priceId` — the backend only reads it for
 * plan changes, so cancel input never carries one (pinned in test/schema-contracts.ts).
 */
export const subscriptionCancelInputSchema = exactOptionalObject(
  z.object({
    subscriptionId: mikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Subscription id and optional replacement price for plan changes. */
export const subscriptionChangeInputSchema = exactOptionalObject(
  z.object({
    subscriptionId: mikaIdSchema,
    priceId: optionalMikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/**
 * Subscription id for manual renewal or payment retry handoff.
 * Deliberately omits `priceId` for the same reason as {@link subscriptionCancelInputSchema}.
 */
export const subscriptionRenewInputSchema = exactOptionalObject(
  z.object({
    subscriptionId: mikaIdSchema,
    returnTo: optionalStringSchema,
  }),
);

/** Provider webhook ingest and replay schemas. */
export const webhookReceiveInputSchema = exactOptionalObject(
  z.object({
    provider: providerNameSchema,
    eventType: optionalStringSchema,
    payloadHash: optionalStringSchema,
    providerEventId: optionalStringSchema,
  }),
);

/** Admin provider health, catalog sync, stock, and order mutation schemas. */
export const providerHealthInputSchema = exactOptionalObject(
  z.object({
    provider: optionalProviderNameSchema,
  }),
);

/** Provider, sync mode, scope, and optional catalog entry for reconciliation. */
export const providerSyncInputSchema = exactOptionalObject(
  z
    .object({
      provider: optionalProviderNameSchema,
      mode: z.enum(["dry_run", "apply"]).optional(),
      scope: z.enum(["all", "entry"]).optional(),
      contentRef: contentRefInputSchema.optional(),
      idempotencyKey: optionalStringSchema,
    })
    .superRefine((input, ctx) => {
      if (input.scope === "entry" && !input.contentRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contentRef"],
          message: "Entry-scoped provider sync requires contentRef.",
        });
      }
    }),
);

/** Stock item delta, reason, and idempotency metadata for admin inventory changes. */
export const stockAdjustInputSchema = exactOptionalObject(
  z.object({
    stockItemId: mikaIdSchema,
    quantityDelta: integerSchema,
    reason: stockMovementReasonSchema.optional(),
    adminAuditId: optionalMikaIdSchema,
    idempotencyKey: optionalStringSchema,
    metadata: optionalJsonObjectSchema,
  }),
);

/** Optional clock override for expired reservation maintenance sweeps. */
export const releaseExpiredReservationsInputSchema = exactOptionalObject(
  z.object({
    now: optionalISODateTimeSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Stored webhook event identifier for admin replay. */
export const webhookReplayInputSchema = exactOptionalObject(
  z.object({
    webhookId: mikaIdSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Order, optional partial amount, reason, and idempotency key for refunds. */
export const orderRefundInputSchema = exactOptionalObject(
  z.object({
    orderId: mikaIdSchema,
    amount: optionalAmountSchema,
    reason: optionalStringSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Order and optional reason with idempotency for cancellation. */
export const orderCancelInputSchema = exactOptionalObject(
  z.object({
    orderId: mikaIdSchema,
    reason: optionalStringSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Entitlement key and customer identity for manual access grants. */
export const entitlementGrantInputSchema = exactOptionalObject(
  z.object({
    entitlementKey: requiredStringSchema,
    customerId: optionalMikaIdSchema,
    userId: optionalStringSchema,
    email: optionalEmailSchema,
    expiresAt: optionalISODateTimeSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Entitlement or customer identifiers and reason for access revocation. */
export const entitlementRevokeInputSchema = exactOptionalObject(
  z.object({
    entitlementId: optionalMikaIdSchema,
    entitlementKey: optionalStringSchema,
    customerId: optionalMikaIdSchema,
    reason: optionalStringSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Queued email and idempotency key for delivery retry. */
export const emailResendInputSchema = exactOptionalObject(
  z.object({
    emailId: mikaIdSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** License identifier and reason for key revocation. */
export const licenseRevokeInputSchema = exactOptionalObject(
  z.object({
    licenseId: mikaIdSchema,
    reason: optionalStringSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

/** Order or entitlement anchors and expiry for issuing download tokens. */
export const downloadIssueInputSchema = exactOptionalObject(
  z.object({
    entitlementId: optionalMikaIdSchema,
    orderId: optionalMikaIdSchema,
    orderLineId: optionalMikaIdSchema,
    expiresAt: optionalISODateTimeSchema,
    idempotencyKey: optionalStringSchema,
  }),
);

// --- Public operation *Input types (Zod schemas are the source of truth) ---

/** Sellable, price, quantity, and variant selection for a new cart line. */
export type AddCartItemInput = z.infer<typeof addCartItemInputSchema>;
/** Source session or cart to fold into the shopper's active cart. */
export type MergeCartInput = z.infer<typeof mergeCartInputSchema>;
/** Cart line identifier and target quantity for in-place line updates. */
export type UpdateCartItemInput = z.infer<typeof updateCartItemInputSchema>;
/** Cart line identifier to remove from the open cart. */
export type RemoveCartItemInput = z.infer<typeof removeCartItemInputSchema>;
/** Discount code and optional cart scope for coupon application. */
export type ApplyCouponInput = z.infer<typeof applyCouponInputSchema>;
/** Optional cart scope when clearing an applied coupon. */
export type RemoveCouponInput = z.infer<typeof removeCouponInputSchema>;
/** Optional buyer identity and tax fields collected during checkout. */
export type CheckoutCustomerInput = z.infer<typeof checkoutCustomerInputSchema>;
/** Cart or ad-hoc purchase details for a priced quote before checkout. */
export type CartQuoteInput = z.infer<typeof cartQuoteInputSchema>;
/** Sellable and optional price to save for later purchase. */
export type WishlistItemInput = z.infer<typeof wishlistItemInputSchema>;
/** Wishlist entry identifier to drop from the saved list. */
export type RemoveWishlistItemInput = z.infer<typeof removeWishlistItemInputSchema>;
/** Wishlist entry and quantity to transfer into the cart. */
export type MoveWishlistItemToCartInput = z.infer<typeof moveWishlistItemToCartInputSchema>;
/** Cart line to move off the cart into the wishlist. */
export type SaveCartLineForLaterInput = z.infer<typeof saveCartLineForLaterInputSchema>;
/** Source session or wishlist to merge into the active wishlist. */
export type MergeWishlistInput = z.infer<typeof mergeWishlistInputSchema>;
/** Cart or direct purchase handoff fields plus provider and redirect paths. */
export type StartCheckoutInput = z.infer<typeof startCheckoutInputSchema>;
/** Checkout handoff fields plus quote binding and agent proof references. */
export type CheckoutPreviewInput = z.infer<typeof checkoutPreviewInputSchema>;
/** Email address and post-login return path for passwordless sign-in. */
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestInputSchema>;
/** One-time token and return path to complete magic-link authentication. */
export type MagicLinkVerifyInput = z.infer<typeof magicLinkVerifyInputSchema>;
/** Post-provider-portal return path for billing self-service. */
export type AccountPortalInput = z.infer<typeof returnToInputSchema>;
/**
 * Subscription identifier and optional plan change for lifecycle actions.
 * Cancel/renew schemas deliberately omit `priceId` (see schema-contracts).
 */
export type SubscriptionActionInput = z.infer<typeof subscriptionChangeInputSchema>;
/** Return path after requesting a personal data export. */
export type AccountExportInput = z.infer<typeof returnToInputSchema>;
/** Return path after initiating account deletion. */
export type AccountDeleteInput = z.infer<typeof returnToInputSchema>;
/** Export job identifier to poll async export readiness. */
export type AccountExportStatusInput = z.infer<typeof accountExportStatusInputSchema>;
/**
 * Export job and optional access token for secure download.
 * Extends the wire schema with server-only `consumeToken` (not accepted over the wire).
 */
export type AccountExportDownloadInput = z.infer<typeof accountExportDownloadInputSchema> & {
  readonly consumeToken?: boolean;
};
/** Checkout session and optional status token for payment polling. */
export type CheckoutStatusInput = z.infer<typeof checkoutStatusInputSchema>;
/** Checkout session to abandon before completion. */
export type CheckoutCancelInput = z.infer<typeof checkoutCancelInputSchema>;
/** Order, optional invoice token, and return path for hosted invoice access. */
export type OrderInvoiceInput = z.infer<typeof orderInvoiceInputSchema>;
/** Raw provider webhook payload presented to `webhook.receive`. */
export type WebhookReceiveInput = z.infer<typeof webhookReceiveInputSchema>;
/** Optional provider filter for adapter capability health probes. */
export type ProviderHealthInput = z.infer<typeof providerHealthInputSchema>;
/** Provider, sync mode, scope, and optional catalog entry for reconciliation. */
export type ProviderSyncInput = z.infer<typeof providerSyncInputSchema>;
/** Stock item delta, reason, and idempotency metadata for admin inventory changes. */
export type StockAdjustInput = z.infer<typeof stockAdjustInputSchema>;
/** Optional clock override for expired reservation maintenance sweeps. */
export type ReleaseExpiredReservationsInput = z.infer<typeof releaseExpiredReservationsInputSchema>;
/** Stored webhook event identifier for admin replay. */
export type WebhookReplayInput = z.infer<typeof webhookReplayInputSchema>;
/** Order, optional partial amount, reason, and idempotency key for refunds. */
export type OrderRefundInput = z.infer<typeof orderRefundInputSchema>;
/** Order and optional reason with idempotency for cancellation. */
export type OrderCancelInput = z.infer<typeof orderCancelInputSchema>;
/** Entitlement key and customer identity for manual access grants. */
export type EntitlementGrantInput = z.infer<typeof entitlementGrantInputSchema>;
/** Entitlement or customer identifiers and reason for access revocation. */
export type EntitlementRevokeInput = z.infer<typeof entitlementRevokeInputSchema>;
/** Queued email and idempotency key for delivery retry. */
export type EmailResendInput = z.infer<typeof emailResendInputSchema>;
/** License identifier and reason for key revocation. */
export type LicenseRevokeInput = z.infer<typeof licenseRevokeInputSchema>;
/** Order or entitlement anchors and expiry for issuing download tokens. */
export type DownloadIssueInput = z.infer<typeof downloadIssueInputSchema>;

/** Parses unknown input; returns a 422 {@link MikaApiResult} envelope on schema failure. */
export function parseMikaInput<T>(schema: z.ZodType<T>, input: unknown): MikaValidationResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  return { ok: false, result: validationFailure(parsed.error) };
}

/** Picks declared search keys from a URL into a plain object for Zod parsing. */
export function searchParamsObject(
  url: URL,
  keys: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, url.searchParams.get(key) ?? undefined]));
}

/** Parses JSON-encoded hidden form fields; passes through non-string values unchanged. */
function parseJsonFormValue(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") return value;

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function validationFailure(error: z.ZodError): MikaApiResult<never> {
  const fieldErrors = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join(".") || "input", issue.message]),
  );

  return {
    ok: false,
    status: 422,
    error: {
      code: "VALIDATION_FAILED",
      message: "Mika input validation failed.",
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    },
  };
}

function brandedStringSchema<T extends MikaId | ISODateTime | CurrencyCode | ProviderName>(
  create: (value: string) => T,
  label: string,
): z.ZodType<T> {
  return z
    .string()
    .trim()
    .min(1)
    .transform((value, ctx) => {
      try {
        return create(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : `Invalid ${label}.`,
        });
        return z.NEVER;
      }
    });
}

function emptyToUndefined(value: unknown): unknown {
  return value === null || value === "" ? undefined : value;
}
