/**
 * Pure webhook status predicates shared by ./ingest and ./payment. Kept as a leaf module so the
 * intake and processing layers never need to import each other at runtime.
 */
import type { WebhookDocument } from "../../../types/documents";

export function isReplayableWebhookStatus(status: WebhookDocument["status"]): boolean {
  return (
    status === "failed" ||
    status === "received" ||
    status === "processing" ||
    isLegacyQueuedWebhookStatus(status)
  );
}

function isLegacyQueuedWebhookStatus(status: unknown): status is "queued" {
  return status === "queued";
}
