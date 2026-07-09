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

## Copying and upgrading

These are copy-only files, not a package import: paste them into the host
project (`src/actions`, `src/components`, `src/lib`, `src/styles`,
`src/pages`) and edit freely — there's nothing here that expects to stay
byte-for-byte identical to the shipped copy. `lib/mika-api.ts` and
`lib/mika-plugin.ts` are the one pair meant to stay close to the original
shape, since they're the wiring contract described in
[Astro storefront](./examples/astro-storefront.md); everything else is a
starting point.

Every file under `actions/`, `components/`, `lib/`, `styles/`, and `pages/`
has a `mika-template-version: X.Y.Z` marker in its opening comment block or
frontmatter, recording the package version it was copied from (a `//`,
`/* */`, or `<!-- -->` comment as the file's syntax allows). When upgrading
`@bnomei/emdash-mika`, diff your copy against the new version's file starting
from that marker — everything below it is what actually changed since you
copied it, so the diff stays small and readable even if you've since edited
the file yourself. The marker isn't meant to be preserved: once you've
reconciled a diff, update it (or leave it stale, it's informational, not
enforced against your copy) — it only has to be accurate in this repo's own
copies, not in what a host does with them.

## Three host faces (wiring map)

Templates assume the same three faces as the package README:

1. **Backend** — `lib/mika-api.ts` exports a host-owned `MikaApi` / overrides
   (typically `createMikaBackendApi` from `@bnomei/emdash-mika/server`).
2. **In-process** — `actions/mika.ts` builds `createMikaActions({ api })`; pages
   use `createMika(Astro, { api })` from `@bnomei/emdash-mika/astro` for
   request-scoped helpers.
3. **HTTP** — optional browser `createMikaClient` for public catalog/stock only;
   server plugin routes and `createMikaServerClient` cover authenticated ops.

`lib/mika-plugin.ts` is the EmDash entrypoint that injects that same `api` into
`createMikaPlugin`. Leave `api` empty only while scaffolding — construction
fails loudly via `assertMikaApiWired` instead of answering 501 on every route.

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
  ProductPurchaseSync.astro
  AddToCartForm.astro
  AddToCartFormSync.astro
  BuyNowForm.astro
  WishlistForm.astro
  WishlistList.astro
  VariantOptionGroups.astro
  VariantSelector.astro
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
  account.ts
  cart.ts
  display.ts
  form.ts
  mika-api.ts
  mika-plugin.ts
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
  download/[token].astro
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

`lib/form.ts` is a compatibility shim for older copied templates. New copies
should import hidden-input helpers from `@bnomei/emdash-mika/astro`.

## Copy Paths

Core product flow:

```txt
actions/index.ts
actions/mika.ts
lib/display.ts
lib/routes.ts
styles/kumo.css
components/MikaKumoAppFrame.tsx
components/MikaKumoPage.astro
components/ProductPurchase.astro
components/ProductPurchaseSync.astro
components/AddToCartForm.astro
components/AddToCartFormSync.astro
components/BuyNowForm.astro
components/WishlistForm.astro
components/VariantOptionGroups.astro
components/VariantSelector.astro
components/StockBadge.astro
components/LowStockNotice.astro
components/UnavailableNotice.astro
components/ProductStructuredData.astro
```

Full storefront flow (add to the core product flow):

```txt
lib/account.ts
lib/cart.ts
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
pages/download/[token].astro
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

Account order screens should link invoices through `order.invoiceHref`. Do not
project raw provider invoice URLs into copied account templates; provider
invoice URLs belong behind Mika's protected `order.invoice` route.

## Wiring

Copy `lib/mika-plugin.ts` and `lib/mika-api.ts` into the host project's
`src/lib/` folder, replace the `mika-api.ts` stub with the host backend
(`createMikaBackendApi()` — see `examples/backend-provider.md`), and point
`mikaPlugin({ entrypoint })` at the copied `mika-plugin.ts`:

```ts
// src/lib/mika-plugin.ts — EmDash plugin entrypoint
// (copyable template: src/templates/astro/lib/mika-plugin.ts)
import { createMikaPlugin, type MikaCreatePluginOptions } from "@bnomei/emdash-mika/server";
import { api } from "./mika-api";

export function createPlugin(options: MikaCreatePluginOptions = {}) {
  return createMikaPlugin({ ...options, api });
}
```

```ts
// astro.config.mjs
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { emdash } from "emdash/astro";
import { mikaPlugin } from "@bnomei/emdash-mika";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [
        mikaPlugin({
          entrypoint: fileURLToPath(new URL("./src/lib/mika-plugin.ts", import.meta.url)),
        }),
      ],
    }),
  ],
});
```

The entrypoint module exists because the EmDash host JSON-serializes descriptor
options into a generated module — function values like a live `api` or
`operationPolicy` are silently dropped, so `mikaPlugin()` rejects them at
config time. Only JSON-safe options (`maintenance.enabled`,
`maintenance.schedule`, `assertWired`) flow through the descriptor and arrive
in the entrypoint's `options`. Use `fileURLToPath` from `node:url` rather than
`URL.pathname` — `pathname` produces `/C:/...` paths that fail module
resolution on Windows. The host imports the entrypoint from a generated
virtual module, so it must be an absolute path or a bare package specifier,
not a config-relative `./` path.

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

There is no process-global default API: every `createMika(Astro, { api })` and
`createMikaActions({ api })` call site imports `api` explicitly from
`src/lib/mika-api.ts` (the same module the plugin entrypoint merges), as the
copied pages and `actions/index.ts` already do. Pass a different `api` value
only when a page or action module needs different wiring than the rest of the
storefront.

## Imports

Use the small public subpaths in copied code:

- `@bnomei/emdash-mika/astro` for Astro helpers like `createMika()`,
  `formatMikaMoney()`, `mikaReturnTo()`, `mikaSafeReturnTo()`,
  `mikaHiddenInput()`, `mikaReturnToInput()`, `mikaRedirectInputs()`, and
  purchase option selection.
- `@bnomei/emdash-mika/astro-actions` from `src/actions/mika.ts`.
- `@bnomei/emdash-mika/acp` for host-owned ACP product-feed and checkout
  endpoint projections.
- `@bnomei/emdash-mika/agent` for optional agent-readable manifest examples.
- `@bnomei/emdash-mika/stripe` for the optional Stripe provider adapter.
- `@bnomei/emdash-mika/types` for DTOs and action/client input types.
- `@bnomei/emdash-mika/client` only when a framework island needs public
  catalog or stock JSON reads directly.

The page examples intentionally use an uppercase request-bound server helper:

```ts
import { api } from "../lib/mika-api";

