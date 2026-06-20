import { createMika } from "@bnomei/emdash-mika/astro";
import { createProviderName } from "@bnomei/emdash-mika/types";
import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, url }) => {
  const provider = params["provider"];
  if (!provider) return new Response("Missing provider.", { status: 400 });

  const Mika = createMika({ request, url }, { includeWebhook: true });
  const result = await Mika.webhook.receive({
    provider: createProviderName(provider),
  });

  return Response.json(result, { status: result.status });
};
