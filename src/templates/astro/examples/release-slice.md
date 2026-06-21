# First Release Slice

Use this slice when deciding what belongs in the first public Mika release. The
goal is to show Mika as a real, agent-ready commerce layer without turning the
package into a full storefront platform.

## Ship

- Native EmDash plugin registration with `mikaPlugin({ api })`.
- Host-owned backend API wiring through `createMikaBackendApi()` or explicit
  `MikaApi` method overrides.
- Provider adapter contract examples for hosted checkout, portal, subscriptions,
  invoices, refunds, catalog sync, and signed webhooks.
- Astro Actions for form-first cart, wishlist, checkout, account, magic-link,
  subscription, coupon, and stock flows.
- Copyable Astro pages, endpoints, and Kumo-backed components for product purchase,
  cart, wishlist, checkout returns, account, downloads, and provider webhooks.
- Stock-aware product variants through `createMikaPurchaseModel()`,
  `ProductPurchase`, grouped variant controls, stock badges, low-stock notices,
  and unavailable states.
- Account flows for magic links, orders, subscriptions, downloads, export, and
  delete requests.
- Maintenance runner coverage for email outbox delivery, expired stock
  reservations, expired ephemeral rows, and queued account-delete requests.
- Agent-readable public surfaces: `ProductStructuredData`, `llms.txt`, and
  `.well-known/mika-agent.json`.
- Operation manifest descriptors under `@bnomei/emdash-mika/agent` as source
  material for host-owned UCP, ACP, MCP, OpenAPI, or other adapters.
- Clear docs for route boundaries, security posture, idempotency expectations,
  and what Mika deliberately does not own.

## Defer

- A bundled storefront theme or page builder.
- Product catalog editing UI inside Mika.
- Tax, shipping-rate, marketplace, or fulfillment engines.
- Provider-specific SDK implementations inside the core package.
- Public browser JSON mutation routes for carts, checkout, accounts, webhooks,
  admin actions, or subscriptions.
- Built-in OAuth issuer, MCP server, AP2 verifier, MPP/x402 rail, or OpenAPI
  server.
- A stable public storage subpath until the backend persistence layer is ready
  to support as API.

## Showcase

The release should make these stories easy to understand:

- "I have EmDash product content and need commerce primitives next to it."
- "I want Astro-native forms, not a hidden app route system."
- "I need variants, stock, carts, wishlists, checkout handoff, account links,
  subscriptions, downloads, and provider webhooks."
- "I want a storefront that is useful to search crawlers and shopping agents
  before I build a protected agent-tool server."
- "I want semantic operation metadata I can project into my own agent protocol
  adapter later."

## Manual Acceptance

Before cutting a release candidate, the examples should support a host project
walking through this flow:

1. Register EmDash and Mika in `astro.config.mjs`.
2. Wire a host `api` from repositories plus one provider adapter.
3. Copy `src/actions/index.ts` and `src/actions/mika.ts`.
4. Copy the core product components and render a product detail page.
5. Add an item to the cart, save one to the wishlist, and start checkout.
6. Handle checkout success/cancel pages without releasing active provider
   sessions from the cancel page.
7. Receive a signed provider webhook through the copied Astro endpoint.
8. Request a magic link, view account data, and resolve a download token.
9. Expose product JSON-LD, root `llms.txt`, and a public Mika agent manifest.
10. Run Mika maintenance through the EmDash scheduled lifecycle.
