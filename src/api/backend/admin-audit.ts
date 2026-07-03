/**
 * Admin-action audit trail: the durable, idempotency-keyed record every admin operation writes
 * before/after running, the provider-feature dispatch helper those actions use to reach a
 * provider adapter method, and the small JSON-stability helpers (stable stringify, idempotency
 * widening) the audit hash and snapshot logic depends on.
 */
import type { MikaProviderAdapter } from "../../provider";
import type { AdminAuditDocument } from "../../types/documents";
import { isJsonObject } from "../../types/primitives";
import type {
  ISODateTime,
  JsonObject,
  JsonValue,
  MikaId,
  ProviderName,
} from "../../types/primitives";
import type { AdminActionResultDTO, MikaApiResult, MikaProviderCapability } from "../types";
import {
  adminIdempotencyInputMismatch,
  observeBackendError,
  providerFailed,
  providerUnsupportedForAction,
} from "./errors";
import type { MikaApiFailure } from "./errors";
import { currentBackendISODateTime } from "./shared";
import type { CreateMikaBackendApiInput } from "./ports";

export type MikaProviderMethodName = Extract<
  {
    readonly [K in keyof MikaProviderAdapter]: NonNullable<MikaProviderAdapter[K]> extends (
      ...args: any[]
    ) => any
      ? K
      : never;
  }[keyof MikaProviderAdapter],
  keyof MikaProviderAdapter
>;

export type MikaProviderFeature<TMethod extends MikaProviderMethodName> =
  | {
      readonly ok: true;
      readonly providerName: ProviderName;
      readonly provider: MikaProviderAdapter;
      readonly method: NonNullable<MikaProviderAdapter[TMethod]>;
    }
  | MikaApiFailure;

export interface MikaProviderFeatureOptions<TMethod extends MikaProviderMethodName> {
  readonly providerName?: ProviderName;
  readonly method: TMethod;
  readonly capability?: MikaProviderCapability;
  readonly capabilityFailureMessage?: string;
  readonly missingProviderMessage?: string;
  readonly unsupportedMessage: (providerName: ProviderName) => string;
}

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

export async function completeAdminAudit(
  input: CreateMikaBackendApiInput,
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

export function adminAuditReplayResult<TData extends JsonObject>(
  audit: AdminAuditDocument,
): TData | null {
  const storedVersion = audit.record.metadata?.[ADMIN_AUDIT_RESULT_SCHEMA_VERSION_METADATA_KEY];
  if (storedVersion !== ADMIN_AUDIT_RESULT_SCHEMA_VERSION) return null;

  const snapshot = audit.record.metadata?.[ADMIN_AUDIT_RESULT_METADATA_KEY];

  return isJsonObject(snapshot) ? (snapshot as TData) : null;
}

export function adminAuditStoredIdempotencyInputHash(
  audit: AdminAuditDocument,
): string | undefined {
  const value = audit.record.metadata?.[ADMIN_AUDIT_IDEMPOTENCY_INPUT_HASH_METADATA_KEY];

  return typeof value === "string" ? value : undefined;
}

export async function adminActionIdempotencyInputHash(
  input: CreateMikaBackendApiInput,
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

export async function failAdminAudit(
  input: CreateMikaBackendApiInput,
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

export async function requireProviderFeature<TMethod extends MikaProviderMethodName>(
  input: CreateMikaBackendApiInput,
  options: MikaProviderFeatureOptions<TMethod>,
): Promise<MikaProviderFeature<TMethod>> {
  const providerName = options.providerName ?? input.defaults?.provider;
  if (!providerName) {
    return providerUnsupportedForAction(
      options.missingProviderMessage ?? "No provider is configured.",
    );
  }

  const provider = input.providers.get(providerName);
  if (!provider) {
    return providerUnsupportedForAction(`Provider '${providerName}' is not configured.`);
  }

  if (options.capability) {
    let capabilities: readonly MikaProviderCapability[];
    try {
      capabilities = await provider.capabilities();
    } catch {
      return providerFailed(
        options.capabilityFailureMessage ?? "Provider capabilities could not be verified.",
      );
    }
    if (!capabilities.includes(options.capability)) {
      return providerUnsupportedForAction(options.unsupportedMessage(providerName));
    }
  }

  const method = provider[options.method];
  if (typeof method !== "function") {
    return providerUnsupportedForAction(options.unsupportedMessage(providerName));
  }

  return {
    ok: true,
    providerName,
    provider,
    method: method as NonNullable<MikaProviderAdapter[TMethod]>,
  };
}

export async function runAdminProviderAction<TData>(
  input: CreateMikaBackendApiInput,
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
  input: CreateMikaBackendApiInput,
  record: MikaAdminAuditStartRecord,
  action: (audit: AdminAuditDocument) => Promise<TData>,
  fallbackMessage: string,
): Promise<MikaApiResult<TData>> {
  // Repository errors can carry driver/SQL fragments: the wire gets the static fallback while
  // the detailed message stays in the audit document.
  return runAdminAction(input, record, action, fallbackMessage, adminActionFailed, "fallback");
}

export async function runAdminAction<TData>(
  input: CreateMikaBackendApiInput,
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

export function missingTarget(targetType: string, field: string, value: string): MikaApiFailure {
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
  input: CreateMikaBackendApiInput,
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

export function adminActionFailed(message: string): MikaApiFailure {
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

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

export function createAdminAuditDocument(
  input: CreateMikaBackendApiInput,
  record: Omit<AdminAuditDocument["record"], "id">,
): AdminAuditDocument {
  const id = input.createId("admin_audit");

  return {
    id,
    type: "adminAudit",
    schemaVersion: 1,
    actorId: record.actorId,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    record: {
      id,
      ...record,
    },
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  };
}
