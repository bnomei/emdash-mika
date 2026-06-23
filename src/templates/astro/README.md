# Mika Astro Templates

These files are copyable Kumo UI examples for an agent-ready Astro + EmDash
storefront. They are not hidden routes owned by Mika.

Copy only the pieces the host storefront needs. Keep final product routing,
localization, auth policy, provider credentials, tax/shipping rules, and
deployment behavior in the host app.

The template should prove Mika's public position: content-led storefronts can
add carts, wishlists, checkout handoff, accounts, downloads, stock-aware
variants, and agent-readable commerce metadata without adopting a full commerce
platform.

## Examples

Use the focused examples for setup detail:

- [First release slice](./examples/release-slice.md): the package story, what
  should ship first, and what should stay out of scope.
- [Astro storefront](./examples/astro-storefront.md): plugin registration,
  actions, product pages, cart, wishlist, checkout, account, downloads, and
  webhooks.
- [Backend and provider wiring](./examples/backend-provider.md): repository
  ports, provider adapters, email delivery, and maintenance.
- [Agent-ready storefront](./examples/agent-ready-storefront.md): JSON-LD,
  `llms.txt`, `.well-known/mika-agent.json`, and protected agent boundaries.

## Directory Map

```txt
actions/
  index.ts
  mika.ts
components/
  MikaKumoAppFrame.tsx
  MikaKumoPage.astro
  ProductPurchase.astro
  AddToCartForm.astro
  BuyNowForm.astro
  WishlistForm.astro
  VariantOptionGroups.astro
  CartLines.astro
  CartSummary.astro
  CouponForm.astro
  CheckoutForm.astro
  AccountOrders.astro
  AccountSubscriptions.astro
  AccountLicenses.astro
  AccountDownloads.astro
  MagicLinkForm.astro
  AccountSignInPanel.astro
  ProductStructuredData.astro
  StockBadge.astro
  LowStockNotice.astro
  UnavailableNotice.astro
lib/
  form.ts
  routes.ts
styles/
  kumo.css
pages/
  cart.astro
  wishlist.astro
  account.astro
  account/orders.astro
  account/subscriptions.astro
  account/licenses.astro
  account/downloads.astro
  account/magic-link.astro
  checkout/success.astro
  checkout/cancel.astro
  download/[token].ts
  api/mika-webhook/[provider].ts
  llms.txt.ts
  .well-known/mika-agent.json.ts
examples/
  README.md
  release-slice.md
  astro-storefront.md
  backend-provider.md
  agent-ready-storefront.md
```

## Copy Paths

Core product flow:

```txt
actions/index.ts
actions/mika.ts
styles/kumo.css
components/MikaKumoAppFrame.tsx
components/MikaKumoPage.astro
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

Full storefront flow:

```txt
components/CartLines.astro
components/CartSummary.astro
components/CouponForm.astro
components/CheckoutForm.astro
components/WishlistList.astro
components/MagicLinkForm.astro
components/AccountSignInPanel.astro
components/AccountOrders.astro
components/AccountSubscriptions.astro
components/AccountLicenses.astro
components/AccountDownloads.astro
pages/cart.astro
pages/wishlist.astro
pages/account.astro
pages/account/orders.astro
pages/account/subscriptions.astro
pages/account/licenses.astro
pages/account/downloads.astro
pages/account/magic-link.astro
pages/checkout/success.astro
pages/checkout/cancel.astro
pages/download/[token].ts
pages/api/mika-webhook/[provider].ts
```

Agent-readable storefront flow:

```txt
components/ProductStructuredData.astro
pages/llms.txt.ts
pages/.well-known/mika-agent.json.ts
```

`ProductPurchase` is the main product form owner. It coordinates hidden
sellable/price fields, add-to-cart, buy-now, wishlist, quantity limits,
availability panels, and grouped variant selection.

Contract examples such as `CouponForm`, `CheckoutForm`, account export/delete
forms, wishlist move/save-for-later forms, focused account screens for orders,
subscriptions, licenses, and downloads, subscription actions, and the provider
webhook endpoint depend on the same request-bound Mika API and provider
adapters as the rest of the copied kit. Keep or delete them based on the
storefront and provider integration.

## Wiring

Register the native plugin in `astro.config.mjs`:

```ts
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

Install and enable Kumo UI in the host app:

```sh
npm install @cloudflare/kumo @phosphor-icons/react react react-dom @astrojs/react
```

```ts
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [react()],
});
```

The copied `styles/kumo.css` file imports Kumo's standalone stylesheet:

```css
@import "@cloudflare/kumo/styles/standalone";
```

That path works without adding Tailwind to a host app. If the host already uses
Tailwind CSS v4, replace the first line with Kumo's Tailwind setup:

```css
@source "../../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
@import "@cloudflare/kumo/styles/tailwind";
@import "tailwindcss";
```

Adjust the `@source` path to the copied CSS file location.

Copy `actions/index.ts` and `actions/mika.ts` into the host project's
`src/actions/` folder. The `mika.ts` file is only a shim over
`@bnomei/emdash-mika/astro-actions`, so the action factory stays versioned with
Mika.

When a backend API is wired through `mikaPlugin({ api })`, copied pages that
call `createMika(Astro)` and action modules that call `createMikaActions()` use
that same API by default. Pass `{ api }` directly only when a page or action
module needs different wiring.

## Imports

Use the small public subpaths in copied code:

- `@bnomei/emdash-mika/astro` for Astro helpers like `createMika()`,
  `formatMikaMoney()`, `mikaReturnTo()`, `mikaSafeReturnTo()`, and purchase
  option selection.
- `@bnomei/emdash-mika/astro-actions` from `src/actions/mika.ts`.
- `@bnomei/emdash-mika/agent` for optional agent-readable manifest examples.
- `@bnomei/emdash-mika/types` for DTOs and action/client input types.
- `@bnomei/emdash-mika/client` only when a framework island needs public
  catalog or stock JSON reads directly.

The page examples intentionally use an uppercase request-bound server helper:

```ts
const Mika = createMika(Astro);
const cartResult = await Mika.cart.get();
```

That keeps call sites visually close to `actions.mika.*` while avoiding
browser-facing plugin JSON mutation routes.

## Astro Surface

The storefront path is intentionally Astro-native and Kumo-backed:

- HTML forms submit to `action={actions.mika.*}` with `method="post"`.
- `@bnomei/emdash-mika/astro-actions` uses
  `defineAction({ accept: "form", input })` and Zod schemas, so Astro handles
  form parsing and field validation.
- Pages use `Astro.getActionResult()` for action results and redirects.
- Components use Kumo components and Kumo semantic tokens for visible UI, while
  keeping `data-mika-*` attributes for behavior and testing hooks.
- Component root elements accept `class` and normal HTML attributes, matching
  Astro's explicit `class` pass-through model.
- Common form labels and empty states are props or named slots, so copied
  components can be localized or restyled without editing Mika logic first.

Use the `guard` option in `createMikaActions()` for host policy that Mika should
not hard-code: rate limits, account checks, bot checks, or temporary feature
locks.

## Sessions And Rendering

The copied pages export `prerender = false` because Astro Actions, sessions,
and request-bound cart/account state need on-demand rendering. If the whole site
uses `output: "server"`, that export is still harmless.

Astro Sessions are a good fit for anonymous, non-resumable carts and
short-lived form state because they are server-side and available as
`Astro.session` in pages and `context.session` in actions, endpoints, and
middleware. Mika keeps sessions optional so the templates still work on sites
that use durable carts, provider checkouts, or deployments without an Astro
session driver.

Session examples require Astro 5.7 or newer.

## Route Shape

Mika has three route surfaces, and they should stay distinct:

- copied Astro pages/endpoints owned by the host project;
- Astro Actions for browser form mutations;
- EmDash plugin route keys for server/plugin integration and trusted JSON
  clients.

Mika's plugin route keys use EmDash's exact shape under:

```txt
/_emdash/api/plugins/mika/<route>
```

## Template Position

The template should stay product-led and operational, not marketing-led. It
should help a host project demonstrate:

- visible product content backed by EmDash;
- Mika sellables, prices, variants, stock, cart, wishlist, checkout, account,
  subscription, license, and download flows;
- JSON-LD, `llms.txt`, and `.well-known/mika-agent.json` that match the visible
  catalog and availability;
- protected checkout, payment, account, admin, and agent-tool boundaries owned
  by the host app.

Do not turn these templates into a page builder, bundled storefront theme,
payment-provider SDK, OAuth issuer, MCP server, tax engine, shipping engine, or
marketplace layer.

Agent manifest `route.path` values are relative to that plugin base path. IDs
are passed in query strings or JSON bodies rather than dynamic route segments.
The only public plugin JSON routes are catalog sellables and sellable
availability.

Do not treat plugin JSON routes as the default browser mutation surface for
carts, checkout, accounts, exports, deletes, webhooks, admin actions, or
subscriptions until the route is explicitly designed with the right EmDash auth,
CSRF, rate-limit, and method gates.

The copied `download/[token].ts` endpoint uses the request-bound Mika helper as
a redirect resolver. If a site needs private file streaming instead of signed
redirects, wire that endpoint to a server-only Mika service rather than the
browser-safe JSON client.

Use `mikaSafeReturnTo()` for host-owned return fields that are not produced by
the copied helpers. Mika treats form-provided `returnTo`, checkout success, and
checkout cancel values as same-origin local paths; backend checkout config is
trusted deployment configuration.

Checkout cancel pages are passive browser return surfaces. Expired stock
reservations are released by Mika's `mika_maintenance` plugin cron task, which
EmDash runs during its scheduled cycle. Do not release stock solely because a
customer visited the cancel page while a provider-hosted checkout session may
still be open.

Provider webhooks and raw-body signature verification should be host Astro
endpoints or explicitly supported EmDash raw-body public routes, not generic
plugin JSON routes by default. The copied webhook endpoint is a host Astro
endpoint that forwards the raw request to `Mika.webhook.receive`; it requires a
provider adapter with `verifyWebhook()` and `parseWebhookEvent()`.

## Security Boundary

The public storefront examples call Astro Actions first. Keep Astro's default
`security.checkOrigin` enabled for the browser-form CSRF baseline, and use the
action `guard` option or host middleware for rate limiting and authorization.

Real Mika route handlers must still enforce Mika-level stock idempotency, token
expiry, provider signature checks, and direct-route protection. Required Mika
idempotency keys are enforced on admin and agent runner paths. Storefront
checkout and subscription forms stay browser-friendly here, while checkout
replay is handled by Mika's internal checkout idempotency storage when the host
request context supplies a key.

Use `createMikaAgentManifest()` only as a descriptor source for host-owned
agent endpoints. It does not publish protected mutation routes, validate OAuth
tokens, verify AP2 mandates, run MCP servers, store idempotency records, or
process MPP/x402 payments.
