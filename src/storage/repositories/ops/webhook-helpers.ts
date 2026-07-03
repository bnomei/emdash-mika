import { mirrorRecordFields } from "../record-mirror";
import type { ExactPartial } from "../../../internal/object";
import type { WebhookDocument } from "../../../types/documents";
import type { ISODateTime } from "../../../types/primitives";

export function webhookRawPayloadIsPurgeable(
  webhook: WebhookDocument,
  cutoff: ISODateTime,
): boolean {
  return (
    webhook.record.receivedAt <= cutoff &&
    webhook.record.rawPayloadJson !== undefined &&
    webhook.record.rawPayloadPurgedAt === undefined &&
    (webhook.status === "processed" || webhook.record.normalizedPayloadJson !== undefined)
  );
}

export function webhookDocumentWithRecord(
  webhook: WebhookDocument,
  now: ISODateTime,
  patch: ExactPartial<WebhookDocument["record"]>,
): WebhookDocument {
  return mirrorRecordFields(webhook, now, patch, ["status", "nextAttemptAt", "receivedAt"]);
}
