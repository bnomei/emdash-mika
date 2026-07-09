/**
 * Compile-time completeness: every public operation `*Input` exported from
 * `src/api/types.ts` must be re-exported from the `/types` barrel with the same type.
 *
 * Never executed; typechecked by `tsc -p test/tsconfig.json` as part of `npm run test`.
 * When adding a public `*Input` on the wire surface, extend both import lists and the map.
 */
import type {
  AccountDeleteInput as ApiAccountDeleteInput,
  AccountExportDownloadInput as ApiAccountExportDownloadInput,
  AccountExportInput as ApiAccountExportInput,
  AccountExportStatusInput as ApiAccountExportStatusInput,
  AccountPortalInput as ApiAccountPortalInput,
  AddCartItemInput as ApiAddCartItemInput,
  ApplyCouponInput as ApiApplyCouponInput,
  CartQuoteInput as ApiCartQuoteInput,
  CheckoutCancelInput as ApiCheckoutCancelInput,
  CheckoutCustomerInput as ApiCheckoutCustomerInput,
  CheckoutPreviewInput as ApiCheckoutPreviewInput,
  CheckoutStatusInput as ApiCheckoutStatusInput,
  DownloadIssueInput as ApiDownloadIssueInput,
  EmailResendInput as ApiEmailResendInput,
  EntitlementGrantInput as ApiEntitlementGrantInput,
  EntitlementRevokeInput as ApiEntitlementRevokeInput,
  LicenseRevokeInput as ApiLicenseRevokeInput,
  MagicLinkRequestInput as ApiMagicLinkRequestInput,
  MagicLinkVerifyInput as ApiMagicLinkVerifyInput,
  MergeCartInput as ApiMergeCartInput,
  MergeWishlistInput as ApiMergeWishlistInput,
  MoveWishlistItemToCartInput as ApiMoveWishlistItemToCartInput,
  OrderCancelInput as ApiOrderCancelInput,
  OrderInvoiceInput as ApiOrderInvoiceInput,
  OrderRefundInput as ApiOrderRefundInput,
  ProviderHealthInput as ApiProviderHealthInput,
  ProviderSyncInput as ApiProviderSyncInput,
  ReleaseExpiredReservationsInput as ApiReleaseExpiredReservationsInput,
  RemoveCartItemInput as ApiRemoveCartItemInput,
  RemoveCouponInput as ApiRemoveCouponInput,
  RemoveWishlistItemInput as ApiRemoveWishlistItemInput,
  SaveCartLineForLaterInput as ApiSaveCartLineForLaterInput,
  StartCheckoutInput as ApiStartCheckoutInput,
  StockAdjustInput as ApiStockAdjustInput,
  SubscriptionActionInput as ApiSubscriptionActionInput,
  UpdateCartItemInput as ApiUpdateCartItemInput,
  WebhookReceiveInput as ApiWebhookReceiveInput,
  WebhookReplayInput as ApiWebhookReplayInput,
  WishlistItemInput as ApiWishlistItemInput,
} from "../src/api/types";
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
  CheckoutCustomerInput,
  CheckoutPreviewInput,
  CheckoutStatusInput,
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
} from "../src/types/index";

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

