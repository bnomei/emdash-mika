/**
 * Webhook intake: signature verification, duplicate detection, raw-payload storage/normalization
 * for replay, and the admin-facing replay entry point. Delegates the actual payment/subscription
 * business logic to ./payment once a webhook has been durably recorded.
 */
import type { MikaProviderWebhookEvent, MikaVerifiedWebhookPayload } from "../../../provider";
import type { WebhookDocument } from "../../../types/documents";
import type { JsonObject } from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import type {
  AdminActionResultDTO,
  MikaApiResult,
  WebhookReceiveDTO,
  WebhookReceiveInput,
  WebhookReplayInput,
} from "../../types";
import { runAdminRepositoryAction, toIdempotencyJson } from "../admin-audit";
import {
  apiFailure,
  observeBackendError,
  providerFailed,
  webhookInvalid,
  webhookProcessingDeferred,
} from "../errors";
import type { MikaBackendDependencies } from "../ports";
import {
  booleanChild,
  currentBackendISODateTime,
  customerChild,
  isoChild,
  isSubscriptionStatus,
  jsonChild,
  jsonObject,
  moneyToJson,
  providerLineChildren,
  providerLineToJson,
  stringChild,
  totalsChild,
} from "../shared";
import { markWebhookFailed, processStoredWebhook } from "./payment";
import { isReplayableWebhookStatus } from "./status";

export async function receiveWebhook(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  webhookInput: WebhookReceiveInput,
): Promise<MikaApiResult<WebhookReceiveDTO>> {
  const provider = input.providers.get(webhookInput.provider);
  if (!provider?.verifyWebhook || !provider.parseWebhookEvent) {
    return webhookInvalid("Webhook provider does not support verified webhooks.");
  }

  const request = ctx.request;
  if (!request) {
    return webhookInvalid("Webhook request is unavailable.");
  }

  const rawBody = await readWebhookRawBody(request);
  if (!rawBody) {
    return webhookInvalid("Webhook raw body is unavailable.");
  }

  let verified: MikaVerifiedWebhookPayload;
  let event: MikaProviderWebhookEvent;
  try {
    verified = await provider.verifyWebhook({
      provider: webhookInput.provider,
      request,
      rawBody,
    });
    event = await provider.parseWebhookEvent(verified);
  } catch (error) {
    observeBackendError(input, "webhook.verify", error, { provider: webhookInput.provider });
    return webhookInvalid("Webhook signature or payload could not be verified.");
  }

  if (verified.provider !== webhookInput.provider || event.provider !== webhookInput.provider) {
    return webhookInvalid("Webhook provider binding does not match the request.");
  }

  const eventType = event.type || webhookInput.eventType;
  if (!eventType) {
    return webhookInvalid("Webhook event type is unavailable.");
  }

  const providerEventId = event.providerEventId ?? webhookInput.providerEventId;
  const duplicate = await input.repositories.ops.findWebhookDuplicate({
    provider: webhookInput.provider,
    providerEventId,
    eventType,
    payloadHash: verified.payloadHash,
  });
  if (duplicate) {
    if (!webhookDuplicateCanReprocess(event, duplicate)) {
      return webhookDuplicateResult(duplicate);
    }

    const reprocessed = await processStoredWebhook(input, ctx, duplicate, event);
    return webhookReceiptResult(reprocessed, event);
  }

  const webhook = createWebhookDocument(input, ctx, verified, event, {
    eventType,
    providerEventId,
  });

  try {
    await input.repositories.ops.put(webhook);
  } catch (error) {
    observeBackendError(input, "webhook.store", error, { provider: webhookInput.provider });
    const replayedDuplicate = await input.repositories.ops.findWebhookDuplicate({
      provider: webhookInput.provider,
      providerEventId,
      eventType,
      payloadHash: verified.payloadHash,
    });
    if (replayedDuplicate) return webhookDuplicateResult(replayedDuplicate);

    return providerFailed("Webhook could not be stored.");
  }

  const processedWebhook = await processStoredWebhook(input, ctx, webhook, event);

  return webhookReceiptResult(processedWebhook, event);
}

function webhookDuplicateCanReprocess(
  event: MikaProviderWebhookEvent,
  duplicate: WebhookDocument,
): boolean {
  if (event.kind === "payment")
    return duplicate.status === "failed" || duplicate.status === "received";
  if (event.kind === "subscription") return duplicate.status === "received";

  return false;
}

