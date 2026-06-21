# @bnomei/emdash-mika

[![npm version](https://img.shields.io/npm/v/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![npm downloads](https://img.shields.io/npm/dm/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![license](https://img.shields.io/npm/l/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![types](https://img.shields.io/badge/types-included-blue.svg)](./package.json)
[![source](https://img.shields.io/badge/source-GitHub-181717.svg?logo=github)](https://github.com/bnomei/emdash-mika)

Lightweight commerce primitives for EmDash and Astro.

`@bnomei/emdash-mika` is a native EmDash plugin shell for small storefronts
that need carts, wishlists, checkout handoff, account links, subscriptions, and
stock-aware product variants without adopting a full WooCommerce-style system.
It is intentionally narrow: Mika provides typed primitives, routes, provider
contracts, Astro Actions, and copyable unstyled Astro templates. The host
project still owns product content, frontend layout, payment-provider wiring,
and the final backend service behavior.

## What It Provides

- Native EmDash plugin factories: `mikaPlugin()` for config and `createPlugin()`
  for runtime loading.
- Agent-ready operation descriptors under `@bnomei/emdash-mika/agent` for host
  UCP, ACP, MCP, or OpenAPI adapters.
- A browser-safe JSON client under `@bnomei/emdash-mika/client` for public
  catalog and stock reads.
- Astro helpers under `@bnomei/emdash-mika/astro`, including
  `createMika()` and `createMikaPurchaseModel()`.
- Astro Actions under `@bnomei/emdash-mika/astro-actions` for form-first cart,
  wishlist, checkout, account, magic-link, and subscription flows.
- Copyable Astro pages, endpoints, actions, and unstyled components under the
  `@bnomei/emdash-mika/templates/astro/*` export subtree.
- DTOs and provider contracts for one-time purchases, subscriptions, stock,
  entitlements, downloads, webhooks, and lightweight admin actions.
- Minimal email renderers for magic links and order confirmations.

Mika is not a catalog manager, page builder, tax engine, shipping-rate engine,
marketplace platform, or full payment-provider abstraction. It is the small
commerce layer that sits next to EmDash collections.

## Install

```sh
npm install @bnomei/emdash-mika
```

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

## Astro Actions

Copy the template action files into your app:

```txt
src/actions/index.ts
src/actions/mika.ts
```

The copied `src/actions/mika.ts` shim re-exports Mika's versioned action factory:

```ts
export {
  createMikaActions,
  mika,
  type MikaActionName,
  type MikaActions,
  type MikaActionsOptions,
} from "@bnomei/emdash-mika/astro-actions";
```

Then `src/actions/index.ts` wires those actions into Astro:

```ts
import { createMikaActions } from "./mika";

export const server = {
  mika: createMikaActions(),
};
```

The actions are regular Astro Actions. Browser forms submit to
`actions.mika.cart.add`, `actions.mika.checkout.start`,
`actions.mika.wishlist.add`, and related action names. Host projects can pass a
`guard` option to apply rate limits, auth checks, bot checks, or feature locks
before a Mika action reaches the request-bound Mika API.
When the backend API is wired through `mikaPlugin({ api })` or
`createPlugin({ api })`, `createMikaActions()` and `createMika(Astro)` use that
same API by default. Pass `{ api }` directly only when a page or action module
needs different wiring. `createMikaApi()` remains available as a partial
override shell for tests and host-owned composition; use `assertMikaApiWired()`
when a deployment must reject unwired methods.

## Product Page

Mika product UI is copyable Astro, not a hidden route system. A minimal product
page fetches sellables for an EmDash content entry and renders unstyled forms:

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

`createMikaPurchaseModel()` is the main storefront helper for product forms. It
selects the active sellable and price, derives purchase form fields, computes
quantity caps from availability, and exposes grouped variant metadata for the
copyable variant controls.

## Agent-Ready Commerce

Mika exposes a semantic operation manifest for hosts that want to make a
storefront available to agents without moving OAuth, payment credentials, or
protocol hosting into Mika:

```ts
import { createMikaAgentManifest, mikaAgentManifestJsonSchema } from "@bnomei/emdash-mika/agent";

export const manifest = createMikaAgentManifest();
export const schema = mikaAgentManifestJsonSchema;
```

The manifest describes operation names, capabilities, side effects, risk,
required actor shape, scopes, confirmation policy, idempotency expectations,
proof refs, resources, and public route hints. Manifest `route.path` values are
relative to the EmDash Mika plugin base path
`/_emdash/api/plugins/mika/`; the copyable `.well-known` example exposes that
base path beside the manifest. Trusted host/server operations include quote and
checkout preview primitives for agent projections. The storefront browser
client stays limited to catalog and stock reads, and storefront forms do not
generate required idempotency keys in this pass. Required idempotency is
enforced on admin and agent runner paths; checkout replay remains backed by
Mika's internal checkout idempotency storage when a host request context
supplies a key. Mika does not export its
internal operation registry or Zod schemas, and it does not make private cart,
checkout, account, webhook, or admin routes public. Host projects still own
OAuth, MCP servers, UCP/ACP endpoints, AP2 mandate verification, MPP/x402
payment rails, user confirmation, replay storage, rate limits, and
payment-provider wiring.

## Templates

The package includes copyable Astro templates:

```txt
src/templates/astro/actions
src/templates/astro/components
src/templates/astro/pages
src/templates/astro/README.md
```

They are examples, not a theme. Copy only the pieces you need and keep final
markup, styles, localization, and product-page routing in the host app. The
template README goes deeper into sessions, route shape, webhook boundaries, and
security expectations.

## Package Surface

- ESM entry: `@bnomei/emdash-mika` for plugin registration.
- Agent descriptors: `@bnomei/emdash-mika/agent`.
- Client entry: `@bnomei/emdash-mika/client` for the browser-safe catalog/stock
  JSON client.
- Astro helpers: `@bnomei/emdash-mika/astro`.
- Astro Actions: `@bnomei/emdash-mika/astro-actions`.
- Admin action helpers: `@bnomei/emdash-mika/admin`.
- Email helpers: `@bnomei/emdash-mika/email`.
- Provider contracts: `@bnomei/emdash-mika/provider`.
- React headless helpers: `@bnomei/emdash-mika/react`.
- Server contracts and trusted JSON client: `@bnomei/emdash-mika/server`.
- DTO and input/result types: `@bnomei/emdash-mika/types`.
- Copyable files: `@bnomei/emdash-mika/templates/astro/*`.

The package intentionally does not expose a public `storage` subpath. Storage
repositories, migrations, and SQL statements are implementation details until
the backend service layer is stable enough to support as public API.

Mika background work runs through the EmDash scheduled lifecycle. The native
plugin registers the `mika_maintenance` cron task by default with the
`* * * * *` schedule; configure it with
`mikaPlugin({ maintenance: { enabled, schedule } })` or
`createPlugin({ maintenance: { enabled, schedule } })`. The task calls
`createMikaMaintenanceRunner().runOnce()` to drain due email outbox rows, release
expired stock reservations, purge expired ephemeral rows, and process queued
account-delete requests. Use `createMikaEmailOutboxRunner()` and
`createEmDashMikaEmailSender()` from the server entry when wiring the backend
maintenance runner to EmDash's selected email provider.

On Node, EmDash drives plugin cron tasks through its scheduler. On Cloudflare,
the host Worker's `scheduled()` handler should call EmDash `runScheduledTasks()`;
EmDash then runs scheduled publishing and Mika's `mika_maintenance` task. Queue
workers can still be added for high-volume email delivery, but they are optional
deployment infrastructure rather than Mika's default maintenance path.

## Status

Mika currently ships the typed shell, backend API composer, plugin
registration, route contracts, client methods, Astro Actions, copyable
templates, provider interfaces, stock tables, document shapes, admin action
descriptors, safe return-path normalization, email renderers, an email outbox
runner, and a scheduled maintenance runner. Production storefronts still need
host provider adapters, auth/session policy, rate limits, and deployment-specific
guards.

Hosted checkout cancel redirects are treated as UX only. Mika releases expired
stock reservations from the plugin maintenance cron task. The manual
`admin.releaseExpiredReservations` operation and `mika.stock.releaseExpiredReservations`
action remain available for admin-triggered cleanup.

## License

MIT
