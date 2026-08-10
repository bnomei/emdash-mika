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
  `maintenance.emailOutboxRunner` to `createMikaPlugin` from
  `@bnomei/emdash-mika/server` in the host entrypoint module (otherwise those
  tasks report `skipped`).
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

Published package contents are `dist/` plus copyable `src/templates` (see
`package.json` `files`). Declaration maps (`.d.mts.map`) are emitted for monorepo
/ path-mapped consumers that resolve into this repo’s `src/`; they do **not**
provide jump-to-source for plain npm installs of the published tarball alone.

### Peer requirements

| Peer                                         | Range             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **astro**                                    | `^7.0.0`          | **Required** for the schema stack (`astro/zod` in validation and Actions). Hosts that only import `/server` still need Astro installed so Zod resolves from the same major as Actions. Developed and CI-tested on **Astro 7 only** (Vite 8, Rust compiler). Do not use reserved `src/fetch.ts` for app code under Astro 7 advanced routing. Cart/account/checkout routes must not use route caching (session/cookie variance). |
| **emdash**                                   | `>=0.22.0 <1.0.0` | Required for native plugin registration.                                                                                                                                                                                                                                                                                                                                                                                       |
| react / react-dom / stripe / kumo / phosphor | optional          | Only when using the matching subpath (`/react`, `/stripe`, templates with Kumo).                                                                                                                                                                                                                                                                                                                                               |

## Three host faces

Hosts interact with Mika through three complementary faces. Pick the face that
matches the trust boundary; do not expand the browser client to authenticated
mutations.

| Face               | Package surface                                                                                                                                 | When to use                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Backend API** | `@bnomei/emdash-mika/server` — `MikaApi`, `createMikaBackendApi()`, overrides                                                                   | Compose commerce behavior once (repos, providers, notifications). Injected into the EmDash plugin entrypoint and shared by routes/actions. |
| **2. In-process**  | `@bnomei/emdash-mika/astro` (`createMika`) and `@bnomei/emdash-mika/astro-actions` (`createMikaActions`)                                        | Astro pages and form/JSON Actions on the server. Same `MikaApi` instance; no extra HTTP hop.                                               |
| **3. HTTP**        | `@bnomei/emdash-mika/client` (`createMikaClient` — public catalog/stock only) and `createMikaServerClient` on `/server` (full operation facade) | Browser-safe public reads, or server-to-plugin HTTP when you need the route surface without importing the full backend graph.              |

Supporting entrypoints stay projections of the same semantic core: `/agent`
(manifest), `/acp` (ACP feed/handlers), `/admin`, `/provider`, `/stripe`,
`/email`, `/types` (plus `/types/primitives`), and discoverability re-exports
`/server/ports`, `/server/maintenance`, `/server/email`. The root package export
is **descriptor-only** (`mikaPlugin`); live `api` wiring never belongs on the
JSON-safe root.

Create a host entrypoint module that merges the live backend api:

