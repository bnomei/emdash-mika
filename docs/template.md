# Mika Template Todos

This is the handoff checklist for the agent working on the copyable Astro
template. Keep public template copy aligned with Mika's public position, but do
not reference internal strategy docs or private positioning notes.

## Public Position To Express

Mika is agent-ready commerce for content-led storefronts.

The template should show an Astro + EmDash store that keeps product content,
layout, auth policy, provider credentials, tax/shipping rules, and deployment in
the host app while using Mika for typed commerce primitives and workflow glue.

Use language like:

- agent-ready storefront;
- content-led storefront;
- hosted checkout handoff;
- structured product and offer metadata;
- stock-aware variants;
- provider-backed fulfillment;
- protocol-ready commerce semantics.

Avoid language like:

- full commerce platform;
- page builder;
- theme system;
- automatic ACP/UCP support;
- built-in OAuth/MCP/payment rail;
- internal strategy names or private positioning notes.

## Build Scope

The template should feel complete for a first real storefront:

- product detail page using EmDash content plus Mika sellables;
- stock-aware variant selection, quantity caps, low-stock and unavailable
  states;
- add-to-cart, buy-now, wishlist, save-for-later, coupon, checkout start, and
  checkout return flows;
- account magic link, orders, subscriptions, licenses, downloads, export, and
  delete request examples;
- provider webhook endpoint with raw-body forwarding;
- maintenance note for expired stock reservations, email outbox, ephemeral rows,
  and account-delete queue;
- JSON-LD, root `llms.txt`, and `.well-known/mika-agent.json`;
- visible copy and metadata that agree on product title, description, price,
  availability, variants, and seller identity.

## Required Template Proof

Create or preserve a single "golden" storefront story:

1. A product page renders host content.
2. The same page renders `ProductStructuredData`.
3. The product has at least one finite-stock variant.
4. Add-to-cart and buy-now submit through Astro Actions.
5. Checkout start hands off to a provider adapter.
6. Checkout success is confirmed through provider-backed order state plus a
   Mika-issued checkout status token, not the return URL alone.
7. A signed provider webhook can fulfill an entitlement, license, or download.
8. The customer can request a magic link and see account orders/downloads.
9. `llms.txt` describes public catalog/stock reads only.
10. `.well-known/mika-agent.json` exposes public manifest entries only by
    default.

## Copy Review Checklist

- Public copy says "agent-ready commerce for content-led storefronts" or an
  equivalent phrase.
- EmDash/Astro is framed as the first implementation surface, not the whole
  market.
- The template does not claim Mika ships a Stripe adapter or ACP integration
  until those are implemented.
- Stripe is named only as the preferred first real provider path or as a host
  adapter example.
- ACP/UCP/MCP/OpenAPI/AP2/MPP/x402 are described as host-owned projections or
  adapters.
- Browser mutations are Astro Actions, not public JSON mutation routes.
- Checkout cancel is passive UX; fulfillment and stock release are provider and
  maintenance driven.
- Account, payment, admin, and protected agent-tool flows remain behind
  host-owned auth, confirmation, idempotency, and rate limits.
- Checkout status and invoice links use Mika-issued tokens or customer-scoped
  request context; raw IDs are not bearer access.
- ProductStructuredData, visible content, and Mika sellables agree.
- No internal strategy names appear in public files.

## Files To Prioritize

- `src/templates/astro/README.md`
- `src/templates/astro/examples/README.md`
- `src/templates/astro/examples/release-slice.md`
- `src/templates/astro/examples/astro-storefront.md`
- `src/templates/astro/examples/backend-provider.md`
- `src/templates/astro/examples/agent-ready-storefront.md`
- `src/templates/astro/components/ProductPurchase.astro`
- `src/templates/astro/components/ProductStructuredData.astro`
- `src/templates/astro/pages/llms.txt.ts`
- `src/templates/astro/pages/.well-known/mika-agent.json.ts`

## Near-Term Product Todos

These are template-facing dependencies, not necessarily template-agent tasks:

- Stripe provider adapter: shipped under `@bnomei/emdash-mika/stripe`; template
  docs should show host-owned Stripe SDK/client wiring and product/price
  provider refs.
- ACP projection helpers: shipped under `@bnomei/emdash-mika/acp`; template docs
  should show feed export, checkout session routes, durable ACP session storage,
  request auth/signature verification, and order webhook delivery.
- Safe URL primitives: checkout success/refresh URLs must carry the
  `statusToken` from checkout start, and order invoice links should use
  `invoiceHref` from account projections rather than raw provider invoice URLs.
- Checkout preview/quote operation if the ACP path needs a pre-payment totals
  surface.
- Provider-neutral proof refs for delegated payment tokens, mandates, and
  confirmation evidence.
- Conformance fixtures that prove Mika semantics can project to ACP without
  changing core DTOs.

## Done Criteria

The template is ready when a host project can copy the files, wire repositories
and a provider adapter, and demonstrate the full product-to-checkout-to-account
flow plus public agent-readable metadata without reading private positioning
notes.
