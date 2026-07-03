/**
 * Admin-action audit trail: the durable, idempotency-keyed record every admin operation writes
 * before/after running, and the audit-hash/snapshot logic around it. Provider-feature dispatch
 * lives in ./provider-dispatch and the stable-JSON helper in ./shared.
 */
import { omitUndefined } from "../../internal/object";
import type { AdminAuditDocument } from "../../types/documents";
import { isJsonObject } from "../../types/primitives";
import type { ISODateTime, JsonObject, JsonValue, MikaId } from "../../types/primitives";
import type { AdminActionResultDTO, MikaApiResult } from "../types";
import { adminIdempotencyInputMismatch, observeBackendError, providerFailed } from "./errors";
import type { MikaApiFailure } from "./errors";
import { currentBackendISODateTime, stableJsonStringify } from "./shared";
import type { MikaBackendDependencies } from "./ports";

export type MikaAdminAuditStartRecord = Omit<
  AdminAuditDocument["record"],
  "id" | "status" | "createdAt"
> & {
  readonly createdAt?: ISODateTime;
  /**
   * Deterministic, client-supplied request input used only to compute the
   * idempotency hash. Kept separate from (and not persisted with) the audit
   * record so server-derived audit fields — a freshly minted `targetId`, a
   * wall-clock `metadata.expiresAt` — do not make identical retries hash
   * differently and force a false `same_key_same_input` conflict.
   */
  readonly idempotencyInput?: JsonValue;
};

const ADMIN_AUDIT_RESULT_METADATA_KEY = "result";
const ADMIN_AUDIT_RESULT_SCHEMA_VERSION_METADATA_KEY = "resultSchemaVersion";
const ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY = "idempotencyInputHash";

/**
 * Bump whenever a public admin action result DTO's shape changes. A stored replay snapshot
 * whose tagged version does not match the running code's version — including any snapshot
 * written before this tag existed — is treated as unsafe to replay rather than blindly cast to
 * the caller's current TData: {@link adminAuditReplayResult} returns null, and the idempotency
 * claim falls through to the standard "already in progress" conflict, forcing a fresh key.
 */
const ADMIN_AUDIT_RESULT_SCHEMA_VERSION = 1;

async function completeAdminAudit(
  input: MikaBackendDependencies,
  audit: AdminAuditDocument,
  result?: unknown,
): Promise<void> {
  const resultSnapshot = audit.record.idempotencyKey && isJsonObject(result) ? result : undefined;

  await input.repositories.ops.writeAudit({
    ...audit,
    status: "completed",
    updatedAt: currentBackendISODateTime(input),
    record: {
      ...audit.record,
      status: "completed",
      ...(resultSnapshot
        ? {
            metadata: {
              ...audit.record.metadata,
              [ADMIN_AUDIT_RESULT_METADATA_KEY]: resultSnapshot,
              [ADMIN_AUDIT_RESULT_SCHEMA_VERSION_METADATA_KEY]: ADMIN_AUDIT_RESULT_SCHEMA_VERSION,
            },
          }
        : {}),
    },
  });
}

function adminAuditReplayResult<TData extends JsonObject>(audit: AdminAuditDocument): TData | null {
  const storedVersion = audit.record.metadata?.[ADMIN_AUDIT_RESULT_SCHEMA_VERSION_METADATA_KEY];
  if (storedVersion !== ADMIN_AUDIT_RESULT_SCHEMA_VERSION) return null;

  const snapshot = audit.record.metadata?.[ADMIN_AUDIT_RESULT_METADATA_KEY];

  return isJsonObject(snapshot) ? (snapshot as TData) : null;
}

function adminAuditStoredIdempotencyInputHash(audit: AdminAuditDocument): string | undefined {
  const value = audit.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];

  return typeof value === "string" ? value : undefined;
}

async function adminActionIdempotencyInputHash(
  input: MikaBackendDependencies,
  idempotencyInput: JsonValue | undefined,
  record: Pick<MikaAdminAuditStartRecord, "action" | "targetType" | "targetId" | "metadata">,
): Promise<string> {
  const hashedInput =
    idempotencyInput !== undefined
      ? idempotencyInput
      : {
          action: record.action,
          targetType: record.targetType,
          targetId: record.targetId,
          metadata: record.metadata,
        };

  return input.hash(stableJsonStringify(hashedInput));
}

async function failAdminAudit(
  input: MikaBackendDependencies,
  audit: AdminAuditDocument,
  message: string,
): Promise<void> {
  await input.repositories.ops.writeAudit({
    ...audit,
    status: "failed",
    updatedAt: currentBackendISODateTime(input),
    record: {
      ...audit.record,
      status: "failed",
      metadata: {
        ...audit.record.metadata,
        error: message,
      },
    },
  });
}

export async function runAdminProviderAction<TData>(
  input: MikaBackendDependencies,
  record: MikaAdminAuditStartRecord,
  action: (audit: AdminAuditDocument) => Promise<TData>,
  fallbackMessage: string,
): Promise<MikaApiResult<TData>> {
  // Provider errors are admin-facing diagnostics: their message stays on the wire.
  return runAdminAction(input, record, action, fallbackMessage, providerFailed, "detailed");
}

export function assertCompletedProviderAction(
  result: AdminActionResultDTO,
  fallbackMessage: string,
): void {
  if (result.status === "completed") return;

  throw new Error(result.message ?? `${fallbackMessage} (status: ${result.status}).`);
}

