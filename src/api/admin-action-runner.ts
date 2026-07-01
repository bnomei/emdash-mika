/**
 * Resolves EmDash admin action invocations into validated Mika operations and UI-facing results.
 * Maps button targets, form context, and payloads onto operation inputs and result adapters.
 */
import {
  mikaAdminActionDefinitions,
  type MikaAdminActionId,
  type MikaAdminActionTarget,
  type MikaAdminActionTargetMetadata,
} from "../admin";
import { parseMikaInput, type z } from "./validation";
import { mikaOperationDefinitions, type MikaApiOperation } from "./operations";
import type { AdminActionResultDTO, ContentRefDTO, MikaApiResult, MikaError } from "./types";

/** Admin UI surface the action was triggered from (dashboard, entry, field, or row). */
export type MikaActionTarget =
  | { readonly type: "dashboard"; readonly surface?: "dashboard"; readonly kind?: string }
  | {
      readonly type: "entry";
      readonly surface?: "entry";
      readonly collection: string;
      readonly entryId: string;
      readonly locale?: string | null;
      readonly kind?: string;
    }
  | {
      readonly type: "field";
      readonly surface?: "field";
      readonly collection?: string;
      readonly entryId?: string;
      readonly locale?: string | null;
      readonly fieldName?: string;
      readonly kind?: string;
      readonly value?: unknown;
    }
  | {
      readonly type: "row";
      readonly surface?: "row";
      readonly collection?: string;
      readonly entryId?: string;
      readonly locale?: string | null;
      readonly fieldName?: string;
      readonly kind?: string;
      readonly rowId?: string;
      readonly path?: string;
      readonly value?: unknown;
      readonly row?: Record<string, unknown>;
    };

/** Host-provided context from the admin button or form that fired the action. */
export interface MikaActionButtonContext {
  readonly surface?: string;
  readonly collection?: string;
  readonly fieldName?: string;
  readonly entryId?: string;
  readonly entryLocale?: string | null;
  readonly fieldValue?: unknown;
  readonly entryData?: Record<string, unknown>;
  readonly formData?: Record<string, unknown>;
  readonly row?: Record<string, unknown>;
  readonly rowId?: string;
  readonly rowValue?: unknown;
  readonly [key: string]: unknown;
}

/** Raw admin action request before resolution to a Mika operation. */
export interface MikaActionInvocation {
  readonly actionId: string;
  readonly invocationId?: string;
  readonly payload?: Record<string, unknown>;
  readonly context?: MikaActionButtonContext;
  readonly target?: MikaActionTarget;
}

/** Fully resolved invocation ready for {@link runMikaOperation}. */
export interface MikaResolvedAdminActionInvocation {
  readonly actionId: MikaAdminActionId;
  readonly invocationId?: string;
  readonly operation: MikaApiOperation;
  readonly input: unknown;
  readonly target?: MikaActionTarget;
  readonly resultAdapter: MikaAdminActionResultAdapter;
}

/** EmDash admin UI envelope returned by the action runner endpoint. */
export type MikaAdminActionRunResult = {
  readonly ok?: boolean;
  readonly status?: number;
  readonly severity?: "default" | "positive" | "warning" | "danger" | "info" | "success" | "error";
  readonly message?: string;
  readonly jobId?: string;
  readonly jobStatus?: string;
  readonly effects?: {
    readonly reload?: boolean | { readonly delayMs?: number };
    readonly open?: string | { readonly url: string; readonly target?: "self" | "blank" };
  };
  readonly toast?: false | { readonly type?: string; readonly message?: string };
  readonly [key: string]: unknown;
};

type MikaApiFailure = Extract<MikaApiResult<unknown>, { readonly ok: false }>;

type MikaAdminActionResultAdapter = (result: MikaApiResult<unknown>) => MikaAdminActionRunResult;

