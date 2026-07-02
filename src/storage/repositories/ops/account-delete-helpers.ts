import { mirrorRecordFields } from "../record-mirror";
import type { AccountDeleteRequestDocument, AccountExportDocument } from "../../../types/documents";
import {
  isJsonObject,
  type ISODateTime,
  type JsonObject,
  type MikaId,
} from "../../../types/primitives";

/** Input for completing a queued account deletion request record. */
export interface AccountDeleteRequestCompletionRepositoryInput {
  readonly requestId: MikaId;
  readonly now: ISODateTime;
  readonly metadata?: JsonObject;
}

/** Input for failing a queued account deletion request record. */
export interface AccountDeleteRequestFailureRepositoryInput {
  readonly requestId: MikaId;
  readonly now: ISODateTime;
  readonly lastError: string;
}

/** Input for recording one completed account-delete maintenance step. */
export interface AccountDeleteMaintenanceStepRepositoryInput {
  readonly requestId: MikaId;
  readonly now: ISODateTime;
  readonly stepName: string;
  readonly result: JsonObject;
}

/** Identity selectors for redacting queued email records after account deletion. */
export interface AccountDeleteEmailRedactionRepositoryInput {
  readonly now: ISODateTime;
  readonly customerId?: MikaId;
  readonly userId?: string;
  readonly emailHash?: string;
}

export function accountExportMatchesAccountDeleteIdentity(
  document: AccountExportDocument,
  identity: AccountDeleteEmailRedactionRepositoryInput,
): boolean {
  const record = document.record;

  return Boolean(
    (identity.customerId && record.customerId === identity.customerId) ||
    (identity.userId && record.userId === identity.userId) ||
    (identity.emailHash && record.emailHash === identity.emailHash),
  );
}

export function accountDeleteMaintenanceStepMetadata(
  metadata: JsonObject | undefined,
  input: AccountDeleteMaintenanceStepRepositoryInput,
): JsonObject {
  const maintenance = jsonObjectChild(metadata, "maintenance");
  const steps = jsonObjectChild(maintenance, "steps");

  return {
    ...metadata,
    maintenance: {
      ...maintenance,
      steps: {
        ...steps,
        [input.stepName]: {
          status: "completed",
          completedAt: input.now,
          result: input.result,
        },
      },
    },
  };
}

function jsonObjectChild(input: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = input?.[key];

  return isJsonObject(value) ? value : undefined;
}

export function accountDeleteRequestDocumentWithRecord(
  request: AccountDeleteRequestDocument,
  now: ISODateTime,
  patch: Partial<AccountDeleteRequestDocument["record"]>,
): AccountDeleteRequestDocument {
  return mirrorRecordFields(request, now, patch, [
    "customerId",
    "userId",
    "emailHash",
    "status",
    "expiresAt",
  ]);
}
