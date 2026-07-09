/**
 * Zod-free plugin route key → path segment map.
 *
 * Browser-safe source of truth for URL construction (`/client`, {@link ./routes}).
 * Operation schemas, dispatch, and agent metadata stay in {@link ./operations}; that
 * module asserts IR route keys/paths stay aligned with this map at load time.
 */

/** Stable plugin route key to relative path segment (no plugin id / api base prefix). */
export const mikaPluginRoutePaths = {
  actionsManifest: ".well-known/actions",
  actionsRunner: ".well-known/actions/run",
  catalogSellables: "catalog/sellables",
  sellableAvailability: "sellables/availability",
  cart: "cart",
  cartQuote: "cart/quote",
  cartItems: "cart/items",
  cartItem: "cart/item",
  cartMerge: "cart/merge",
  cartCoupon: "cart/coupon",
  wishlist: "wishlist",
  wishlistItems: "wishlist/items",
  wishlistItem: "wishlist/item",
  wishlistMoveToCart: "wishlist/move-to-cart",
  wishlistSaveForLater: "wishlist/save-for-later",
  wishlistMerge: "wishlist/merge",
  checkout: "checkout",
  checkoutPreview: "checkout/preview",
  checkoutStatus: "checkout/status",
  checkoutAbandon: "checkout/abandon",
  magicLink: "magic-link",
  magicLinkVerify: "magic-link/verify",
  account: "account",
  accountExport: "account/export",
  accountExportStatus: "account/export/status",
  accountExportDownload: "account/export/download",
  accountDelete: "account/delete",
  accountPortal: "account/portal",
  subscriptionCancel: "subscriptions/cancel",
  subscriptionChange: "subscriptions/change",
  subscriptionRenew: "subscriptions/renew",
  download: "download",
  downloadConfirm: "download/confirm",
  orderInvoice: "orders/invoice",
  webhook: "webhooks",
  adminProviderHealth: "admin/provider/health",
  adminProviderSync: "admin/provider/sync",
  adminStockAdjust: "admin/stock/adjust",
  adminStockReleaseExpiredReservations: "admin/stock/release-expired-reservations",
  adminWebhookReplay: "admin/webhooks/replay",
  adminOrderRefund: "admin/orders/refund",
  adminOrderCancel: "admin/orders/cancel",
  adminEntitlementGrant: "admin/entitlements/grant",
  adminEntitlementRevoke: "admin/entitlements/revoke",
  adminEmailResend: "admin/emails/resend",
  adminLicenseRevoke: "admin/licenses/revoke",
  adminDownloadIssue: "admin/downloads/issue",
} as const;

/** Union of stable plugin route keys. */
export type MikaPluginRouteName = keyof typeof mikaPluginRoutePaths;

/**
 * Route keys exposed without authentication (`public: true` on the operation IR).
 * Order is part of the public contract (locked by tests).
 */
export const publicMikaPluginRouteNames = [
  "catalogSellables",
  "sellableAvailability",
] as const satisfies readonly MikaPluginRouteName[];

/** Route keys for operations that do not require authentication. */
export type MikaPublicPluginRouteName = (typeof publicMikaPluginRouteNames)[number];