export async function replayWebhook(
  input: MikaBackendDependencies,
  replayInput: WebhookReplayInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const webhook = await input.repositories.ops.findWebhookById(replayInput.webhookId);
  if (!webhook) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "NOT_FOUND",
        message: `Webhook '${replayInput.webhookId}' was not found.`,
        fieldErrors: { webhookId: "Webhook was not found." },
      },
    };
  }

  if (replayInput.idempotencyKey) {
    return runAdminRepositoryAction(
      input,
      {
        action: "webhook.replay",
        targetType: "webhook",
        targetId: webhook.id,
        idempotencyKey: replayInput.idempotencyKey,
        idempotencyInput: toIdempotencyJson(replayInput),
        metadata: {
          webhookId: webhook.id,
          provider: webhook.provider,
          eventType: webhook.eventType,
          ...(webhook.providerEventId ? { providerEventId: webhook.providerEventId } : {}),
        },
      },
      () => replayStoredWebhook(input, webhook),
      "Webhook replay failed.",
    );
  }

  return {
    ok: true,
    status: 200,
    data: await replayStoredWebhook(input, webhook),
  };
}

async function replayStoredWebhook(
  input: MikaBackendDependencies,
  webhook: WebhookDocument,
): Promise<AdminActionResultDTO> {
  if (!isReplayableWebhookStatus(webhook.status)) {
    return {
      id: webhook.id,
      status: "completed",
      message: `Webhook '${webhook.id}' is not eligible for replay.`,
      affected: {
        processed: 0,
        failed: 0,
      },
    };
  }

  const event = storedWebhookEvent(webhook);
  if (!event) {
    const failed = await markWebhookFailed(
      input,
      webhook,
      currentBackendISODateTime(input),
      "Webhook payload could not be reconstructed for replay.",
    );

    return {
      id: failed.id,
      status: "failed",
      message: "Webhook payload could not be reconstructed for replay.",
      affected: {
        processed: 0,
        failed: 1,
      },
    };
  }

  const processed = await processStoredWebhook(
    input,
    { now: currentBackendISODateTime(input) },
    webhook,
    event,
  );
  if (event.kind === "payment" && processed === webhook) {
    return {
      id: webhook.id,
      status: "running",
      message: `Webhook '${webhook.id}' workflow is already running or not due for replay.`,
      affected: {
        processed: 0,
        failed: 0,
      },
    };
  }

  const processedCount = processed.status === "failed" ? 0 : 1;
  const failedCount = processed.status === "failed" ? 1 : 0;

  return {
    id: processed.id,
    status: processed.status === "failed" ? "failed" : "completed",
    affected: {
      processed: processedCount,
      failed: failedCount,
    },
  };
}

async function readWebhookRawBody(request: Request): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await request.clone().arrayBuffer());
  } catch {
    return null;
  }
}

