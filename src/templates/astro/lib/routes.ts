/**
 * Canonical storefront paths for the copyable Astro template.
 * Shared by pages, forms, and checkout redirect builders.
 */
export const mikaTemplateRoutes = {
  account: "/account",
  accountMagicLink: "/account/magic-link",
  accountOrders: "/account/orders",
  accountSubscriptions: "/account/subscriptions",
  accountLicenses: "/account/licenses",
  accountDownloads: "/account/downloads",
  cart: "/cart",
  wishlist: "/wishlist",
  products: "/",
  checkoutSuccess: "/checkout/success",
  checkoutCancel: "/checkout/cancel",
} as const;

/** Checkout success URL with `checkoutId` and optional session `token` query params. */
export function mikaTemplateCheckoutSuccessHref(checkoutId: string, token?: string): string {
  const search = new URLSearchParams({ checkoutId });
  if (token) search.set("token", token);

  return `${mikaTemplateRoutes.checkoutSuccess}?${search.toString()}`;
}
