# Agent-Ready Storefront Example

Mika is agent-ready because it exposes accurate commerce semantics that a host
can project into agent protocols. It is not itself an OAuth issuer, MCP server,
payment rail, or protected tool runtime.

Start with public storefront metadata. Protected agent tools can come later.

## 1. Product JSON-LD

Copy `components/ProductStructuredData.astro` and render it on product detail
pages beside the visible product content and purchase forms.

```astro
<ProductStructuredData
  sellables={sellables}
  product={{
    name: entry.data.title,
    description: entry.data.description,
    url: Astro.url,
    images: entry.data.images,
    brand: "Example Store",
    category: entry.data.category,
  }}
  offers={{
    priceValidUntil: "2026-12-31",
    seller: {
      name: "Example Store",
      url: "https://example.com",
    },
  }}
/>
```

The component emits `Product` for simple products and `ProductGroup` with
variant `Product` and per-price `Offer` nodes when sellables have variant
options. Keep JSON-LD values aligned with visible price, availability, and
product identity.

## 2. Root llms.txt

Copy:

```txt
pages/llms.txt.ts
```

The example publishes a concise index for agents and LLMs:

- public catalog and stock read capabilities;
- the root agent manifest URL;
- the fact that browser mutations are Astro Actions;
- the fact that protected checkout, account, payment, and agent-tool flows need
  host-owned auth, policy, confirmation, and provider wiring.

It is not an auth contract and it does not grant tools.

## 3. Mika Agent Manifest

Copy:

```txt
pages/.well-known/mika-agent.json.ts
```

The public endpoint uses:

```ts
import {
  MIKA_AGENT_MANIFEST_VERSION,
  createMikaAgentManifest,
  mikaAgentManifestJsonSchema,
} from "@bnomei/emdash-mika/agent";

const manifest = createMikaAgentManifest({ include: ["public"] });
```

Public manifests should describe safe reads and route hints. Keep protected
mutations out of the public endpoint unless the host has implemented the
matching auth, confirmation, rate limits, replay storage, and provider policy.

## 4. Trusted Agent Projections

For a protected agent integration, treat Mika's manifest as source material:

- UCP, ACP, MCP, OpenAPI, or Arazzo descriptors are host projections.
- OAuth tokens, scopes, issuer/audience checks, and user identity are host
  responsibilities.
- AP2 mandate verification, MPP/x402 payment rails, and payment credentials are
  adapter responsibilities.
- Idempotency records for trusted/admin agent runner paths must live in host
  durable storage when Mika marks idempotency as required.
- User confirmation remains a host UX and policy decision.

Good first protected projections are read or preview flows:

- `cart.quote` for a cart price projection;
- `checkout.preview` for a checkout projection before payment;
- `order.invoice` for an authenticated customer invoice link.

Keep final payment authorization and provider checkout handoff behind explicit
host confirmation.

## Boundary Checklist

- Public plugin JSON routes expose catalog sellables and stock availability
  only.
- Product pages have accessible HTML and no-JS forms.
- JSON-LD, visible content, and Mika sellables agree.
- `.well-known/mika-agent.json` includes public descriptors only by default.
- `llms.txt` describes surfaces without pretending to be a tool contract.
- Protected agent tools require host-owned auth, policy, confirmation,
  provider wiring, and idempotency handling.