function createWebhookDocument(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  verified: MikaVerifiedWebhookPayload,
  event: MikaProviderWebhookEvent,
  resolved: {
    readonly eventType: string;
    readonly providerEventId?: string;
  },
): WebhookDocument {
  const id = input.createId("webhook");
  const record = {
    id,
    provider: event.provider,
    providerEventId: resolved.providerEventId,
    eventType: resolved.eventType,
    payloadHash: verified.payloadHash,
    status: "received" as const,
    attemptCount: 0,
    receivedAt: ctx.now,
    rawPayloadJson: storedWebhookPayload(verified, event),
    normalizedPayloadJson: webhookEventToJson(event, { includeRaw: false }),
  };

  return {
    id,
    type: "webhook",
    schemaVersion: 1,
    provider: record.provider,
    providerEventId: record.providerEventId,
    eventType: record.eventType,
    payloadHash: record.payloadHash,
    status: record.status,
    receivedAt: record.receivedAt,
    record,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

function storedWebhookPayload(
  verified: MikaVerifiedWebhookPayload,
  event: MikaProviderWebhookEvent,
): JsonObject {
  return jsonObject({
    ...(verified.parsed ? { providerPayload: verified.parsed } : {}),
    ...(event.raw ? { providerPayload: verified.parsed ?? event.raw } : {}),
    normalizedEvent: webhookEventToJson(event, { includeRaw: true }),
  });
}

function webhookEventToJson(
  event: MikaProviderWebhookEvent,
  options: { readonly includeRaw: boolean },
): JsonObject {
  switch (event.kind) {
    case "payment":
      return jsonObject({
        kind: event.kind,
        paymentStatus: event.paymentStatus,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        providerCheckoutId: event.providerCheckoutId,
        providerPaymentId: event.providerPaymentId,
        providerOrderId: event.providerOrderId,
        providerSubscriptionId: event.providerSubscriptionId,
        customer: event.customer
          ? jsonObject({
              email: event.customer.email,
              name: event.customer.name,
              company: event.customer.company,
              vatId: event.customer.vatId,
            })
          : undefined,
        lines: event.lines.map(providerLineToJson),
        totals: event.totals
          ? jsonObject({
              subtotal: event.totals.subtotal ? moneyToJson(event.totals.subtotal) : undefined,
              discount: event.totals.discount ? moneyToJson(event.totals.discount) : undefined,
              tax: event.totals.tax ? moneyToJson(event.totals.tax) : undefined,
              total: event.totals.total ? moneyToJson(event.totals.total) : undefined,
            })
          : undefined,
        invoiceUrl: event.invoiceUrl,
        raw: options.includeRaw ? event.raw : undefined,
      });
    case "subscription":
      return jsonObject({
        kind: event.kind,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        providerSubscriptionId: event.providerSubscriptionId,
        providerCustomerId: event.providerCustomerId,
        providerPriceId: event.providerPriceId,
        status: event.status,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        raw: options.includeRaw ? event.raw : undefined,
      });
    case "unknown":
      return jsonObject({
        kind: event.kind,
        provider: event.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        raw: options.includeRaw ? event.raw : undefined,
      });
  }
}

function storedWebhookEvent(webhook: WebhookDocument): MikaProviderWebhookEvent | null {
  const rawPayload = webhook.record.rawPayloadJson;
  const payload =
    webhook.record.normalizedPayloadJson ??
    (rawPayload ? (jsonChild(rawPayload, "normalizedEvent") ?? rawPayload) : undefined);
  if (!payload) return null;

  const eventPayload =
    jsonChild(payload, "normalizedEvent") ?? (stringChild(payload, "kind") ? payload : null);
  if (!eventPayload) return null;

  const provider = stringChild(eventPayload, "provider");
  const type = stringChild(eventPayload, "type");
  if (provider !== webhook.provider || !type) return null;

  switch (stringChild(eventPayload, "kind")) {
    case "payment": {
      const paymentStatus = stringChild(eventPayload, "paymentStatus") ?? "failed";
      return {
        kind: "payment",
        paymentStatus,
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        providerCheckoutId: stringChild(eventPayload, "providerCheckoutId"),
        providerPaymentId: stringChild(eventPayload, "providerPaymentId"),
        providerOrderId: stringChild(eventPayload, "providerOrderId"),
        providerSubscriptionId: stringChild(eventPayload, "providerSubscriptionId"),
        customer: customerChild(eventPayload, "customer"),
        lines: providerLineChildren(eventPayload, "lines"),
        totals: totalsChild(eventPayload, "totals"),
        invoiceUrl: stringChild(eventPayload, "invoiceUrl"),
        raw: jsonChild(eventPayload, "raw"),
      };
    }
    case "subscription": {
      const status = stringChild(eventPayload, "status");
      if (!isSubscriptionStatus(status)) return null;

      return {
        kind: "subscription",
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        providerSubscriptionId: stringChild(eventPayload, "providerSubscriptionId"),
        providerCustomerId: stringChild(eventPayload, "providerCustomerId"),
        providerPriceId: stringChild(eventPayload, "providerPriceId"),
        status,
        currentPeriodStart: isoChild(eventPayload, "currentPeriodStart"),
        currentPeriodEnd: isoChild(eventPayload, "currentPeriodEnd"),
        cancelAtPeriodEnd: booleanChild(eventPayload, "cancelAtPeriodEnd"),
        raw: jsonChild(eventPayload, "raw"),
      };
    }
    case "unknown":
      return {
        kind: "unknown",
        provider: webhook.provider,
        providerEventId: stringChild(eventPayload, "providerEventId") ?? webhook.providerEventId,
        type,
        raw: jsonChild(eventPayload, "raw"),
      };
    default:
      return null;
  }
}

export function webhookDuplicateResult(
  duplicate: WebhookDocument,
): MikaApiResult<WebhookReceiveDTO> {
  return {
    ok: true,
    status: 200,
    data: {
      id: duplicate.id,
      status: "duplicate",
      replayable: duplicate.status === "failed" ? true : undefined,
    },
  };
}

export function webhookReceiptResult(
  webhook: WebhookDocument,
  event: MikaProviderWebhookEvent,
): MikaApiResult<WebhookReceiveDTO> {
  if (
    (event.kind === "payment" || event.kind === "subscription") &&
    webhook.status === "received"
  ) {
    return webhookProcessingDeferred(webhook.id);
  }
  if (
    event.kind === "payment" &&
    (event.paymentStatus === "refunded" || event.paymentStatus === "partially_refunded") &&
    webhook.status === "failed"
  ) {
    return apiFailure(
      502,
      "PROVIDER_FAILED",
      webhook.record.lastError ?? "Refund webhook could not be processed.",
    );
  }
  if (
    (event.kind === "payment" || event.kind === "subscription") &&
    webhook.status === "failed" &&
    webhook.record.retryable === true
  ) {
    return apiFailure(
      502,
      "PROVIDER_FAILED",
      webhook.record.lastError ?? "Webhook could not be processed.",
    );
  }

  return {
    ok: true,
    status: 200,
    data: {
      id: webhook.id,
      status: webhook.status === "failed" ? "failed" : "received",
      replayable: true,
    },
  };
}