type PublicOperationInputPairs = {
  AccountDeleteInput: AssertEqual<ApiAccountDeleteInput, AccountDeleteInput>;
  AccountExportDownloadInput: AssertEqual<ApiAccountExportDownloadInput, AccountExportDownloadInput>;
  AccountExportInput: AssertEqual<ApiAccountExportInput, AccountExportInput>;
  AccountExportStatusInput: AssertEqual<ApiAccountExportStatusInput, AccountExportStatusInput>;
  AccountPortalInput: AssertEqual<ApiAccountPortalInput, AccountPortalInput>;
  AddCartItemInput: AssertEqual<ApiAddCartItemInput, AddCartItemInput>;
  ApplyCouponInput: AssertEqual<ApiApplyCouponInput, ApplyCouponInput>;
  CartQuoteInput: AssertEqual<ApiCartQuoteInput, CartQuoteInput>;
  CheckoutCancelInput: AssertEqual<ApiCheckoutCancelInput, CheckoutCancelInput>;
  CheckoutCustomerInput: AssertEqual<ApiCheckoutCustomerInput, CheckoutCustomerInput>;
  CheckoutPreviewInput: AssertEqual<ApiCheckoutPreviewInput, CheckoutPreviewInput>;
  CheckoutStatusInput: AssertEqual<ApiCheckoutStatusInput, CheckoutStatusInput>;
  DownloadIssueInput: AssertEqual<ApiDownloadIssueInput, DownloadIssueInput>;
  EmailResendInput: AssertEqual<ApiEmailResendInput, EmailResendInput>;
  EntitlementGrantInput: AssertEqual<ApiEntitlementGrantInput, EntitlementGrantInput>;
  EntitlementRevokeInput: AssertEqual<ApiEntitlementRevokeInput, EntitlementRevokeInput>;
  LicenseRevokeInput: AssertEqual<ApiLicenseRevokeInput, LicenseRevokeInput>;
  MagicLinkRequestInput: AssertEqual<ApiMagicLinkRequestInput, MagicLinkRequestInput>;
  MagicLinkVerifyInput: AssertEqual<ApiMagicLinkVerifyInput, MagicLinkVerifyInput>;
  MergeCartInput: AssertEqual<ApiMergeCartInput, MergeCartInput>;
  MergeWishlistInput: AssertEqual<ApiMergeWishlistInput, MergeWishlistInput>;
  MoveWishlistItemToCartInput: AssertEqual<
    ApiMoveWishlistItemToCartInput,
    MoveWishlistItemToCartInput
  >;
  OrderCancelInput: AssertEqual<ApiOrderCancelInput, OrderCancelInput>;
  OrderInvoiceInput: AssertEqual<ApiOrderInvoiceInput, OrderInvoiceInput>;
  OrderRefundInput: AssertEqual<ApiOrderRefundInput, OrderRefundInput>;
  ProviderHealthInput: AssertEqual<ApiProviderHealthInput, ProviderHealthInput>;
  ProviderSyncInput: AssertEqual<ApiProviderSyncInput, ProviderSyncInput>;
  ReleaseExpiredReservationsInput: AssertEqual<
    ApiReleaseExpiredReservationsInput,
    ReleaseExpiredReservationsInput
  >;
  RemoveCartItemInput: AssertEqual<ApiRemoveCartItemInput, RemoveCartItemInput>;
  RemoveCouponInput: AssertEqual<ApiRemoveCouponInput, RemoveCouponInput>;
  RemoveWishlistItemInput: AssertEqual<ApiRemoveWishlistItemInput, RemoveWishlistItemInput>;
  SaveCartLineForLaterInput: AssertEqual<ApiSaveCartLineForLaterInput, SaveCartLineForLaterInput>;
  StartCheckoutInput: AssertEqual<ApiStartCheckoutInput, StartCheckoutInput>;
  StockAdjustInput: AssertEqual<ApiStockAdjustInput, StockAdjustInput>;
  SubscriptionActionInput: AssertEqual<ApiSubscriptionActionInput, SubscriptionActionInput>;
  UpdateCartItemInput: AssertEqual<ApiUpdateCartItemInput, UpdateCartItemInput>;
  WebhookReceiveInput: AssertEqual<ApiWebhookReceiveInput, WebhookReceiveInput>;
  WebhookReplayInput: AssertEqual<ApiWebhookReplayInput, WebhookReplayInput>;
  WishlistItemInput: AssertEqual<ApiWishlistItemInput, WishlistItemInput>;
};

type AllTrue<T extends Record<string, true>> = T;

export type TypesBarrelCompleteness = AllTrue<PublicOperationInputPairs>;
