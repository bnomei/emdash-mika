# Mika Astro Templates

These files are copyable examples for an Astro + EmDash project. They are not a
theme and they are not hidden routes owned by Mika.

## Wiring

1. Register the native plugin in `astro.config.mjs`:

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

2. Copy `actions/index.ts` and `actions/mika.ts` into your project
   `src/actions/` folder. The `mika.ts` file is only a shim over
   `@bnomei/emdash-mika/astro-actions`, so the action factory stays versioned
   with Mika.

3. Copy only the pages and components you want. The examples use regular Astro
   forms with `astro:actions`, so product pages and layouts stay in the host
   project.

## Copy Paths

The core kit is the smallest copy path for a storefront product flow:
`ProductPurchase`, `AddToCartForm`, `BuyNowForm`, `WishlistForm`,
`StockBadge`, `LowStockNotice`, and `UnavailableNotice`. `ProductPurchase`
owns cross-form grouped variant synchronization for hidden sellable/price
fields, purchase buttons, quantity limits, and availability panels.
`VariantOptionGroups` is render-focused: it keeps its own local hidden fields in
sync and emits selection events for the product-level owner.

Contract examples stay in place as copyable references for fuller projects:
`CouponForm`, `CheckoutForm`, account export/delete pages, wishlist move and
save-for-later forms, grouped variant selection, checkout customer fields, and
the provider webhook endpoint. Keep or delete them based on the storefront and
provider adapters wired in the host project.

Agent-readable examples are optional copyable references: `ProductStructuredData`
for JSON-LD `Product`/`Offer` metadata, `llms.txt.ts` for a root `llms.txt`, and
`.well-known/mika-agent.json.ts` for a Mika-native capability manifest. These
examples describe the storefront and safe public reads. The well-known example
wraps a public-only `createMikaAgentManifest({ include: ["public"] })` payload
with the manifest schema, version, and EmDash Mika plugin route base path. The
`llms.txt` example is only a concise discovery index for agents and LLMs; it is
not an auth, payment, or tool contract. Mika also exposes trusted quote and
checkout preview contracts for host-owned agent projections, but protected
agent-tool flows still need host OAuth, policy, confirmation, and replay
storage.

`ProductStructuredData` accepts either small legacy props (`name`, `brand`,
`images`) or a `product` object with identifiers, brand, category, item
condition, variant overrides, seller, shipping details, return policy, and
price validity. It emits `Product` for simple products and `ProductGroup` with
variant `Product` and per-price `Offer` nodes when sellables have variant
options. Product groups include `productGroupID`, `hasVariant`, `isVariantOf`,
and `inProductGroupWithID` links. Common variant dimensions such as color, size,
material, and pattern are also emitted as schema.org variant properties, while
custom dimensions remain in `additionalProperty`.

The copied pages export `prerender = false` because Astro Actions, sessions,
and request-bound cart/account state need on-demand rendering. If your whole
site uses `output: "server"`, that export is still harmless.

Host product pages that render Mika forms need the same on-demand/action-result
shape. A minimal product page looks like this:

```astro
---
import { actions } from "astro:actions";
import { createMika } from "@bnomei/emdash-mika/astro";
import ProductPurchase from "../components/ProductPurchase.astro";

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

{formError && <p role="alert">{formError}</p>}
<ProductPurchase sellables={sellables} />
```

## Imports

Use the small public subpaths in copied code:

- `@bnomei/emdash-mika/astro` for Astro helpers like `createMika()`,
  `formatMikaMoney()`, and purchase-option selection.
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

That keeps call sites visually close to `actions.mika.*` while still avoiding
browser-facing plugin JSON mutation routes.

## Astro Surface

The storefront path is intentionally Astro-native:

- HTML forms submit to `action={actions.mika.*}` with `method="post"`.
- `@bnomei/emdash-mika/astro-actions` uses
  `defineAction({ accept: "form", input })` and Zod schemas, so Astro handles
  form parsing and field validation.
- Pages use `Astro.getActionResult()` for action results and redirects.
- Components are unstyled primitives with `data-mika-*` attributes instead of a
  bundled theme.
- Component root elements accept `class` and normal HTML attributes, matching
  Astro's explicit `class` pass-through model.
- Form primitives are named as forms (`BuyNowForm`, `WishlistForm`).
- `CouponForm`, the copied wishlist page, wishlist move/save-for-later forms,
  checkout customer fields, grouped variant selection, account export/delete
  forms, and the provider webhook endpoint are contract examples. They depend
  on the same request-bound Mika API and provider adapters as the rest of the
  copied kit.
- Common form labels and empty states are props or named slots, so copied
  components can be localized or restyled without editing Mika logic first.
  Full status-label localization is intentionally left to copied project code.

Use the `guard` option in `createMikaActions()` for host policy that Mika should
not hard-code: rate limits, account checks, bot checks, or temporary feature
locks.

Use `createMikaAgentManifest()` only as a descriptor source for host-owned
agent endpoints. It does not publish protected mutation routes, validate OAuth
tokens, verify AP2 mandates, run MCP servers, store idempotency records, or
process MPP/x402 payments.

When a backend API is wired through `mikaPlugin({ api })`, copied pages that
call `createMika(Astro)` and action modules that call `createMikaActions()` use
that same API by default. Pass `{ api }` directly only when a page or action
module needs different wiring. Actions call the request-bound Mika API directly;
they do not use private plugin JSON routes for browser form mutations.

```ts
import { ActionError } from "astro:actions";
import { createMikaActions } from "./mika";

export const server = {
  mika: createMikaActions({
    guard: async (ctx, action, input) => {
      // Call your limiter with action, input, ctx.clientAddress, or headers.
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

## Sessions

Astro Sessions are a good fit for anonymous, non-resumable carts and short-lived
form state because they are server-side and available as `Astro.session` in
pages and `context.session` in actions, endpoints, and middleware. Mika keeps
sessions optional so the templates still work on sites that use durable carts,
provider checkouts, or deployments without an Astro session driver.

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

Agent manifest `route.path` values are relative to that plugin base path. IDs
are passed in query strings or JSON bodies rather than dynamic route segments.
This matches the EmDash plugin route dispatcher. The only public plugin JSON
routes are catalog sellables and sellable availability. Do not treat plugin
JSON routes as the default browser mutation surface for carts, checkout,
accounts, exports, deletes, webhooks, admin actions, or subscriptions until the
route is explicitly designed with the right EmDash auth, CSRF, rate-limit, and
method gates.

The copied `download/[token].ts` endpoint uses the request-bound Mika helper as
a redirect resolver. If a site needs private file streaming instead of signed
redirects, wire that endpoint to a server-only Mika service rather than the
browser-safe JSON client.

Use `mikaSafeReturnTo()` for host-owned return fields that are not produced by
the copied helpers. Mika treats form-provided `returnTo`, checkout success, and
checkout cancel values as same-origin local paths; backend checkout config is
trusted deployment configuration.

Checkout cancel pages are passive browser return surfaces. Expired stock
reservations should be released by calling `admin.releaseExpiredReservations`
from host maintenance code, for example a Cloudflare Cron Worker, queue worker,
or admin job. Do not release stock solely because a customer visited the cancel
page while a provider-hosted checkout session may still be open.

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
idempotency keys are enforced on admin and agent runner paths; storefront
checkout and subscription forms stay browser-friendly here, while checkout
replay is handled by Mika's internal checkout idempotency storage when the host
request context provides a key. Webhooks that need raw-body signature
verification should be host Astro endpoints that call Mika services, not generic
plugin JSON routes.
