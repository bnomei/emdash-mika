# Astro Storefront Example

This is the default copy path for an agent-ready Astro storefront that uses
EmDash content for products and Mika for commerce state.

The point of the example is a working content-led storefront: visible product
pages, stock-aware purchase forms, cart and checkout handoff, account/download
flows, provider webhooks, and public agent-readable metadata that all describe
the same commerce state.

## 1. Register Mika

Register the native plugin and pass the host-owned API implementation:

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import { emdash } from "emdash/astro";
import { mikaPlugin } from "@bnomei/emdash-mika";
import { api } from "./src/lib/mika-api";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [mikaPlugin({ api })],
    }),
  ],
});
```

`api` can be composed with `createMikaBackendApi()` or supplied as explicit
method overrides. See [backend and provider wiring](./backend-provider.md).

## 2. Copy Actions

Copy the template action files into the host project:

```txt
src/actions/index.ts
src/actions/mika.ts
```

The default action module is intentionally small:

```ts
import { createMikaActions } from "./mika";

export const server = {
  mika: createMikaActions(),
};
```

Add host policy with the `guard` option:

```ts
import { ActionError } from "astro:actions";
import { createMikaActions } from "./mika";

export const server = {
  mika: createMikaActions({
    guard: async (ctx, action, input) => {
      const limited = false;

      if (limited) {
        throw new ActionError({
          code: "TOO_MANY_REQUESTS",
          message: "Please try again later.",
        });
      }
    },
  }),
};
```

Use the guard for rate limits, account checks, bot checks, and temporary feature
locks. Keep Astro's `security.checkOrigin` enabled for browser-form CSRF
baseline protection.

## 3. Copy Core Storefront Components

For a product-first storefront, start with:

```txt
components/ProductPurchase.astro
components/AddToCartForm.astro
components/BuyNowForm.astro
components/WishlistForm.astro
components/VariantOptionGroups.astro
components/StockBadge.astro
components/LowStockNotice.astro
components/UnavailableNotice.astro
components/ProductStructuredData.astro
```

`ProductPurchase` is the form owner. It uses `createMikaPurchaseModel()` to
select the active sellable and price, derive hidden form fields, cap quantity by
availability, and coordinate grouped variant controls.

## 4. Render A Product Page

Host product pages stay host-owned. Mika only supplies the request-bound helper,
actions, and purchase components.

```astro
---
import { actions } from "astro:actions";
import { createMika } from "@bnomei/emdash-mika/astro";
import ProductPurchase from "../components/ProductPurchase.astro";
import ProductStructuredData from "../components/ProductStructuredData.astro";

export const prerender = false;

const Mika = createMika(Astro);
const checkoutResult = Astro.getActionResult(actions.mika.checkout.start);
if (checkoutResult?.data?.redirectUrl) {
  return Astro.redirect(checkoutResult.data.redirectUrl);
}

const addResult = Astro.getActionResult(actions.mika.cart.add);
const wishlistResult = Astro.getActionResult(actions.mika.wishlist.add);
const formError =
  checkoutResult?.error?.message ??
  addResult?.error?.message ??
  wishlistResult?.error?.message;

const id = Astro.params["id"];
if (!id) return Astro.redirect("/404");

const sellablesResult = await Mika.catalog.sellables("products", id);
const sellables = sellablesResult.ok ? sellablesResult.data : [];
---

<ProductStructuredData
  sellables={sellables}
  product={{
    name: "Product title from the host entry",
    description: "Product description from the host entry",
    url: Astro.url,
  }}
/>

{formError && <p role="alert">{formError}</p>}
<ProductPurchase sellables={sellables} />
```

Replace the placeholder product fields with the host EmDash entry data. The
important shape is that product content and routing stay in the host project,
while Mika resolves sellables and form contracts for that content reference.

## 5. Add Cart, Wishlist, Checkout, Account, And Downloads

Copy these pages when the storefront needs the full customer path:

```txt
pages/cart.astro
pages/wishlist.astro
pages/checkout/success.astro
pages/checkout/cancel.astro
pages/account.astro
pages/account/magic-link.astro
pages/download/[token].astro
pages/api/mika-webhook/[provider].ts
```

The copied pages export `prerender = false` because Astro Actions, sessions,
and request-bound cart/account state need on-demand rendering.

The webhook endpoint is a host Astro endpoint. It forwards the raw request to
`Mika.webhook.receive` and requires a provider adapter that can verify and parse
the webhook.

## Boundaries

- Browser mutations use Astro Actions such as `actions.mika.cart.add`,
  `actions.mika.checkout.start`, and `actions.mika.wishlist.add`.
- Public plugin JSON routes are limited to catalog and stock reads.
- Cart, checkout, account, subscription, webhook, admin, export, and delete
  routes are not public browser JSON mutation routes.
- Checkout cancel pages are passive return surfaces. Mika releases expired stock
  reservations from scheduled maintenance, not because a customer visits cancel.
