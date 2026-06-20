import {
  mikaAdminActionDefinitions,
  type MikaAdminActionId,
  type MikaAdminActionTarget,
  type MikaAdminActionTargetMetadata,
} from "../admin";
import { parseMikaInput, type z } from "./validation";
import { mikaOperationDefinitions, type MikaApiOperation } from "./operations";
import type { AdminActionResultDTO, ContentRefDTO, MikaApiResult, MikaError } from "./types";

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

export interface MikaActionInvocation {
  readonly actionId: string;
  readonly invocationId?: string;
  readonly payload?: Record<string, unknown>;
  readonly context?: MikaActionButtonContext;
  readonly target?: MikaActionTarget;
}

export interface MikaResolvedAdminActionInvocation {
  readonly actionId: MikaAdminActionId;
  readonly invocationId?: string;
  readonly operation: MikaApiOperation;
  readonly input: unknown;
  readonly target?: MikaActionTarget;
}

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

type MutableActionResultEffects = {
  reload?: boolean | { readonly delayMs?: number };
  open?: string | { readonly url: string; readonly target?: "self" | "blank" };
};

type MikaAdminActionOperationKey =
  | "adminProviderHealth"
  | "adminProviderSync"
  | "adminStockAdjust"
  | "adminStockReleaseExpiredReservations"
  | "adminWebhookReplay"
  | "adminOrderRefund"
  | "adminOrderCancel"
  | "adminEntitlementGrant"
  | "adminEntitlementRevoke"
  | "adminEmailResend"
  | "adminLicenseRevoke"
  | "adminDownloadIssue";

const adminActionOperationKeys = {
  "mika.provider.health": "adminProviderHealth",
  "mika.provider.sync": "adminProviderSync",
  "mika.stock.releaseExpiredReservations": "adminStockReleaseExpiredReservations",
  "mika.catalog.syncEntry": "adminProviderSync",
  "mika.stock.adjust": "adminStockAdjust",
  "mika.webhook.replay": "adminWebhookReplay",
  "mika.order.refund": "adminOrderRefund",
  "mika.order.cancel": "adminOrderCancel",
  "mika.entitlement.grant": "adminEntitlementGrant",
  "mika.entitlement.revoke": "adminEntitlementRevoke",
  "mika.email.resend": "adminEmailResend",
  "mika.license.revoke": "adminLicenseRevoke",
  "mika.download.issue": "adminDownloadIssue",
} as const satisfies Record<MikaAdminActionId, MikaAdminActionOperationKey>;

const adminActionIdentityKeys: Partial<Record<MikaAdminActionId, readonly string[]>> = {
  "mika.stock.adjust": ["stockItemId"],
  "mika.webhook.replay": ["webhookId"],
  "mika.order.refund": ["orderId"],
  "mika.order.cancel": ["orderId"],
  "mika.entitlement.revoke": ["entitlementId", "entitlementKey"],
  "mika.email.resend": ["emailId"],
  "mika.license.revoke": ["licenseId"],
  "mika.download.issue": ["orderId", "entitlementId", "orderLineId"],
} as const;

const adminActionsAcceptingPrimitiveIdentity = new Set<MikaAdminActionId>([
  "mika.stock.adjust",
  "mika.webhook.replay",
  "mika.order.refund",
  "mika.order.cancel",
  "mika.entitlement.revoke",
  "mika.email.resend",
  "mika.license.revoke",
]);

export function resolveMikaAdminActionInvocation(
  input: unknown,
): MikaApiResult<MikaResolvedAdminActionInvocation> {
  const invocation = parseActionInvocation(input);
  if (!invocation.ok) return invocation;

  const actionId = invocation.data.actionId as MikaAdminActionId;
  const operation = mikaOperationDefinitions[adminActionOperationKeys[actionId]];
  const resolvedInput = actionInputForInvocation(invocation.data);
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
    },
  };
}

export function toMikaAdminActionRunResult(
  result: MikaApiResult<unknown>,
): MikaAdminActionRunResult {
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

function actionInputForInvocation(invocation: MikaActionInvocation): Record<string, unknown> {
  const payload = asRecord(invocation.payload) ?? {};
  const context = asContext(invocation.context);
  const target = invocation.target;
  const sources = actionInputSources(payload, context, target);

  switch (invocation.actionId) {
    case "mika.provider.health":
      return fillMissing(payload, { provider: findValue(["provider"], sources) });
    case "mika.provider.sync":
      return fillMissing(payload, {
        provider: findValue(["provider"], sources),
        mode: findValue(["mode"], sources),
      });
    case "mika.catalog.syncEntry":
      return fillMissing(payload, {
        provider: findValue(["provider"], sources),
        mode: findValue(["mode"], sources),
        scope: findValue(["scope"], sources) ?? "entry",
        contentRef: readTargetContentRef(context, target),
      });
    case "mika.stock.releaseExpiredReservations":
      return fillMissing(payload, { now: findValue(["now"], sources) });
    case "mika.stock.adjust":
      return fillMissing(payload, {
        stockItemId: findId(["stockItemId"], sources, invocation),
        quantityDelta: findValue(["quantityDelta"], sources),
        reason: findValue(["reason"], sources),
      });
    case "mika.webhook.replay":
      return fillMissing(payload, {
        webhookId: findId(["webhookId"], sources, invocation),
      });
    case "mika.order.refund":
      return fillMissing(payload, {
        orderId: findId(["orderId"], sources, invocation),
        amount: findValue(["amount"], sources),
        reason: findValue(["reason"], sources),
      });
    case "mika.order.cancel":
      return fillMissing(payload, {
        orderId: findId(["orderId"], sources, invocation),
        reason: findValue(["reason"], sources),
      });
    case "mika.entitlement.grant":
      return fillMissing(payload, {
        entitlementKey: findValue(["entitlementKey"], sources),
        customerId: findValue(["customerId"], sources),
        userId: findValue(["userId"], sources),
        email: findValue(["email"], sources),
        expiresAt: findValue(["expiresAt"], sources),
      });
    case "mika.entitlement.revoke":
      return fillMissing(payload, {
        entitlementId: findId(["entitlementId"], sources, invocation),
        entitlementKey: findValue(["entitlementKey"], sources),
        customerId: findValue(["customerId"], sources),
        reason: findValue(["reason"], sources),
      });
    case "mika.email.resend":
      return fillMissing(payload, {
        emailId: findId(["emailId"], sources, invocation),
      });
    case "mika.license.revoke":
      return fillMissing(payload, {
        licenseId: findId(["licenseId"], sources, invocation),
        reason: findValue(["reason"], sources),
      });
    case "mika.download.issue":
      return fillMissing(payload, {
        entitlementId: findValue(["entitlementId"], sources),
        orderId: findValue(["orderId"], sources),
        orderLineId: findValue(["orderLineId"], sources),
        expiresAt: findValue(["expiresAt"], sources),
      });
  }

  return payload;
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
    return !requirement.kind || target.kind === requirement.kind;
  }
  if (!target) return true;
  return isMikaAdminActionTargetList(requirement)
    ? requirement.includes(target.type)
    : requirement === target.type;
}

function targetIdentityMatchesRequirement(invocation: MikaActionInvocation): boolean {
  if (!isMikaAdminActionId(invocation.actionId)) return true;
  const keys = adminActionIdentityKeys[invocation.actionId];
  if (!keys) return true;
  const sources = actionInputSources(
    asRecord(invocation.payload) ?? {},
    invocation.context,
    invocation.target,
  );

  return (
    findValue(keys, sources) !== undefined ||
    (adminActionsAcceptingPrimitiveIdentity.has(invocation.actionId) &&
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
