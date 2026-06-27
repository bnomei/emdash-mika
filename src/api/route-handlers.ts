import { createMikaAdminActionsManifest } from "../admin";
import {
  resolveMikaAdminActionInvocation,
  toMikaAdminActionRunResult,
} from "./admin-action-runner";
import { MIKA_AGENT_IDEMPOTENCY_KEY_HEADER } from "./agent-types";
import { createMikaRequestContext, type MikaSessionAccess } from "./context";
import {
  parseMikaOperationInput,
  mikaRouteOperationsByPath,
  type MikaRouteOperation,
} from "./operations";
import { runMikaOperation } from "./operation-runner";
import type { MikaOperationPolicy } from "./operation-policy";
import { mikaPluginRoutes, type MikaPluginRouteName } from "./routes";
import { createMikaApi, type MikaApi } from "./server";

export interface MikaRouteContext<TInput = unknown> {
  readonly input: TInput;
  readonly request: Request;
  readonly sessionId?: string;
  readonly session?: MikaSessionAccess;
  readonly currentLocale?: string;
}

export interface MikaPluginRoute<TInput = unknown> {
  readonly public?: boolean;
  readonly handler: (ctx: MikaRouteContext<TInput>) => Promise<unknown>;
}

export interface MikaPluginRoutesOptions {
  readonly operationPolicy?: MikaOperationPolicy;
}

export type MikaPluginRoutePath = (typeof mikaPluginRoutes)[MikaPluginRouteName];
export type MikaPluginRoutes = Record<MikaPluginRoutePath, MikaPluginRoute>;

export function createMikaPluginRoutes(
  api: MikaApi = createMikaApi(),
  options: MikaPluginRoutesOptions = {},
): MikaPluginRoutes {
  const routes: Partial<MikaPluginRoutes> = {
    [mikaPluginRoutes.actionsManifest]: {
      public: false,
      handler: async () => createMikaAdminActionsManifest(),
    },
    [mikaPluginRoutes.actionsRunner]: {
      public: false,
      handler: async (ctx: MikaRouteContext) => handleActionRunner(api, ctx, options),
    },
  };

  for (const [path, operations] of mikaRouteOperationsByPath) {
    const routePath = path as MikaPluginRoutePath;
    routes[routePath] = {
      public: operations.some((operation) => operation.public),
      handler: async (ctx: MikaRouteContext) => handleRouteOperation(api, ctx, operations, options),
    };
  }

  return routes as MikaPluginRoutes;
}

async function handleActionRunner(
  api: MikaApi,
  ctx: MikaRouteContext,
  options: MikaPluginRoutesOptions,
): Promise<unknown> {
  if (ctx.request.method.toUpperCase() !== "POST") {
    return {
      ok: false,
      status: 405,
      severity: "error",
      message: `Mika action runner does not support ${ctx.request.method.toUpperCase()}.`,
    };
  }

  const resolved = resolveMikaAdminActionInvocation(ctx.input);
  if (!resolved.ok) return toMikaAdminActionRunResult(resolved);

  const mikaContext = requestContext(ctx, resolved.data.invocationId);
  if (resolved.data.operation.agent.idempotency === "required" && !mikaContext.idempotencyKey) {
    return toMikaAdminActionRunResult({
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Mika operation '${resolved.data.operation.name}' requires an idempotency key.`,
      },
    });
  }
  const result = await runMikaOperation({
    operation: resolved.data.operation,
    api,
    ctx: mikaContext,
    input: adminRunnerInputWithContext(
      resolved.data.operation,
      resolved.data.input,
      mikaContext.idempotencyKey,
    ),
    operationPolicy: options.operationPolicy,
  });

  return toMikaAdminActionRunResult(result, resolved.data.resultAdapter);
}

// Admin operations whose input schema declares an `idempotencyKey` and whose
// backend threads it into the admin-action audit for retry-safe deduplication.
// Keep in sync with the schemas in validation.ts that expose `idempotencyKey`.
const ADMIN_IDEMPOTENT_OPERATIONS: ReadonlySet<string> = new Set([
  "admin.stockAdjust",
  "admin.orderRefund",
  "admin.orderCancel",
  "admin.entitlementGrant",
  "admin.entitlementRevoke",
  "admin.emailResend",
  "admin.licenseRevoke",
  "admin.downloadIssue",
]);

function adminRunnerInputWithContext(
  operation: MikaRouteOperation,
  input: unknown,
  idempotencyKey: string | undefined,
): unknown {
  // Forward the runner-enforced idempotency key to every mutating admin
  // operation that consumes it (not just stock adjust). The backend uses it to
  // dedupe retries, replaying the original result instead of repeating the side
  // effect (e.g. a double refund).
  if (
    !idempotencyKey ||
    !ADMIN_IDEMPOTENT_OPERATIONS.has(operation.name) ||
    !isRecord(input) ||
    "idempotencyKey" in input
  ) {
    return input;
  }

  return {
    ...input,
    idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function handleRouteOperation(
  api: MikaApi,
  ctx: MikaRouteContext,
  operations: readonly MikaRouteOperation[],
  options: MikaPluginRoutesOptions,
): Promise<unknown> {
  const operation = selectRouteOperation(ctx.request, operations);
  if (!operation) return methodNotAllowed(ctx.request, operations);

  const parsedInput = parseMikaOperationInput(operation, ctx.input, ctx.request.url);
  if (!parsedInput.ok) return parsedInput.result;

  const mikaContext = requestContext(ctx);
  return runMikaOperation({
    operation,
    api,
    ctx: mikaContext,
    input: parsedInput.data,
    operationPolicy: options.operationPolicy,
  });
}

function selectRouteOperation(
  request: Request,
  operations: readonly MikaRouteOperation[],
): MikaRouteOperation | undefined {
  const method = request.method.toUpperCase();
  return operations.find((candidate) => candidate.httpMethod === method);
}

function methodNotAllowed(request: Request, operations: readonly MikaRouteOperation[]) {
  const allowed = [...new Set(operations.map((operation) => operation.httpMethod))].sort();

  return {
    ok: false,
    status: 405,
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: `Mika route does not support ${request.method.toUpperCase()}.`,
      fieldErrors: {
        method: `Expected ${allowed.join(", ")}.`,
      },
    },
  } as const;
}

function requestContext(ctx: MikaRouteContext, idempotencyKey?: string) {
  return createMikaRequestContext({
    request: ctx.request,
    url: ctx.request.url,
    idempotencyKey: requestIdempotencyKey(ctx.request) ?? idempotencyKey,
    sessionId: ctx.sessionId,
    session: ctx.session,
    locale: ctx.currentLocale,
  });
}

function requestIdempotencyKey(request: Request): string | undefined {
  const value = request.headers.get(MIKA_AGENT_IDEMPOTENCY_KEY_HEADER)?.trim();
  return value && value.length > 0 ? value : undefined;
}
