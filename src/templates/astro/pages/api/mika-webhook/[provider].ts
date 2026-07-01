/**
 * Provider webhook ingest route for the storefront template.
 * Hashes the raw body, records signature metadata, and forwards to `Mika.webhook.receive`.
 */
import { createHash } from "node:crypto";
import { createMika } from "@bnomei/emdash-mika/astro";
import { createProviderName } from "@bnomei/emdash-mika/types";
import type { APIRoute } from "astro";

/** Webhook ingest must read the live request body and provider route param. */
export const prerender = false;

/** Hashes the raw body, records signature-header presence, and forwards to `webhook.receive` for verification. */
export const POST: APIRoute = async ({ params, request, url }) => {
  const provider = params["provider"];
  if (!provider) return new Response("Missing provider.", { status: 400 });

  const Mika = createMika({ request, url }, { includeWebhook: true });
  const rawBody = await request.clone().arrayBuffer();
  const payloadHash = "sha256:" + createHash("sha256").update(Buffer.from(rawBody)).digest("hex");
  // Presence-only metadata; cryptographic verification happens inside webhook.receive.
  const signatureHeaderPresent =
    request.headers.has("stripe-signature") ||
    request.headers.has("paddle-signature") ||
    request.headers.has("webhook-signature") ||
    request.headers.has("x-mika-signature");
  const eventType = request.headers.get("x-event-type");
  const providerEventId = request.headers.get("x-provider-event-id");
  const receiveInput = {
    provider: createProviderName(provider),
    payloadHash,
    rawBodyLength: rawBody.byteLength,
    signatureHeaderPresent,
    ...(eventType ? { eventType } : {}),
    ...(providerEventId ? { providerEventId } : {}),
  };
  const result = await Mika.webhook.receive(receiveInput);

  return Response.json(result, { status: result.status });
};
