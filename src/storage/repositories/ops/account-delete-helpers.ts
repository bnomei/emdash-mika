import { mirrorRecordFields } from "../record-mirror";
import type { ExactPartial } from "../../../internal/object";
import type { AccountDeleteRequestDocument, AccountExportDocument } from "../../../types/documents";
import type {
  AccountDeleteEmailRedactionRepositoryInput,
  AccountDeleteMaintenanceStepRepositoryInput,
} from "../contracts";
import { isJsonObject, type ISODateTime, type JsonObject } from "../../../types/primitives";

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
  patch: ExactPartial<AccountDeleteRequestDocument["record"]>,
): AccountDeleteRequestDocument {
  return mirrorRecordFields(request, now, patch, [
    "customerId",
    "userId",
    "emailHash",
    "status",
    "expiresAt",
  ]);
}
