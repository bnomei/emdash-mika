/**
 * Server-side cart badge helper for the Astro storefront template.
 * Reads the session cart and returns a safe item count for layout shells.
 */
import { createMika } from "@bnomei/emdash-mika/astro";
import { mikaTemplateCartItemCount } from "./display";

/**
 * Returns total line-item quantity for the current session cart, or 0 on failure.
 */
export async function mikaTemplateCurrentCartItemCount(
  ctx: Parameters<typeof createMika>[0],
): Promise<number> {
  try {
    const Mika = createMika(ctx);
    const cartResult = await Mika.cart.get();
    return cartResult.ok ? mikaTemplateCartItemCount(cartResult.data) : 0;
  } catch {
    // Layout shells must not break when cart reads fail.
    return 0;
  }
}
