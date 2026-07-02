# @bnomei/emdash-mika

[![npm version](https://img.shields.io/npm/v/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![npm downloads](https://img.shields.io/npm/dm/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![license](https://img.shields.io/npm/l/@bnomei/emdash-mika.svg)](https://www.npmjs.com/package/@bnomei/emdash-mika)
[![types](https://img.shields.io/badge/types-included-blue.svg)](./package.json)
[![source](https://img.shields.io/badge/source-GitHub-181717.svg?logo=github)](https://github.com/bnomei/emdash-mika)

Agent-ready commerce primitives for content-led storefronts.

Mika is a native EmDash plugin shell for content-led Astro storefronts that
need carts, wishlists, checkout handoff, account links, subscriptions,
downloads, license-key fulfillment, stock-aware product variants, provider
webhooks, and agent-readable commerce metadata without adopting a full
commerce platform.

EmDash and Astro are the first implementation surface. The larger job is making
headless and content-managed storefronts understandable to agents, search
crawlers, and checkout surfaces while keeping the merchant in control of the
site, payment provider, fulfillment, support, and customer relationship.

It is intentionally narrow. Mika provides typed commerce primitives, route
contracts, provider interfaces, Astro Actions, server helpers, operation
descriptors, and copyable Kumo-backed Astro templates. The host project still
owns product content, frontend layout, payment-provider wiring, auth/session
policy, rate limits, tax/shipping rules, and final backend behavior.

## What It Can Do

Storefront flows:

- Product purchase forms for one-time payments and subscriptions.
- Stock-aware variants, quantity caps, low-stock notices, and unavailable
  states.
- Cart, wishlist, save-for-later, coupon, checkout start, token-bound checkout
  return, and account portal flows through Astro Actions.
- Magic-link account access, orders, subscriptions, downloads, account export,
  and account delete request examples.

Backend flows:

- Host-owned `MikaApi` composition through explicit method overrides or
  `createMikaBackendApi()`.
- Provider contracts for hosted checkout, portal sessions, protected invoice
  lookup, subscriptions, refunds, catalog sync, and signed webhooks.
- Paid-order fulfillment side effects for entitlement documents, download refs,
  and hashed license-key records.
- Stock reservation lifecycle, email outbox delivery, account-delete cleanup,
  and scheduled maintenance through the EmDash plugin lifecycle. The default
  maintenance cron releases expired stock reservations out of the box; to also
  drain the email outbox, purge expired ephemeral records, and process
  account-delete batches, pass `maintenance.repositories` and
  `maintenance.emailOutboxRunner` to `createPlugin` (otherwise those tasks
  report `skipped`).
- Admin operation descriptors and runner helpers for EmDash action UIs.

Agent-ready commerce flows:

- Public operation descriptors under `@bnomei/emdash-mika/agent`.
- Copyable JSON-LD `Product`/`ProductGroup`/`Offer` metadata.
- Copyable root `llms.txt` and `.well-known/mika-agent.json` examples.
- ACP product-feed serializers and checkout endpoint handlers under
  `@bnomei/emdash-mika/acp`.
- Source material for host-owned UCP, MCP, OpenAPI, AP2, MPP, x402, or other
  protocol projections.

Mika is not a catalog manager, page builder, tax engine, shipping-rate engine,
marketplace platform, hosted OAuth provider, MCP server, or bundled payment
provider SDK. Provider adapters and protocol projections should preserve
Mika's semantic core instead of leaking a single platform's field names into the
package.

## Install

```sh
npm install @bnomei/emdash-mika
```

Create a host entrypoint module that merges the live backend api:

```ts
// src/lib/mika-plugin.ts — EmDash plugin entrypoint
// (copyable template: src/templates/astro/lib/mika-plugin.ts)
import {
  createPlugin as createMikaPlugin,
  type MikaCreatePluginOptions,
} from "@bnomei/emdash-mika";
import { api } from "./mika-api";

export function createPlugin(options: MikaCreatePluginOptions = {}) {
  return createMikaPlugin({ ...options, api });
}
```

Then register it in `astro.config.mjs`:

```ts
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

`api` is the host-owned Mika backend implementation. It can be built from
repositories and provider adapters with `createMikaBackendApi()`, or supplied as
explicit `MikaApi` method overrides.

Plugin construction asserts every `MikaApi` method is wired and throws
otherwise — unwired methods would answer `501` on every route at runtime. Pass
`assertWired: ["cart", "checkout.start"]` to assert a subset, or
`assertWired: false` to accept partial wiring.

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

Then expose Mika's Astro Actions, passing the same `api` the entrypoint
module merges:

```ts
import { createMikaActions } from "./mika";
import { api } from "../lib/mika-api";

export const server = {
  mika: createMikaActions({ api }),
};
```

Browser forms submit to action names such as `actions.mika.cart.add`,
`actions.mika.checkout.start`, and `actions.mika.wishlist.add`. Host projects
can pass a `guard` option to apply rate limits, auth checks, bot checks, or
feature locks before a Mika action reaches the request-bound backend API.

Storefront pages use the request-bound Astro helper, also wired with `api`:

```ts
import { createMika } from "@bnomei/emdash-mika/astro";
import { api } from "../lib/mika-api";

const Mika = createMika(Astro, { api });
const sellablesResult = await Mika.catalog.sellables("products", productId);
```

Neither helper has a process-global default `api` — every call site imports
it explicitly. This keeps behavior local to each module and safe for hosts
that construct more than one Mika-backed integration in the same process.

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
proof refs, resources, and public route hints. Public storefront examples
expose safe catalog and stock reads. Protected cart, checkout, account, order,
payment, admin, and agent-tool flows still require host-owned OAuth or session
policy, confirmation, replay storage, rate limits, provider wiring, and payment
rail verification.

Mika's agent-ready path starts with accurate storefront metadata and stable
commerce semantics. ACP, UCP, MCP, OpenAPI, AP2, MPP, x402, and other agent or
payment protocols should be generated as host-owned projections from those
contracts rather than becoming the core product model.

ACP and Stripe are optional edge surfaces:

```ts
import { createMikaAcpCheckoutHandlers, createMikaAcpProductFeed } from "@bnomei/emdash-mika/acp";
import { createMikaStripeProvider } from "@bnomei/emdash-mika/stripe";
```

The ACP helpers serialize Mika catalog/sellable facts into OpenAI-compatible
product-feed shapes and expose checkout session handlers for host Astro
endpoints. The Stripe helper adapts a host-owned Stripe SDK client to Mika's
provider contract, including hosted Checkout Sessions, paid-state webhook
normalization, signed webhooks, protected invoice lookup, and delegated
checkout metadata for Stripe Shared Payment Tokens.

## Notifications And Email

Trusted backends can pass a notification hook to `createMikaBackendApi()`:

```ts
import type { MikaNotificationHook } from "@bnomei/emdash-mika/server";

const handleNotification: MikaNotificationHook = async (intent) => {
  if (intent.kind === "order.confirmed") {
    await queueHostEmail(intent);
    return { handled: true };
  }
};
```

The hook receives typed `MikaNotificationIntent` objects for commerce events
such as `magic_link.requested`, `order.confirmed`,
`checkout.payment_failed`, `download.ready`, `license.issued`,
subscription lifecycle events, account export/delete events, and webhook
failures. `undefined` or `{ handled: false }` lets Mika continue default
handling when one exists. `{ handled: true }` suppresses Mika's built-in email
for that intent. Hook exceptions are swallowed and default delivery still
runs — only an explicit `{ handled: true }` suppresses it. A throwing hook is
not retried and does not fail the backend operation, so hosts should queue
their own notification/email work durably inside the hook rather than relying
on backend retries.

Mika currently ships default email rows and renderers for magic links and order
confirmations only. Other notification kinds are host hooks; they do not create
Mika email outbox rows until a default renderer is intentionally added. The
existing email outbox runner remains compatible with Mika's queued
`magic_link` and `order_confirmation` email documents.

## Package Surface

- ESM entry: `@bnomei/emdash-mika` for plugin registration.
- ACP feed and checkout projection helpers: `@bnomei/emdash-mika/acp`.
- Agent descriptors: `@bnomei/emdash-mika/agent`.
- Admin action helpers: `@bnomei/emdash-mika/admin`.
- Astro helpers: `@bnomei/emdash-mika/astro`.
- Astro Actions: `@bnomei/emdash-mika/astro-actions`.
- Browser-safe catalog and stock client: `@bnomei/emdash-mika/client`.
- Email helpers: `@bnomei/emdash-mika/email`.
- Provider contracts: `@bnomei/emdash-mika/provider`.
- React headless helpers: `@bnomei/emdash-mika/react`.
- Server contracts and trusted JSON client: `@bnomei/emdash-mika/server`.
- Optional Stripe provider adapter: `@bnomei/emdash-mika/stripe`.
- DTO and input/result types: `@bnomei/emdash-mika/types`.
- Copyable files: `@bnomei/emdash-mika/templates/astro/*`.

The package intentionally does not expose a public `storage` subpath. Storage
repositories, migrations, and SQL statements are implementation details until
the backend service layer is stable enough to support as public API.

## License

MIT