```ts
// src/lib/mika-plugin.ts — EmDash plugin entrypoint
// (copyable template: src/templates/astro/lib/mika-plugin.ts)
import { createMikaPlugin, type MikaCreatePluginOptions } from "@bnomei/emdash-mika/server";
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

## Host-owned business quotes

Mika's built-in quote reprices catalog lines, applies the configured coupon
resolver, and checks availability. It deliberately does not calculate tax,
shipping, or business-specific fees. Hosts that need those values should pass
one `quoteResolver` to `createMikaBackendApi()` and return them through
`CartQuoteDTO.tax`, `.shipping`, `.adjustments`, and `.total`.

The resolver runs inside Mika's shared quote path. Its result is reused by cart
quote, checkout preview, delegated-payment proof, checkout provider handoff,
and persisted checkout/order totals. Do not override only `cart.quote` to add
business amounts: operation overrides remain available for replacing complete
workflows, but a display-only override cannot change checkout's charge.
Provider adapters must apply the authoritative total or reject it. Mika's
built-in delegated Stripe path charges it directly; the hosted Stripe adapter
rejects host-added amounts because its line/coupon projection cannot represent
them without host-specific Stripe configuration.

`CartQuoteLineDTO.fulfillmentKind` carries provider-neutral classification into
the quote. Use `external` for physical or otherwise host-fulfilled lines; the
host still owns addresses, rates, carriers, delivery, and policy decisions.
Mika's built-in delegated-payment proof binds the quote items, subtotal,
discount, tax, shipping, adjustments, and total before provider handoff.

The compile-checked
[`business-quote-resolver.ts`](./test/fixtures/business-quote-resolver.ts)
fixture and its
[`business-quote.test.ts`](./test/business-quote.test.ts) proof show tax,
shipping, a fee, and mixed download/external fulfillment using only public
package exports. They are integration scaffolding, not a tax or shipping
implementation.

## Errors

Branch on `error.code` from failed {@link MikaApiResult} envelopes — never parse
`error.message` for control flow. Codes are stable and additive
(`MIKA_ERROR_CODES` on `@bnomei/emdash-mika/types`). New codes include
`IDEMPOTENCY_MISMATCH`, `WEBHOOK_DEFERRED`, and `STOCK_CONFLICT` for
callers that previously over-used generic `CONFLICT`.

## Maintenance wiring

The default EmDash maintenance cron only **releases expired stock reservations**
unless the host injects more ports:

```ts
// src/lib/mika-plugin.ts
import {
  createMikaPlugin,
  createMikaEmailOutboxRunner,
  type MikaCreatePluginOptions,
} from "@bnomei/emdash-mika/server";
import { api } from "./mika-api";

export function createPlugin(options: MikaCreatePluginOptions = {}) {
  return createMikaPlugin({
    ...options,
    api,
    maintenance: {
      repositories: {
        // stock is usually already required for commerce; pass the same ports
        // you wired into createMikaBackendApi for email/ephemeral/account-delete
      },
      emailOutboxRunner: createMikaEmailOutboxRunner({
        /* host sender + repos */
      }),
    },
  });
}
```

Without those injects, outbox drain, ephemeral purge, and account-delete batches
report `skipped` in maintenance results (stock release still runs).

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
src/templates/astro/lib
src/templates/astro/pages
src/templates/astro/styles
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

Mika's checkout handlers support `API-Version: 2025-09-12` and pin conformance
to the official ACP `2025-09-29` checkout schema snapshot. This surface supports
Stripe delegated payments only. Mika advertises digital fulfillment only when
every quoted line is explicitly classified as a download, license, or
entitlement; external, mixed, unavailable, and otherwise unknown fulfillment
is omitted because Mika does not invent shipping rates, carriers, or delivery
windows. Upgrade the API version and schema snapshot together.

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

- ESM entry: `@bnomei/emdash-mika` for descriptor-focused plugin registration.
- ACP feed and checkout projection helpers: `@bnomei/emdash-mika/acp`.
- Agent descriptors, proof refs, actor contracts, and agent vocabulary:
  `@bnomei/emdash-mika/agent`.
- Admin action helpers: `@bnomei/emdash-mika/admin`.
- Astro helpers: `@bnomei/emdash-mika/astro`.
- Astro Actions: `@bnomei/emdash-mika/astro-actions`.
- Browser-safe catalog and stock client: `@bnomei/emdash-mika/client`.
- Email helpers: `@bnomei/emdash-mika/email`.
- Provider contracts: `@bnomei/emdash-mika/provider`.
- React headless helpers: `@bnomei/emdash-mika/react`.
- Server runtime plugin activation, server contracts, and trusted JSON client:
  `@bnomei/emdash-mika/server`.
- Optional Stripe provider adapter: `@bnomei/emdash-mika/stripe`.
- DTO, input/result, and branded primitive types: `@bnomei/emdash-mika/types`.
- Public aggregate, document, and operational type barrels:
  `@bnomei/emdash-mika/types/aggregates`,
  `@bnomei/emdash-mika/types/documents`, and
  `@bnomei/emdash-mika/types/operational`.
- Copyable files: `@bnomei/emdash-mika/templates/astro/*`.

The package intentionally does not expose a public `storage` subpath. Storage
repositories, migrations, and SQL statements are implementation details until
the backend service layer is stable enough to support as public API.

## License

MIT