interface MikaAdminActionTargetIdentityRequirement {
  readonly idKeys: readonly string[];
  readonly idFrom?: "value";
}

interface MikaAdminActionRuntimeDefinition {
  readonly operationKey: keyof typeof mikaOperationDefinitions;
  readonly inputResolver: (invocation: MikaActionInvocation) => Record<string, unknown>;
  readonly targetIdentity?: MikaAdminActionTargetIdentityRequirement;
  readonly resultAdapter: MikaAdminActionResultAdapter;
}

type MutableActionResultEffects = {
  reload?: boolean | { readonly delayMs?: number };
  open?: string | { readonly url: string; readonly target?: "self" | "blank" };
};
type MikaAdminActionInputResolverHelpers = {
  readonly invocation: MikaActionInvocation;
  readonly payload: Record<string, unknown>;
  readonly sources: readonly unknown[];
};
type MikaAdminActionInputDefaultsResolver = (
  helpers: MikaAdminActionInputResolverHelpers,
) => Record<string, unknown>;

function adminActionInputResolver(
  defaults: MikaAdminActionInputDefaultsResolver,
): MikaAdminActionRuntimeDefinition["inputResolver"] {
  return (invocation) => {
    const payload = actionPayload(invocation);
    const sources = invocationInputSources(invocation);

    return fillMissing(payload, defaults({ invocation, payload, sources }));
  };
}

/** Per-action wiring from admin action id to operation key, input resolver, and result adapter. */
export const mikaAdminActionRuntimeDefinitions: Readonly<
  Record<MikaAdminActionId, MikaAdminActionRuntimeDefinition>
> = {
  "mika.provider.health": {
    operationKey: "adminProviderHealth",
    inputResolver: adminActionInputResolver(({ sources }) => ({
      provider: findValue(["provider"], sources),
    })),
    resultAdapter: providerHealthResultAdapter,
  },
  "mika.provider.sync": {
    operationKey: "adminProviderSync",
    inputResolver: adminActionInputResolver(({ sources }) => ({
      provider: findValue(["provider"], sources),
      mode: findValue(["mode"], sources),
    })),
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.stock.releaseExpiredReservations": {
    operationKey: "adminStockReleaseExpiredReservations",
    inputResolver: adminActionInputResolver(({ sources }) => ({
      now: findValue(["now"], sources),
    })),
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.catalog.syncEntry": {
    operationKey: "adminProviderSync",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      provider: findValue(["provider"], sources),
      mode: findValue(["mode"], sources),
      scope: findValue(["scope"], sources) ?? "entry",
      contentRef: readTargetContentRef(invocation.context, invocation.target),
    })),
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.stock.adjust": {
    operationKey: "adminStockAdjust",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      stockItemId: findId(["stockItemId"], sources, invocation),
      quantityDelta: findValue(["quantityDelta"], sources),
      reason: findValue(["reason"], sources),
    })),
    targetIdentity: { idKeys: ["stockItemId"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.webhook.replay": {
    operationKey: "adminWebhookReplay",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      webhookId: findId(["webhookId"], sources, invocation),
    })),
    targetIdentity: { idKeys: ["webhookId"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.order.refund": {
    operationKey: "adminOrderRefund",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      orderId: findId(["orderId"], sources, invocation),
      amount: findValue(["amount"], sources),
      reason: findValue(["reason"], sources),
    })),
    targetIdentity: { idKeys: ["orderId"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.order.cancel": {
    operationKey: "adminOrderCancel",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      orderId: findId(["orderId"], sources, invocation),
      reason: findValue(["reason"], sources),
    })),
    targetIdentity: { idKeys: ["orderId"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.entitlement.grant": {
    operationKey: "adminEntitlementGrant",
    inputResolver: adminActionInputResolver(({ sources }) => ({
      entitlementKey: findValue(["entitlementKey"], sources),
      customerId: findValue(["customerId"], sources),
      userId: findValue(["userId"], sources),
      email: findValue(["email"], sources),
      expiresAt: findValue(["expiresAt"], sources),
    })),
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.entitlement.revoke": {
    operationKey: "adminEntitlementRevoke",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      entitlementId: findId(["entitlementId"], sources, invocation),
      entitlementKey: findValue(["entitlementKey"], sources),
      customerId: findValue(["customerId"], sources),
      reason: findValue(["reason"], sources),
    })),
    targetIdentity: { idKeys: ["entitlementId", "entitlementKey"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.email.resend": {
    operationKey: "adminEmailResend",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      emailId: findId(["emailId"], sources, invocation),
    })),
    targetIdentity: { idKeys: ["emailId"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.license.revoke": {
    operationKey: "adminLicenseRevoke",
    inputResolver: adminActionInputResolver(({ invocation, sources }) => ({
      licenseId: findId(["licenseId"], sources, invocation),
      reason: findValue(["reason"], sources),
    })),
    targetIdentity: { idKeys: ["licenseId"], idFrom: "value" },
    resultAdapter: adminActionDtoResultAdapter,
  },
  "mika.download.issue": {
    operationKey: "adminDownloadIssue",
    inputResolver: adminActionInputResolver(({ sources }) => ({
      entitlementId: findValue(["entitlementId"], sources),
      orderId: findValue(["orderId"], sources),
      orderLineId: findValue(["orderLineId"], sources),
      expiresAt: findValue(["expiresAt"], sources),
    })),
    targetIdentity: { idKeys: ["orderId", "entitlementId", "orderLineId"] },
    resultAdapter: adminActionDtoResultAdapter,
  },
};

