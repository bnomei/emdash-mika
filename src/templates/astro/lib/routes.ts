export const mikaTemplateRoutes = {
  account: "/account",
  cart: "/cart",
  checkoutSuccess: "/checkout/success",
  checkoutCancel: "/checkout/cancel",
} as const;

export function mikaTemplateCheckoutSuccessHref(checkoutId: string): string {
  return `${mikaTemplateRoutes.checkoutSuccess}?checkoutId=${encodeURIComponent(checkoutId)}`;
}
