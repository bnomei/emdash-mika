# @bnomei/emdash-mika

[![npm version](https://img.shields.io/npm/v/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![npm downloads](https://img.shields.io/npm/dm/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![license](https://img.shields.io/npm/l/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![types](https://img.shields.io/badge/types-included-blue.svg)](./package.json)
[![source](https://img.shields.io/badge/source-GitHub-181717.svg?logo=github)](https://github.com/bnomei/emdash-mika)

Lightweight commerce primitives for EmDash and Astro.

Mika is a native EmDash plugin shell for small storefronts that need carts,
wishlists, checkout handoff, account links, subscriptions, downloads,
license-key fulfillment, stock-aware product variants, provider webhooks, and
agent-readable commerce metadata without adopting a full WooCommerce-style
system.

It is intentionally narrow. Mika provides typed primitives, route contracts,
provider interfaces, Astro Actions, server helpers, operation descriptors, and
copyable Kumo-backed Astro templates. The host project still owns product content,
frontend layout, payment-provider wiring, auth/session policy, rate limits,
tax/shipping rules, and final backend behavior.

## What It Can Do

Storefront flows:

- Product purchase forms for one-time payments and subscriptions.
- Stock-aware variants, quantity caps, low-stock notices, and unavailable
  states.
- Cart, wishlist, save-for-later, coupon, checkout start, checkout return, and
  account portal flows through Astro Actions.
- Magic-link account access, orders, subscriptions, downloads, account export,
  and account delete request examples.

Backend flows:

- Host-owned `MikaApi` composition through explicit method overrides or
  `createMikaBackendApi()`.
- Provider contracts for hosted checkout, portal sessions, invoices,
  subscriptions, refunds, catalog sync, and signed webhooks.
- Paid-order fulfillment side effects for entitlement documents, download refs,
  and hashed license-key records.
- Stock reservation lifecycle, email outbox delivery, account-delete cleanup,
  and scheduled maintenance, including expired reservation release, through the
  EmDash plugin lifecycle.
- Admin operation descriptors and runner helpers for EmDash action UIs.

Agent-ready flows:

- Public operation descriptors under `@bnomei/emdash-mika/agent`.
- Copyable JSON-LD `Product`/`ProductGroup`/`Offer` metadata.
- Copyable root `llms.txt` and `.well-known/mika-agent.json` examples.
- Source material for host-owned UCP, ACP, MCP, OpenAPI, AP2, MPP, x402, or
  other protocol projections.

Mika is not a catalog manager, page builder, tax engine, shipping-rate engine,
marketplace platform, hosted OAuth provider, MCP server, or bundled payment
provider SDK.

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

`api` is the host-owned Mika backend implementation. It can be built from
repositories and provider adapters with `createMikaBackendApi()`, or supplied as
explicit `MikaApi` method overrides.

## Examples

The package includes copyable Astro templates and stable example docs under:

```txt
src/templates/astro/actions
src/templates/astro/components
src/templates/astro/pages
src/templates/astro/examples
src/templates/astro/README.md
```

Start with:

- [First release slice](./src/templates/astro/examples/release-slice.md) for
  what should ship first and what should stay out of scope.
- [Astro storefront](./src/templates/astro/examples/astro-storefront.md) for
  plugin registration, actions, product pages, cart, wishlist, checkout,
  account, downloads, and webhook copy paths.
- [Backend and provider wiring](./src/templates/astro/examples/backend-provider.md)
  for repositories, provider adapters, email delivery, and maintenance.
- [Agent-ready storefront](./src/templates/astro/examples/agent-ready-storefront.md)
  for JSON-LD, `llms.txt`, `.well-known/mika-agent.json`, and protected agent
  flow boundaries.
- [Astro template README](./src/templates/astro/README.md) for the directory
  map, copy paths, imports, route shape, sessions, and security boundary.

## High-Level Usage

Copy the template action files into the host app:

```txt
src/actions/index.ts
src/actions/mika.ts
```

Then expose Mika's Astro Actions:

```ts
import { createMikaActions } from "./mika";

export const server = {
  mika: createMikaActions(),
};
```

Browser forms submit to action names such as `actions.mika.cart.add`,
`actions.mika.checkout.start`, and `actions.mika.wishlist.add`. Host projects
can pass a `guard` option to apply rate limits, auth checks, bot checks, or
feature locks before a Mika action reaches the request-bound backend API.

Storefront pages use the request-bound Astro helper:

```ts
import { createMika } from "@bnomei/emdash-mika/astro";

const Mika = createMika(Astro);
const sellablesResult = await Mika.catalog.sellables("products", productId);
```

Product UI is copyable Astro, not a hidden route system. Copy only the pages and
components the host project needs, then keep localization and product routing in
the host app. The template UI uses Kumo components and Kumo semantic tokens.

Checkout success and cancel pages are return surfaces for the browser. Treat
cancel redirects as UX only, and confirm final payment/order state through the
host's provider-backed checkout and order APIs.

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
proof refs, resources, and public route hints. Public storefront examples expose
safe catalog and stock reads. Protected cart, checkout, account, order,
payment, admin, and agent-tool flows still require host-owned OAuth or session
policy, confirmation, replay storage, rate limits, provider wiring, and payment
rail verification.

## Package Surface

- ESM entry: `@bnomei/emdash-mika` for plugin registration.
- Agent descriptors: `@bnomei/emdash-mika/agent`.
- Admin action helpers: `@bnomei/emdash-mika/admin`.
- Astro helpers: `@bnomei/emdash-mika/astro`.
- Astro Actions: `@bnomei/emdash-mika/astro-actions`.
- Browser-safe catalog and stock client: `@bnomei/emdash-mika/client`.
- Email helpers: `@bnomei/emdash-mika/email`.
- Provider contracts: `@bnomei/emdash-mika/provider`.
- React headless helpers: `@bnomei/emdash-mika/react`.
- Server contracts and trusted JSON client: `@bnomei/emdash-mika/server`.
- DTO and input/result types: `@bnomei/emdash-mika/types`.
- Copyable files: `@bnomei/emdash-mika/templates/astro/*`.

The package intentionally does not expose a public `storage` subpath. Storage
repositories, migrations, and SQL statements are implementation details until
the backend service layer is stable enough to support as public API.

## License

MIT