/** Validates an invocation, resolves inputs from context, and selects the target operation. */
export function resolveMikaAdminActionInvocation(
  input: unknown,
): MikaApiResult<MikaResolvedAdminActionInvocation> {
  const invocation = parseActionInvocation(input);
  if (!invocation.ok) return invocation;

  const actionId = invocation.data.actionId as MikaAdminActionId;
  const runtime = mikaAdminActionRuntimeDefinitions[actionId];
  const operation = adminActionOperation(actionId);
  const resolvedInput = runtime.inputResolver(invocation.data);
  if (actionId === "mika.catalog.syncEntry" && !asRecord(resolvedInput["contentRef"])) {
    return runnerFailure(
      "VALIDATION_FAILED",
      "Mika catalog sync requires an entry target with collection and entryId.",
      422,
    );
  }
  const parsed = parseMikaInput(operation.schema as z.ZodType<unknown>, resolvedInput);
  if (!parsed.ok) return parsed.result;

  return {
    ok: true,
    status: 200,
    data: {
      actionId,
      ...(invocation.data.invocationId ? { invocationId: invocation.data.invocationId } : {}),
      operation,
      input: parsed.data,
      ...(invocation.data.target ? { target: invocation.data.target } : {}),
      resultAdapter: runtime.resultAdapter,
    },
  };
}

/** Returns the {@link MikaApiOperation} backing a registered admin action id. */
export function adminActionOperation(actionId: MikaAdminActionId): MikaApiOperation {
  return mikaOperationDefinitions[mikaAdminActionRuntimeDefinitions[actionId].operationKey];
}

/** Maps a {@link MikaApiResult} into the admin UI result envelope. */
export function toMikaAdminActionRunResult(
  result: MikaApiResult<unknown>,
  adapter: MikaAdminActionResultAdapter = adminActionDtoResultAdapter,
): MikaAdminActionRunResult {
  return adapter(result);
}

