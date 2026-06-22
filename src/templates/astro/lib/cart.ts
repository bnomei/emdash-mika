import { createMika } from "@bnomei/emdash-mika/astro";
import { mikaTemplateCartItemCount } from "./display";

export async function mikaTemplateCurrentCartItemCount(
  ctx: Parameters<typeof createMika>[0],
): Promise<number> {
  try {
    const Mika = createMika(ctx);
    const cartResult = await Mika.cart.get();
    return cartResult.ok ? mikaTemplateCartItemCount(cartResult.data) : 0;
  } catch {
    return 0;
  }
}
