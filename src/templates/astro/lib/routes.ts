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

export function mikaTemplateCheckoutSuccessHref(checkoutId: string, token?: string): string {
  const search = new URLSearchParams({ checkoutId });
  if (token) search.set("token", token);

  return `${mikaTemplateRoutes.checkoutSuccess}?${search.toString()}`;
}