function adminActionDtoResultAdapter(result: MikaApiResult<unknown>): MikaAdminActionRunResult {
  if (!result.ok) return actionFailureResult(result);

  const data = asRecord(result.data) ?? {};
  const status = readAdminActionStatus(data["status"]);
  const actionResult: MikaAdminActionRunResult = {
    ok: status !== "failed" && status !== "unsupported",
    status: actionResultHttpStatus(status),
    severity: actionResultSeverity(status),
    message: stringValue(data["message"]),
    jobId: stringValue(data["id"]),
    jobStatus: actionResultJobStatus(status),
    affected: asRecord(data["affected"]),
    data: result.data,
  };

  const effects: MutableActionResultEffects = {};
  const redirectUrl = stringValue(data["redirectUrl"]);
  if (redirectUrl) {
    effects.open = { url: redirectUrl, target: "blank" };
  }
  if (status === "completed" || status === "queued" || status === "running") {
    effects.reload = true;
  }

  return Object.keys(effects).length > 0 ? { ...actionResult, effects } : actionResult;
}

function providerHealthResultAdapter(result: MikaApiResult<unknown>): MikaAdminActionRunResult {
  if (!result.ok) return actionFailureResult(result);

  const data = asRecord(result.data) ?? {};
  const provider = stringValue(data["provider"]) ?? "provider";
  const healthy = data["ok"] === true;

  return {
    ok: healthy,
    status: 200,
    severity: healthy ? "success" : "warning",
    message: healthy
      ? `Provider '${provider}' is healthy.`
      : `Provider '${provider}' reported health warnings.`,
    data: result.data,
  };
}

function readAdminActionStatus(value: unknown): AdminActionResultDTO["status"] {
  return value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "unsupported"
    ? value
    : "completed";
}

function parseActionInvocation(input: unknown): MikaApiResult<MikaActionInvocation> {
  const record = asRecord(input);
  const actionId = stringValue(record?.["actionId"]);
  if (!record || !actionId) {
    return runnerFailure("VALIDATION_FAILED", "Mika action invocation requires an actionId.", 400);
  }
  if (!isMikaAdminActionId(actionId)) {
    return runnerFailure("VALIDATION_FAILED", `Mika action '${actionId}' is not defined.`, 404);
  }

  const action = mikaAdminActionDefinitions[actionId];
  const target = readActionTarget(record["target"]);
  const payload = asRecord(record["payload"]);
  const context = asContext(record["context"]);
  const invocation: MikaActionInvocation = {
    actionId,
    ...(stringValue(record["invocationId"])
      ? { invocationId: stringValue(record["invocationId"]) }
      : {}),
    ...(payload ? { payload } : {}),
    ...(context ? { context } : {}),
    ...(target ? { target } : {}),
  };
  if (!targetMatchesRequirement(action.target, target)) {
    return runnerFailure(
      "VALIDATION_FAILED",
      `Mika action '${actionId}' cannot run for this target.`,
      422,
    );
  }
  if (!targetIdentityMatchesRequirement(invocation)) {
    return runnerFailure(
      "VALIDATION_FAILED",
      `Mika action '${actionId}' requires a target identifier.`,
      422,
    );
  }

  return {
    ok: true,
    status: 200,
    data: invocation,
  };
}

function actionPayload(invocation: MikaActionInvocation): Record<string, unknown> {
  return asRecord(invocation.payload) ?? {};
}

function invocationInputSources(invocation: MikaActionInvocation): readonly unknown[] {
  return actionInputSources(
    actionPayload(invocation),
    asContext(invocation.context),
    invocation.target,
  );
}

function actionInputSources(
  payload: Record<string, unknown>,
  context: MikaActionButtonContext | undefined,
  target: MikaActionTarget | undefined,
): readonly unknown[] {
  return [
    payload,
    context?.formData,
    context?.row,
    target?.type === "row" ? target.row : undefined,
    target?.type === "row" ? target.value : undefined,
    target?.type === "field" ? target.value : undefined,
    context?.rowValue,
    context?.fieldValue,
    context?.entryData,
    context,
  ];
}

function fillMissing(
  payload: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(defaults)) {
    if (input[key] === undefined && value !== undefined) input[key] = value;
  }
  return input;
}

