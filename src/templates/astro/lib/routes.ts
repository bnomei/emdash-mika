export const mikaTemplateRoutes = {
  account: "/account",
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

export function mikaTemplateCheckoutSuccessHref(checkoutId: string): string {
  return `${mikaTemplateRoutes.checkoutSuccess}?checkoutId=${encodeURIComponent(checkoutId)}`;
}
