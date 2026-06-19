import {
  MIKA_AGENT_MANIFEST_VERSION,
  createMikaAgentManifest,
  mikaAgentManifestJsonSchema,
} from "@bnomei/emdash-mika/agent";
import type { APIRoute } from "astro";

export const prerender = true;

const agentManifestSchemaId =
  typeof mikaAgentManifestJsonSchema["$id"] === "string"
    ? mikaAgentManifestJsonSchema["$id"]
    : undefined;
const mikaPluginRouteBasePath = "/_emdash/api/plugins/mika";

export const GET: APIRoute = () => {
  const manifest = createMikaAgentManifest({ include: ["public"] });

  return Response.json({
    name: "Mika storefront",
    description:
      "Agent-readable commerce metadata for a Mika storefront. Host routes own protected mutation and checkout flows.",
    schema: agentManifestSchemaId,
    version: MIKA_AGENT_MANIFEST_VERSION,
    routeBasePath: mikaPluginRouteBasePath,
    manifest,
    protectedFlowSummaries: [
      {
        operation: "checkout.start",
        label: "Cart checkout",
        requires: ["host OAuth or session policy", "user confirmation", "payment provider wiring"],
      },
      {
        operation: "order.invoice",
        label: "Account order invoice",
        requires: ["host OAuth or account session", "customer scope"],
      },
    ],
  });
};