function findId(
  keys: readonly string[],
  sources: readonly unknown[],
  invocation: MikaActionInvocation,
) {
  return findValue(keys, sources) ?? findPrimitiveId(actionIdentitySources(invocation));
}

function findValue(keys: readonly string[], sources: readonly unknown[]) {
  for (const source of sources) {
    const record = asRecord(source);
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function findPrimitiveId(sources: readonly unknown[]) {
  for (const source of sources) {
    const value = presentValue(source);
    if (value !== undefined) return value;
  }
  return undefined;
}

function actionIdentitySources(invocation: MikaActionInvocation): readonly unknown[] {
  const target = invocation.target;
  return [
    target?.type === "row" || target?.type === "field" ? target.value : undefined,
    invocation.context?.rowValue,
    invocation.context?.fieldValue,
  ];
}

function readTargetContentRef(
  context: MikaActionButtonContext | undefined,
  target: MikaActionTarget | undefined,
): ContentRefDTO | undefined {
  const collection =
    stringValue(target?.type !== "dashboard" ? target?.collection : undefined) ??
    stringValue(context?.collection);
  const id =
    stringValue(target?.type !== "dashboard" ? target?.entryId : undefined) ??
    stringValue(context?.entryId);
  if (!collection || !id) return undefined;

  const locale =
    stringValue(target?.type !== "dashboard" ? target?.locale : undefined) ??
    stringValue(context?.entryLocale);
  return {
    collection,
    id,
    ...(locale ? { locale } : {}),
  };
}

function readActionTarget(input: unknown): MikaActionTarget | undefined {
  const record = asRecord(input);
  const type = stringValue(record?.["type"]);
  if (!record || !type) return undefined;

  if (type === "dashboard") {
    return {
      type,
      ...(stringValue(record["surface"]) ? { surface: "dashboard" as const } : {}),
      ...(stringValue(record["kind"]) ? { kind: stringValue(record["kind"]) } : {}),
    };
  }
  if (type === "entry") {
    const collection = stringValue(record["collection"]);
    const entryId = stringValue(record["entryId"]);
    if (!collection || !entryId) return undefined;
    return {
      type,
      ...(stringValue(record["surface"]) ? { surface: "entry" as const } : {}),
      collection,
      entryId,
      ...(stringValue(record["locale"]) ? { locale: stringValue(record["locale"]) } : {}),
      ...(stringValue(record["kind"]) ? { kind: stringValue(record["kind"]) } : {}),
    };
  }
  if (type === "field") {
    return {
      type,
      ...(stringValue(record["surface"]) ? { surface: "field" as const } : {}),
      ...(stringValue(record["collection"])
        ? { collection: stringValue(record["collection"]) }
        : {}),
      ...(stringValue(record["entryId"]) ? { entryId: stringValue(record["entryId"]) } : {}),
      ...(stringValue(record["locale"]) ? { locale: stringValue(record["locale"]) } : {}),
      ...(stringValue(record["fieldName"]) ? { fieldName: stringValue(record["fieldName"]) } : {}),
      ...(stringValue(record["kind"]) ? { kind: stringValue(record["kind"]) } : {}),
      ...(Object.hasOwn(record, "value") ? { value: record["value"] } : {}),
    };
  }
  if (type === "row") {
    return {
      type,
      ...(stringValue(record["surface"]) ? { surface: "row" as const } : {}),
      ...(stringValue(record["collection"])
        ? { collection: stringValue(record["collection"]) }
        : {}),
      ...(stringValue(record["entryId"]) ? { entryId: stringValue(record["entryId"]) } : {}),
      ...(stringValue(record["locale"]) ? { locale: stringValue(record["locale"]) } : {}),
      ...(stringValue(record["fieldName"]) ? { fieldName: stringValue(record["fieldName"]) } : {}),
      ...(stringValue(record["kind"]) ? { kind: stringValue(record["kind"]) } : {}),
      ...(stringValue(record["rowId"]) ? { rowId: stringValue(record["rowId"]) } : {}),
      ...(stringValue(record["path"]) ? { path: stringValue(record["path"]) } : {}),
      ...(Object.hasOwn(record, "value") ? { value: record["value"] } : {}),
      ...(asRecord(record["row"]) ? { row: asRecord(record["row"]) } : {}),
    };
  }
  return undefined;
}

function targetMatchesRequirement(
  requirement:
    | MikaAdminActionTarget
    | readonly MikaAdminActionTarget[]
    | MikaAdminActionTargetMetadata
    | undefined,
  target: MikaActionTarget | undefined,
): boolean {
  if (!requirement) return true;
  if (isMikaAdminActionTargetMetadata(requirement)) {
    if (!target) return requirement.required !== true;
    if (requirement.surfaces && !requirement.surfaces.includes(target.type)) return false;
    return !requirement.kind || !target.kind || target.kind === requirement.kind;
  }
  if (!target) return true;
  return isMikaAdminActionTargetList(requirement)
    ? requirement.includes(target.type)
    : requirement === target.type;
}

function targetIdentityMatchesRequirement(invocation: MikaActionInvocation): boolean {
  if (!isMikaAdminActionId(invocation.actionId)) return true;
  const metadata = mikaAdminActionRuntimeDefinitions[invocation.actionId].targetIdentity;
  const keys = metadata?.idKeys;
  if (!keys || keys.length === 0) return true;
  const sources = actionInputSources(
    asRecord(invocation.payload) ?? {},
    invocation.context,
    invocation.target,
  );

  return (
    findValue(keys, sources) !== undefined ||
    (metadata?.idFrom === "value" &&
      findPrimitiveId(actionIdentitySources(invocation)) !== undefined)
  );
}

function isMikaAdminActionId(value: string): value is MikaAdminActionId {
  return Object.hasOwn(mikaAdminActionDefinitions, value);
}

function actionFailureResult(result: MikaApiFailure): MikaAdminActionRunResult {
  const status = result.status;
  return {
    ok: false,
    status,
    severity: status === 403 || status === 404 || status === 422 ? "warning" : "error",
    message: result.error.message,
  };
}

function actionResultHttpStatus(status: AdminActionResultDTO["status"]): number {
  switch (status) {
    case "queued":
    case "running":
      return 202;
    case "completed":
      return 200;
    case "unsupported":
      return 422;
    case "failed":
      return 500;
  }
}

function actionResultSeverity(status: AdminActionResultDTO["status"]) {
  switch (status) {
    case "completed":
      return "success" as const;
    case "queued":
    case "running":
      return "info" as const;
    case "unsupported":
      return "warning" as const;
    case "failed":
      return "error" as const;
  }
}

function actionResultJobStatus(status: AdminActionResultDTO["status"]): string | undefined {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "unsupported":
      return undefined;
  }
}

function runnerFailure(
  code: MikaError["code"],
  message: string,
  status: number,
): MikaApiResult<never> {
  return {
    ok: false,
    status,
    error: { code, message },
  };
}

function asContext(value: unknown): MikaActionButtonContext | undefined {
  return asRecord(value) as MikaActionButtonContext | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMikaAdminActionTargetMetadata(
  requirement:
    | MikaAdminActionTarget
    | readonly MikaAdminActionTarget[]
    | MikaAdminActionTargetMetadata,
): requirement is MikaAdminActionTargetMetadata {
  return typeof requirement === "object" && !Array.isArray(requirement);
}

function isMikaAdminActionTargetList(
  requirement:
    | MikaAdminActionTarget
    | readonly MikaAdminActionTarget[]
    | MikaAdminActionTargetMetadata,
): requirement is readonly MikaAdminActionTarget[] {
  return Array.isArray(requirement);
}

function presentValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
