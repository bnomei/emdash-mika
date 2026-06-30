/**
 * Zod input schemas and parsers for Mika operations, form posts, and search-param transports.
 * Re-exports `z` for co-located schema and handler definitions.
 */
import { z } from "astro/zod";

import type {
  AccountDeleteInput,
  AccountExportDownloadInput,
  AccountExportInput,
  AccountExportStatusInput,
  AccountPortalInput,
  AddCartItemInput,
  ApplyCouponInput,
  CartQuoteInput,
  CheckoutPreviewInput,
  CheckoutCancelInput,
  CheckoutStatusInput,
  ContentRefDTO,
  DownloadIssueInput,
  EmailResendInput,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  LicenseRevokeInput,
  MagicLinkRequestInput,
  MagicLinkVerifyInput,
  MergeCartInput,
  MergeWishlistInput,
  MoveWishlistItemToCartInput,
  OrderCancelInput,
  OrderInvoiceInput,
  OrderRefundInput,
  ProviderHealthInput,
  ProviderSyncInput,
  ReleaseExpiredReservationsInput,
  RemoveCartItemInput,
  RemoveCouponInput,
  RemoveWishlistItemInput,
  SaveCartLineForLaterInput,
  StockAdjustInput,
  StartCheckoutInput,
  SubscriptionActionInput,
  UpdateCartItemInput,
  WebhookReceiveInput,
  WebhookReplayInput,
  WishlistItemInput,
} from "./types";
import type { MikaAgentProofRef } from "./agent-types";
import type { MikaApiResult } from "./types";
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

export { z };

/** Local validation outcome before mapping to a {@link MikaApiResult} failure. */
export type MikaValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly result: MikaApiResult<never> };

export const requiredStringSchema = z.string().trim().min(1);
export const optionalStringSchema = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(1).optional(),
);

export const mikaIdSchema = brandedStringSchema(createMikaId, "MikaId");
export const optionalMikaIdSchema = z.preprocess(emptyToUndefined, mikaIdSchema.optional());
export const isoDateTimeSchema = brandedStringSchema(createISODateTime, "ISODateTime");
export const optionalISODateTimeSchema = z.preprocess(
  emptyToUndefined,
  isoDateTimeSchema.optional(),
);
export const currencyCodeSchema = brandedStringSchema(createCurrencyCode, "CurrencyCode");
export const optionalCurrencyCodeSchema = z.preprocess(
  emptyToUndefined,
  currencyCodeSchema.optional(),
);
export const providerNameSchema = brandedStringSchema(createProviderName, "ProviderName");
export const optionalProviderNameSchema = z.preprocess(
  emptyToUndefined,
  providerNameSchema.optional(),
);

export const quantitySchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? 1 : Number(value)),
  z.number().int().positive(),
);
export const optionalQuantitySchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? undefined : Number(value)),
  z.number().int().positive().optional(),
);
export const integerSchema = z.preprocess((value) => Number(value), z.number().int());
export const optionalAmountSchema = z.preprocess(
  (value) => (value === null || value === undefined || value === "" ? undefined : Number(value)),
  z.number().finite().nonnegative().optional(),
);

export const jsonObjectSchema = z.custom<JsonObject>(isJsonObject, {
  message: "Expected JSON object.",
});
export const optionalJsonObjectSchema = z.preprocess(
  parseJsonFormValue,
  jsonObjectSchema.optional(),
);
export const stockMovementReasonSchema = z.enum([
  "manual_adjustment",
  "reservation",
  "release",
  "sale",
  "refund",
  "sync",
]) satisfies z.ZodType<StockMovementReason>;
export const variantOptionsSchema = z.preprocess(
  parseJsonFormValue,
  z.record(z.string(), z.string()).optional(),
);

export const contentRefInputSchema = z.object({
  collection: requiredStringSchema,
  id: requiredStringSchema,
  locale: optionalStringSchema,
}) satisfies z.ZodType<ContentRefDTO>;

export const stockAvailabilityInputSchema = z.object({
  sellableId: mikaIdSchema,
}) satisfies z.ZodType<{ readonly sellableId: MikaId }>;

export const checkoutStatusInputSchema = z.object({
  checkoutId: mikaIdSchema,
  token: optionalStringSchema,
}) satisfies z.ZodType<CheckoutStatusInput>;

export const checkoutCancelInputSchema = z.object({
  checkoutId: mikaIdSchema,
}) satisfies z.ZodType<CheckoutCancelInput>;