const Mika = createMika(Astro, { api });
const cartResult = await Mika.cart.get();
```

That keeps call sites visually close to `actions.mika.*` while avoiding
browser-facing plugin JSON mutation routes.

## Astro Surface

The storefront path is intentionally Astro-native and Kumo-backed:

- HTML forms submit to `action={actions.mika.cart.add.queryString}`-style
  action URLs with `method="post"`.
- `@bnomei/emdash-mika/astro-actions` uses
  `defineAction({ accept: "form", input })` for browser mutations and
  `defineAction({ accept: "json", input })` for typed read/status helpers, so
  Astro handles form parsing, field validation, and JSON input validation.
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

Supported template installs target Astro 6 or 7, matching Mika's peer
dependency range. The session examples rely on Astro's server-side Sessions
API but remain optional for hosts that use durable carts or another session
driver.

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

The copied `download/[token].astro` page is a GET-validate / POST-consume
interstitial (same shape as `account/magic-link.astro`): opening the link does
NOT consume the single-use token, so email scanners, link previews, and browser
prefetch cannot burn it. The buyer's submit posts `actions.mika.download.confirm`,
which consumes the token atomically and redirects. Agents and programmatic
callers keep using the `download.resolve` (GET) plugin route. If a site needs
private file streaming instead of signed redirects, wire the confirm step to a
server-only Mika service rather than the browser-safe JSON client.

Use `mikaSafeReturnTo()` for host-owned return fields that are not produced by
the public helper functions. Mika treats form-provided `returnTo`, checkout success, and
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

ACP checkout endpoints should follow the same host-owned endpoint pattern. Use
`createMikaAcpCheckoutHandlers()` from `@bnomei/emdash-mika/acp` inside Astro
server endpoints for `POST /checkout_sessions`, `POST
/checkout_sessions/[id]`, `POST /checkout_sessions/[id]/complete`, `POST
/checkout_sessions/[id]/cancel`, and `GET /checkout_sessions/[id]`. Back the
ACP session store with durable host storage in production; the memory store is
only for tests and local demos. `createMikaAcpCheckoutHandlers()` requires an
`apiKey` or `signatureSecret` and throws without one — knowing a checkout
session id must never be enough to read or mutate another buyer's session.

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
