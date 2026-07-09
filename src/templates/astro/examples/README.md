# Mika Astro Examples

These examples are the practical setup layer for Mika in an agent-ready Astro +
EmDash storefront. They are documentation, not generated routes. Copy the code
and template files that fit the host project, then keep the final layout, auth,
provider integration, and product content in the host app.

Start here:

- [First release slice](./release-slice.md): what to ship first so the package
  shows the right amount of commerce behavior.
- [Unstyled kit (no Kumo)](./unstyled-kit.md): minimal forms without Cloudflare
  Kumo / React peers.
- [Astro storefront](./astro-storefront.md): product page, actions, cart,
  wishlist, checkout, account, and download copy path.
- [Backend and provider wiring](./backend-provider.md): how to connect Mika to
  host repositories, provider adapters, email delivery, and maintenance.
- [Agent-ready storefront](./agent-ready-storefront.md): JSON-LD, `llms.txt`,
  `.well-known/mika-agent.json`, and safe boundaries for future agent tools.

## Example Shape

Each example follows the same split:

- Mika owns typed commerce primitives, Astro Actions, route contracts, provider
  interfaces, copyable templates, operation metadata, and maintenance runners.
- The host owns product pages, EmDash content models, repository persistence,
  payment provider credentials, auth/session policy, rate limits, confirmation
  UX, tax/shipping rules, and deployment infrastructure.
- Agent-facing work starts with accurate public storefront metadata. Protected
  tool flows should be built later from the same contracts, behind host-owned
  OAuth, policy, confirmation, and idempotency storage.
- Provider and agent-protocol work should be adapters or projections around
  Mika semantics, not fields baked into product, cart, or checkout core types.

That shape is intentional. These files should be readable by humans today and
specific enough to become future agent skill/reference material without first
reverse-engineering the README.
