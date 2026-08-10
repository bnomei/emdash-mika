// mika-template-version: 0.1.1
/**
 * Provider webhook ingest route for the storefront template.
 * Hashes the raw body and forwards the public webhook receive input to `Mika.webhook.receive`.
 */
import { createHash } from "node:crypto";
import { createMika } from "@bnomei/emdash-mika/astro";
import { createProviderName, type WebhookReceiveInput } from "@bnomei/emdash-mika/types";
import type { APIRoute } from "astro";
import { api } from "../../../lib/mika-api";

/** Webhook ingest must read the live request body and provider route param. */
export const prerender = false;

/** Hashes the raw body and lets backend webhook ingest verify signatures from the live request. */
export const POST: APIRoute = async ({ params, request, url }) => {
  const provider = params["provider"];
  if (!provider) return new Response("Missing provider.", { status: 400 });

  const Mika = createMika({ request, url }, { api, includeWebhook: true });
  const rawBody = await request.clone().arrayBuffer();
  const payloadHash = "sha256:" + createHash("sha256").update(Buffer.from(rawBody)).digest("hex");
  const eventType = request.headers.get("x-event-type");
  const providerEventId = request.headers.get("x-provider-event-id");
  const receiveInput: WebhookReceiveInput = {
    provider: createProviderName(provider),
    payloadHash,
    ...(eventType ? { eventType } : {}),
    ...(providerEventId ? { providerEventId } : {}),
  };
  const result = await Mika.webhook.receive(receiveInput);

  return Response.json(result, { status: result.status });
};
