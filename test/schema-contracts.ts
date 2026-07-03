/**
 * Compile-time contracts pinning each zod input schema's parsed shape to its declared wire type.
 *
 * `satisfies z.ZodType<T>` in validation.ts only checks one-way assignability: it misses a schema
 * that silently omits an optional contract field (the parsed object still assigns to T) and a
 * schema that parses keys the contract never declared (extra properties assign fine). These
 * assertions close both gaps by requiring exact top-level key-set equality. Value types stay
 * covered by the satisfies clauses; nested shapes are not re-checked here.
 *
 * A deliberate divergence must be spelled out with `Omit<...>` and a comment at the schema —
 * see accountExportDownloadInputSchema, whose server-only `consumeToken` is stripped on purpose.
 *
 * Never executed; typechecked by `tsc -p test/tsconfig.json` as part of `npm run test`.
 */
import type {
  AccountDeleteInput,
  AccountExportDownloadInput,
  AccountExportInput,
  AccountExportStatusInput,
  AccountPortalInput,
  AddCartItemInput,
  ApplyCouponInput,
  CartQuoteInput,
  CheckoutCancelInput,
  CheckoutPreviewInput,
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
  StartCheckoutInput,
  StockAdjustInput,
  SubscriptionActionInput,
  UpdateCartItemInput,
  WebhookReceiveInput,
  WebhookReplayInput,
  WishlistItemInput,
} from "../src/api/types";
import type { MikaAgentProofRef } from "../src/api/agent-types";
import type { MikaId, StockMovementReason } from "../src/types/primitives";
import {
  z,
  accountExportDownloadInputSchema,
  accountExportStatusInputSchema,
  addCartItemInputSchema,
  agentProofRefSchema,
  applyCouponInputSchema,
  cartQuoteInputSchema,
  checkoutCancelInputSchema,
  checkoutPreviewInputSchema,
  checkoutStatusInputSchema,
  contentRefInputSchema,
  downloadIssueInputSchema,
  downloadResolveInputSchema,
  emailResendInputSchema,
  entitlementGrantInputSchema,
  entitlementRevokeInputSchema,
  licenseRevokeInputSchema,
  magicLinkRequestInputSchema,
  magicLinkVerifyInputSchema,
  mergeCartInputSchema,
  mergeWishlistInputSchema,
  moveWishlistItemToCartInputSchema,
  orderCancelInputSchema,
  orderInvoiceInputSchema,
  orderRefundInputSchema,
  providerHealthInputSchema,
  providerSyncInputSchema,
  releaseExpiredReservationsInputSchema,
  removeCartItemInputSchema,
  removeCouponInputSchema,
  removeWishlistItemInputSchema,
  returnToInputSchema,
  saveCartLineForLaterInputSchema,
  startCheckoutInputSchema,
  stockAdjustInputSchema,
  stockAvailabilityInputSchema,
  stockMovementReasonSchema,
  subscriptionCancelInputSchema,
  subscriptionChangeInputSchema,
  subscriptionRenewInputSchema,
  updateCartItemInputSchema,
  webhookReceiveInputSchema,
  webhookReplayInputSchema,
  wishlistItemInputSchema,
} from "../src/api/validation";

/** Resolves to `true` only when the schema's parsed keys and the contract's keys match exactly. */
type AssertExactKeys<TSchema, TContract> = [Exclude<keyof TContract, keyof TSchema>] extends [never]
  ? [Exclude<keyof TSchema, keyof TContract>] extends [never]
    ? true
    : { schemaParsesUndeclaredKeys: Exclude<keyof TSchema, keyof TContract> }
  : { schemaMissingContractKeys: Exclude<keyof TContract, keyof TSchema> };

/** Resolves to `true` only when the two union types are mutually assignable. */
type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const contentRefInputSchemaContract: AssertExactKeys<
  z.infer<typeof contentRefInputSchema>,
  ContentRefDTO
> = true;
export const stockAvailabilityInputSchemaContract: AssertExactKeys<
  z.infer<typeof stockAvailabilityInputSchema>,
  { readonly sellableId: MikaId }
> = true;
export const checkoutStatusInputSchemaContract: AssertExactKeys<
  z.infer<typeof checkoutStatusInputSchema>,
  CheckoutStatusInput
> = true;
export const checkoutCancelInputSchemaContract: AssertExactKeys<
  z.infer<typeof checkoutCancelInputSchema>,
  CheckoutCancelInput
> = true;
export const accountExportStatusInputSchemaContract: AssertExactKeys<
  z.infer<typeof accountExportStatusInputSchema>,
  AccountExportStatusInput
> = true;
export const accountExportDownloadInputSchemaContract: AssertExactKeys<
  z.infer<typeof accountExportDownloadInputSchema>,
  Omit<AccountExportDownloadInput, "consumeToken">
> = true;
export const downloadResolveInputSchemaContract: AssertExactKeys<
  z.infer<typeof downloadResolveInputSchema>,
  { readonly token: string }
> = true;
export const orderInvoiceInputSchemaContract: AssertExactKeys<
  z.infer<typeof orderInvoiceInputSchema>,
  OrderInvoiceInput
> = true;
export const returnToInputSchemaContract: AssertExactKeys<
  z.infer<typeof returnToInputSchema>,
  AccountExportInput & AccountDeleteInput & AccountPortalInput
> = true;
export const addCartItemInputSchemaContract: AssertExactKeys<
  z.infer<typeof addCartItemInputSchema>,
  AddCartItemInput
> = true;
export const updateCartItemInputSchemaContract: AssertExactKeys<
  z.infer<typeof updateCartItemInputSchema>,
  UpdateCartItemInput