export const accountExportStatusInputSchema = z.object({
  exportId: mikaIdSchema,
}) satisfies z.ZodType<AccountExportStatusInput>;

export const accountExportDownloadInputSchema = z.object({
  exportId: mikaIdSchema,
  token: optionalStringSchema,
}) satisfies z.ZodType<AccountExportDownloadInput>;

export const downloadResolveInputSchema = z.object({
  token: requiredStringSchema,
}) satisfies z.ZodType<{ readonly token: string }>;

export const orderInvoiceInputSchema = z.object({
  orderId: mikaIdSchema,
  token: optionalStringSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<OrderInvoiceInput>;

export const returnToInputSchema = z.object({
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<AccountExportInput & AccountDeleteInput & AccountPortalInput>;

export const addCartItemInputSchema = z.object({
  sellableId: mikaIdSchema,
  priceId: optionalMikaIdSchema,
  quantity: optionalQuantitySchema,
  variantKey: optionalStringSchema,
  variantOptions: variantOptionsSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<AddCartItemInput>;

export const cartAddFormInputSchema = z.object({
  sellableId: optionalMikaIdSchema,
  priceId: optionalMikaIdSchema,
  purchase: optionalStringSchema,
  variantKey: optionalStringSchema,
  variantOptions: variantOptionsSchema,
  quantity: quantitySchema,
  returnTo: optionalStringSchema,
});

export const updateCartItemInputSchema = z.object({
  lineId: mikaIdSchema,
  quantity: quantitySchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<UpdateCartItemInput>;

export const removeCartItemInputSchema = z.object({
  lineId: mikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<RemoveCartItemInput>;

export const mergeCartInputSchema = z.object({
  sourceSessionId: optionalStringSchema,
  targetCartId: optionalMikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<MergeCartInput>;

export const applyCouponInputSchema = z.object({
  code: requiredStringSchema,
  cartId: optionalMikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<ApplyCouponInput>;

export const removeCouponInputSchema = z.object({
  cartId: optionalMikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<RemoveCouponInput>;

export const wishlistItemInputSchema = z.object({
  sellableId: mikaIdSchema,
  priceId: optionalMikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<WishlistItemInput>;

export const removeWishlistItemInputSchema = z.object({
  itemId: mikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<RemoveWishlistItemInput>;

export const moveWishlistItemToCartInputSchema = z.object({
  itemId: mikaIdSchema,
  quantity: optionalQuantitySchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<MoveWishlistItemToCartInput>;

export const saveCartLineForLaterInputSchema = z.object({
  lineId: mikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<SaveCartLineForLaterInput>;

export const mergeWishlistInputSchema = z.object({
  sourceSessionId: optionalStringSchema,
  targetWishlistId: optionalMikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<MergeWishlistInput>;

const checkoutCustomerInputSchema = z.object({
  email: optionalStringSchema,
  name: optionalStringSchema,
  company: optionalStringSchema,
  vatId: optionalStringSchema,
});

export const cartQuoteInputSchema = z.object({
  cartId: optionalMikaIdSchema,
  sellableId: optionalMikaIdSchema,
  priceId: optionalMikaIdSchema,
  quantity: optionalQuantitySchema,
  couponCode: optionalStringSchema,
  customer: checkoutCustomerInputSchema.optional(),
  customFields: optionalJsonObjectSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<CartQuoteInput>;

export const startCheckoutInputSchema = z.object({
  cartId: optionalMikaIdSchema,
  sellableId: optionalMikaIdSchema,
  priceId: optionalMikaIdSchema,
  quantity: optionalQuantitySchema,
  provider: optionalProviderNameSchema,
  couponCode: optionalStringSchema,
  customer: checkoutCustomerInputSchema.optional(),
  customFields: optionalJsonObjectSchema,
  successPath: optionalStringSchema,
  cancelPath: optionalStringSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<StartCheckoutInput>;

const proofRefBaseShape = {
  id: requiredStringSchema,
  issuer: optionalStringSchema,
  subject: optionalStringSchema,
  issuedAt: optionalISODateTimeSchema,
  expiresAt: optionalISODateTimeSchema,
  inputHash: optionalStringSchema,
  raw: optionalJsonObjectSchema,
} as const;

export const agentProofRefSchema = z.discriminatedUnion("kind", [
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
]) satisfies z.ZodType<MikaAgentProofRef>;

export const checkoutPreviewInputSchema = startCheckoutInputSchema.extend({
  quoteId: optionalMikaIdSchema,
  proofRefs: z.array(agentProofRefSchema).optional(),
}) satisfies z.ZodType<CheckoutPreviewInput>;

export const checkoutStartFormInputSchema = z.object({
  cartId: optionalMikaIdSchema,
  sellableId: optionalMikaIdSchema,
  priceId: optionalMikaIdSchema,
  quantity: optionalQuantitySchema,
  provider: optionalProviderNameSchema,
  couponCode: optionalStringSchema,
  email: optionalStringSchema,
  name: optionalStringSchema,
  company: optionalStringSchema,
  vatId: optionalStringSchema,
  customFields: optionalJsonObjectSchema,
  successPath: optionalStringSchema,
  cancelPath: optionalStringSchema,
  returnTo: optionalStringSchema,
});

export const magicLinkRequestInputSchema = z.object({
  email: z.string().trim().email(),
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<MagicLinkRequestInput>;

export const magicLinkVerifyInputSchema = z.object({
  token: requiredStringSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<MagicLinkVerifyInput>;

export const subscriptionCancelInputSchema = z.object({
  subscriptionId: mikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<SubscriptionActionInput>;

export const subscriptionChangeInputSchema = z.object({
  subscriptionId: mikaIdSchema,
  priceId: optionalMikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<SubscriptionActionInput>;

export const subscriptionRenewInputSchema = z.object({
  subscriptionId: mikaIdSchema,
  returnTo: optionalStringSchema,
}) satisfies z.ZodType<SubscriptionActionInput>;

export const webhookReceiveInputSchema = z.object({
  provider: providerNameSchema,
  eventType: optionalStringSchema,
  payloadHash: optionalStringSchema,
  providerEventId: optionalStringSchema,
}) satisfies z.ZodType<WebhookReceiveInput>;

export const providerHealthInputSchema = z.object({
  provider: optionalProviderNameSchema,
}) satisfies z.ZodType<ProviderHealthInput>;

export const providerSyncInputSchema = z
  .object({
    provider: optionalProviderNameSchema,
    mode: z.enum(["dry_run", "apply"]).optional(),
    scope: z.enum(["all", "entry"]).optional(),
    contentRef: contentRefInputSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scope === "entry" && !input.contentRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentRef"],
        message: "Entry-scoped provider sync requires contentRef.",
      });
    }
  }) satisfies z.ZodType<ProviderSyncInput>;

export const stockAdjustInputSchema = z.object({
  stockItemId: mikaIdSchema,
  quantityDelta: integerSchema,
  reason: stockMovementReasonSchema.optional(),
  adminAuditId: optionalMikaIdSchema,
  idempotencyKey: optionalStringSchema,
  metadata: optionalJsonObjectSchema,
}) satisfies z.ZodType<StockAdjustInput>;

export const releaseExpiredReservationsInputSchema = z.object({
  now: optionalISODateTimeSchema,
}) satisfies z.ZodType<ReleaseExpiredReservationsInput>;

export const webhookReplayInputSchema = z.object({
  webhookId: mikaIdSchema,
}) satisfies z.ZodType<WebhookReplayInput>;

export const orderRefundInputSchema = z.object({
  orderId: mikaIdSchema,
  amount: optionalAmountSchema,
  reason: optionalStringSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<OrderRefundInput>;

export const orderCancelInputSchema = z.object({
  orderId: mikaIdSchema,
  reason: optionalStringSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<OrderCancelInput>;

export const entitlementGrantInputSchema = z.object({
  entitlementKey: requiredStringSchema,
  customerId: optionalMikaIdSchema,
  userId: optionalStringSchema,
  email: optionalStringSchema,
  expiresAt: optionalISODateTimeSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<EntitlementGrantInput>;

export const entitlementRevokeInputSchema = z.object({
  entitlementId: optionalMikaIdSchema,
  entitlementKey: optionalStringSchema,
  customerId: optionalMikaIdSchema,
  reason: optionalStringSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<EntitlementRevokeInput>;

export const emailResendInputSchema = z.object({
  emailId: mikaIdSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<EmailResendInput>;

export const licenseRevokeInputSchema = z.object({
  licenseId: mikaIdSchema,
  reason: optionalStringSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<LicenseRevokeInput>;

export const downloadIssueInputSchema = z.object({
  entitlementId: optionalMikaIdSchema,
  orderId: optionalMikaIdSchema,
  orderLineId: optionalMikaIdSchema,
  expiresAt: optionalISODateTimeSchema,
  idempotencyKey: optionalStringSchema,
}) satisfies z.ZodType<DownloadIssueInput>;

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
export function parseJsonFormValue(value: unknown): unknown {
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
