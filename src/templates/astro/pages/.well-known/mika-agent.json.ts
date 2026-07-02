// mika-template-version: 0.0.0
/**
 * Agent capability manifest at `/.well-known/mika-agent.json`.
 * Publishes public Mika operations and protected-flow requirements for agents.
 */
import {
  MIKA_AGENT_MANIFEST_VERSION,
  createMikaAgentManifest,
  mikaAgentManifestJsonSchema,
} from "@bnomei/emdash-mika/agent";
import type { APIRoute } from "astro";

/** Serve dynamically so the manifest reflects the host's current public operation set. */
export const prerender = false;

const agentManifestSchemaId =
  typeof mikaAgentManifestJsonSchema["$id"] === "string"
    ? mikaAgentManifestJsonSchema["$id"]
    : undefined;
const mikaPluginRouteBasePath = "/_emdash/api/plugins/mika";

/** Returns the storefront agent manifest JSON for `/.well-known/mika-agent.json`. */
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