> = true;
export const removeCartItemInputSchemaContract: AssertExactKeys<
  z.infer<typeof removeCartItemInputSchema>,
  RemoveCartItemInput
> = true;
export const mergeCartInputSchemaContract: AssertExactKeys<
  z.infer<typeof mergeCartInputSchema>,
  MergeCartInput
> = true;
export const applyCouponInputSchemaContract: AssertExactKeys<
  z.infer<typeof applyCouponInputSchema>,
  ApplyCouponInput
> = true;
export const removeCouponInputSchemaContract: AssertExactKeys<
  z.infer<typeof removeCouponInputSchema>,
  RemoveCouponInput
> = true;
export const wishlistItemInputSchemaContract: AssertExactKeys<
  z.infer<typeof wishlistItemInputSchema>,
  WishlistItemInput
> = true;
export const removeWishlistItemInputSchemaContract: AssertExactKeys<
  z.infer<typeof removeWishlistItemInputSchema>,
  RemoveWishlistItemInput
> = true;
export const moveWishlistItemToCartInputSchemaContract: AssertExactKeys<
  z.infer<typeof moveWishlistItemToCartInputSchema>,
  MoveWishlistItemToCartInput
> = true;
export const saveCartLineForLaterInputSchemaContract: AssertExactKeys<
  z.infer<typeof saveCartLineForLaterInputSchema>,
  SaveCartLineForLaterInput
> = true;
export const mergeWishlistInputSchemaContract: AssertExactKeys<
  z.infer<typeof mergeWishlistInputSchema>,
  MergeWishlistInput
> = true;
export const cartQuoteInputSchemaContract: AssertExactKeys<
  z.infer<typeof cartQuoteInputSchema>,
  CartQuoteInput
> = true;
export const startCheckoutInputSchemaContract: AssertExactKeys<
  z.infer<typeof startCheckoutInputSchema>,
  StartCheckoutInput
> = true;
export const checkoutPreviewInputSchemaContract: AssertExactKeys<
  z.infer<typeof checkoutPreviewInputSchema>,
  CheckoutPreviewInput
> = true;
export const magicLinkRequestInputSchemaContract: AssertExactKeys<
  z.infer<typeof magicLinkRequestInputSchema>,
  MagicLinkRequestInput
> = true;
export const magicLinkVerifyInputSchemaContract: AssertExactKeys<
  z.infer<typeof magicLinkVerifyInputSchema>,
  MagicLinkVerifyInput
> = true;
// Cancel deliberately omits priceId: the backend only reads it when action === "change".
export const subscriptionCancelInputSchemaContract: AssertExactKeys<
  z.infer<typeof subscriptionCancelInputSchema>,
  Omit<SubscriptionActionInput, "priceId">
> = true;
export const subscriptionChangeInputSchemaContract: AssertExactKeys<
  z.infer<typeof subscriptionChangeInputSchema>,
  SubscriptionActionInput
> = true;
// Renew deliberately omits priceId for the same reason as cancel above.
export const subscriptionRenewInputSchemaContract: AssertExactKeys<
  z.infer<typeof subscriptionRenewInputSchema>,
  Omit<SubscriptionActionInput, "priceId">
> = true;
export const webhookReceiveInputSchemaContract: AssertExactKeys<
  z.infer<typeof webhookReceiveInputSchema>,
  WebhookReceiveInput
> = true;
export const providerHealthInputSchemaContract: AssertExactKeys<
  z.infer<typeof providerHealthInputSchema>,
  ProviderHealthInput
> = true;
export const providerSyncInputSchemaContract: AssertExactKeys<
  z.infer<typeof providerSyncInputSchema>,
  ProviderSyncInput
> = true;
export const stockAdjustInputSchemaContract: AssertExactKeys<
  z.infer<typeof stockAdjustInputSchema>,
  StockAdjustInput
> = true;
export const releaseExpiredReservationsInputSchemaContract: AssertExactKeys<
  z.infer<typeof releaseExpiredReservationsInputSchema>,
  ReleaseExpiredReservationsInput
> = true;
export const webhookReplayInputSchemaContract: AssertExactKeys<
  z.infer<typeof webhookReplayInputSchema>,
  WebhookReplayInput
> = true;
export const orderRefundInputSchemaContract: AssertExactKeys<
  z.infer<typeof orderRefundInputSchema>,
  OrderRefundInput
> = true;
export const orderCancelInputSchemaContract: AssertExactKeys<
  z.infer<typeof orderCancelInputSchema>,
  OrderCancelInput
> = true;
export const entitlementGrantInputSchemaContract: AssertExactKeys<
  z.infer<typeof entitlementGrantInputSchema>,
  EntitlementGrantInput
> = true;
export const entitlementRevokeInputSchemaContract: AssertExactKeys<
  z.infer<typeof entitlementRevokeInputSchema>,
  EntitlementRevokeInput
> = true;
export const emailResendInputSchemaContract: AssertExactKeys<
  z.infer<typeof emailResendInputSchema>,
  EmailResendInput
> = true;
export const licenseRevokeInputSchemaContract: AssertExactKeys<
  z.infer<typeof licenseRevokeInputSchema>,
  LicenseRevokeInput
> = true;
export const downloadIssueInputSchemaContract: AssertExactKeys<
  z.infer<typeof downloadIssueInputSchema>,
  DownloadIssueInput
> = true;
export const stockMovementReasonSchemaContract: AssertMutuallyAssignable<
  z.infer<typeof stockMovementReasonSchema>,
  StockMovementReason
> = true;
export const agentProofRefSchemaContract: AssertMutuallyAssignable<
  z.infer<typeof agentProofRefSchema>,
  MikaAgentProofRef
> = true;
