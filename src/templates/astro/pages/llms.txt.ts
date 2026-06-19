import {
  MIKA_AGENT_MANIFEST_VERSION,
  mikaAgentManifestJsonSchema,
} from "@bnomei/emdash-mika/agent";
import type { APIRoute } from "astro";

export const prerender = true;

const agentManifestSchemaId =
  typeof mikaAgentManifestJsonSchema["$id"] === "string"
    ? mikaAgentManifestJsonSchema["$id"]
    : "https://bnomei.com/schemas/emdash-mika/agent-manifest.v1.json";

export const GET: APIRoute = () =>
  new Response(
    [
      "# Mika storefront",
      "",
      "> Astro commerce pages powered by Mika primitives with public catalog reads and host-owned protected flows.",
      "",
      "Product pages should expose visible product details and matching JSON-LD Product/ProductGroup/Offer metadata. Protected cart, checkout, account, subscription, payment, and agent-tool flows require host-owned OAuth, policy checks, user confirmation, and provider wiring.",
      "",
      "## Files",
      "",
      `- [Agent capability manifest](/.well-known/mika-agent.json): Mika public operation manifest, schema ${agentManifestSchemaId}, version ${MIKA_AGENT_MANIFEST_VERSION}.`,
      "- [Product pages](/): Host-owned product detail pages with ProductStructuredData JSON-LD when copied into the page layout.",
      "",
      "## Commerce surface",
      "",
      "- Public reads: catalog.sellables and stock.availability",
      "- Public JSON route paths are relative to /_emdash/api/plugins/mika/.",
      "- Trusted agent projections: cart.quote and checkout.preview behind host-owned auth and confirmation policy.",
      "- Browser mutations: Astro Actions submitted by HTML forms, not public plugin JSON mutation routes.",
      "",
      "## Human entrypoints",
      "",
      "- Product pages, cart, checkout, account, wishlist, and downloads are owned by the host Astro project.",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    },
  );