export async function runAdminRepositoryAction<TData>(
  input: MikaBackendDependencies,
  record: MikaAdminAuditStartRecord,
  action: (audit: AdminAuditDocument) => Promise<TData>,
  fallbackMessage: string,
): Promise<MikaApiResult<TData>> {
  // Repository errors can carry driver/SQL fragments: the wire gets the static fallback while
  // the detailed message stays in the audit document.
  return runAdminAction(input, record, action, fallbackMessage, adminActionFailed, "fallback");
}

async function runAdminAction<TData>(
  input: MikaBackendDependencies,
  record: MikaAdminAuditStartRecord,
  action: (audit: AdminAuditDocument) => Promise<TData>,
  fallbackMessage: string,
  failure: (message: string) => MikaApiFailure,
  wireMessage: "detailed" | "fallback" = "detailed",
): Promise<MikaApiResult<TData>> {
  const { idempotencyInput, ...auditRecord } = record;
  const idempotencyInputHash = record.idempotencyKey
    ? await adminActionIdempotencyInputHash(input, idempotencyInput, auditRecord)
    : undefined;
  let audit = createAdminAuditDocument(input, {
    ...auditRecord,
    status: "started",
    createdAt: record.createdAt ?? currentBackendISODateTime(input),
    ...(idempotencyInputHash
      ? {
          metadata: {
            ...auditRecord.metadata,
            [ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY]: idempotencyInputHash,
          },
        }
      : {}),
  });
  if (record.idempotencyKey) {
    const claim = await input.repositories.ops.claimAdminAuditIdempotency(audit);
    if (claim.status === "existing") {
      return adminIdempotencyClaimResult<TData>(record.action, idempotencyInputHash, claim.audit);
    }
    audit = claim.audit;
  } else {
    await input.repositories.ops.writeAudit(audit);
  }

  try {
    const data = await action(audit);
    await completeAdminAudit(input, audit, data);

    return {
      ok: true,
      status: 200,
      data,
    };
  } catch (error) {
    // The detailed message is always preserved in the audit document and the error object always
    // reaches the host observer; whether the wire envelope carries the detail is the caller's
    // choice (provider diagnostics: yes; repository/driver errors: static fallback).
    const message = error instanceof Error ? error.message : fallbackMessage;
    observeBackendError(input, `admin.action.${record.action}`, error, { action: record.action });
    await failAdminAudit(input, audit, message);

    return failure(wireMessage === "detailed" ? message : fallbackMessage);
  }
}

function adminIdempotencyClaimResult<TData>(
  action: string,
  idempotencyInputHash: string | undefined,
  prior: AdminAuditDocument,
): MikaApiResult<TData> {
  const priorInputHash = adminAuditStoredIdempotencyInputHash(prior);
  if (
    priorInputHash !== undefined &&
    idempotencyInputHash !== undefined &&
    priorInputHash !== idempotencyInputHash
  ) {
    return adminIdempotencyInputMismatch(action);
  }

  if (prior.record.status === "completed") {
    const replay = adminAuditReplayResult<JsonObject>(prior);
    if (replay !== null) {
      return { ok: true, status: 200, data: replay as TData };
    }

    // Completed, but its result snapshot is untrusted (missing or from a different result
    // schema version) — refuse to replay a possibly shape-mismatched payload as a typed success.
    return {
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Admin action '${action}' already completed for this idempotency key, but its stored result cannot be safely replayed. Retry with a new idempotency key.`,
      },
    };
  }

  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: `Admin action '${action}' is already in progress for this idempotency key.`,
    },
  };
}

function missingTarget(targetType: string, field: string, value: string): MikaApiFailure {
  const label = targetType[0]?.toUpperCase() + targetType.slice(1);

  return {
    ok: false,
    status: 404,
    error: {
      code: "NOT_FOUND",
      message: `${label} '${value}' was not found.`,
      fieldErrors: { [field]: `${label} was not found.` },
    },
  };
}

export async function missingTargetWithAudit(
  input: MikaBackendDependencies,
  missing: {
    readonly action: string;
    readonly targetType: string;
    readonly field: string;
    readonly value: string;
    readonly targetId?: MikaId;
    readonly metadata?: JsonObject;
  },
): Promise<MikaApiFailure> {
  const failure = missingTarget(missing.targetType, missing.field, missing.value);
  const now = currentBackendISODateTime(input);
  const audit = createAdminAuditDocument(input, {
    action: missing.action,
    targetType: missing.targetType,
    ...(missing.targetId ? { targetId: missing.targetId } : {}),
    status: "failed",
    createdAt: now,
    metadata: {
      ...missing.metadata,
      error: failure.error.message,
      field: missing.field,
      value: missing.value,
    },
  });
  await input.repositories.ops.writeAudit(audit);

  return failure;
}

function adminActionFailed(message: string): MikaApiFailure {
  return {
    ok: false,
    status: 500,
    error: {
      code: "INTERNAL",
      message,
    },
  };
}

/**
 * Widens a JSON-shaped wire input to JsonValue for idempotency hashing and audit snapshots.
 * Operation inputs are plain JSON DTOs, but their interfaces lack index signatures so
 * TypeScript cannot prove the assignment; this is the one sanctioned place for that cast.
 */
export function toIdempotencyJson(input: object): JsonValue {
  return input as unknown as JsonValue;
}

function createAdminAuditDocument(
  input: MikaBackendDependencies,
  record: Omit<AdminAuditDocument["record"], "id">,
): AdminAuditDocument {
  const id = input.createId("admin_audit");

  return omitUndefined({
    id,
    type: "adminAudit",
    schemaVersion: 1,
    actorId: record.actorId,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    record: omitUndefined({
      id,
      ...record,
    }),
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  });
}
