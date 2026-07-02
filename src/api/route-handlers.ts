/**
 * EmDash plugin route table: wires HTTP paths to operations, admin actions, and manifests.
 * Builds {@link MikaRequestContext} from incoming requests before dispatch.
 */
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

/** Host framework context passed into each plugin route handler. */
export interface MikaRouteContext<TInput = unknown> {
  readonly input: TInput;
  readonly request: Request;
  readonly sessionId?: string;
  readonly session?: MikaSessionAccess;
  readonly currentLocale?: string;
}

/** Single plugin route entry with optional public access and async handler. */
export interface MikaPluginRoute<TInput = unknown> {
  readonly public?: boolean;
  readonly handler: (ctx: MikaRouteContext<TInput>) => Promise<unknown>;
}

/** Options applied when constructing the plugin route table. */
export interface MikaPluginRoutesOptions {
  readonly operationPolicy?: MikaOperationPolicy;
}

/** Concrete plugin route path resolved from {@link MikaPluginRouteName}. */
export type MikaPluginRoutePath = (typeof mikaPluginRoutes)[MikaPluginRouteName];

/** Complete path-to-handler map for the Mika EmDash plugin. */
export type MikaPluginRoutes = Record<MikaPluginRoutePath, MikaPluginRoute>;

/** Registers operation routes, admin action runner, and actions manifest handlers. */
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
  // Unhandled runner exceptions return a generic 500 envelope instead of leaking internals.
  const result = await runMikaOperation({
    operation: resolved.data.operation,
    api,
    ctx: mikaContext,
    input: mikaOperationInputWithIdempotencyContext(
      resolved.data.operation,
      resolved.data.input,
      mikaContext.idempotencyKey,
    ),
    operationPolicy: options.operationPolicy,
  }).catch(() => ({
    ok: false as const,
    status: 500,
    error: {
      code: "INTERNAL" as const,
      message: "Mika operation failed.",
    },
  }));

  return toMikaAdminActionRunResult(result, resolved.data.resultAdapter);
}

/**
 * Injects `idempotencyKey` from {@link MikaRequestContext} when the operation requires agent
 * idempotency, the input schema accepts the field, and the caller did not supply a non-empty key.
 */
export function mikaOperationInputWithIdempotencyContext(
  operation: MikaRouteOperation,
  input: unknown,
  idempotencyKey: string | undefined,
): unknown {
  if (
    !idempotencyKey ||
    operation.agent.idempotency !== "required" ||
    !operation.agent.idempotencyKey ||
    !operationSchemaHasIdempotencyKey(operation) ||
    !isRecord(input) ||
    hasNonEmptyIdempotencyKey(input)
  ) {
    return input;
  }

  return {
    ...input,
    idempotencyKey,
  };
}

// Caller-supplied idempotency keys take precedence over the request-context header value.
function hasNonEmptyIdempotencyKey(input: Record<string, unknown>): boolean {
  const value = input["idempotencyKey"];

  return typeof value === "string" && value.trim().length > 0;
}

// Only merge context keys into operations whose Zod schema exposes `idempotencyKey`.
function operationSchemaHasIdempotencyKey(operation: MikaRouteOperation): boolean {
  const schema = "schema" in operation ? operation.schema : undefined;
  const shape = schema ? zodObjectShape(schema) : undefined;

  return shape ? Object.prototype.hasOwnProperty.call(shape, "idempotencyKey") : false;
}

function zodObjectShape(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  const directShape = schema["shape"];
  const definition = schema["_def"];
  const defShape = isRecord(definition) ? definition["shape"] : undefined;
  const shape = typeof directShape === "function" ? directShape() : (directShape ?? defShape);
  const resolved = typeof shape === "function" ? shape() : shape;

  return isRecord(resolved) ? resolved : undefined;
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
  if (
    operation.name.startsWith("admin.") &&
    operation.agent.idempotency === "required" &&
    !mikaContext.idempotencyKey
  ) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CONFLICT",
        message: `Mika operation '${operation.name}' requires an idempotency key.`,
      },
    } as const;
  }

  return runMikaOperation({
    operation,
    api,
    ctx: mikaContext,
    input: mikaOperationInputWithIdempotencyContext(
      operation,
      parsedInput.data,
      mikaContext.idempotencyKey,
    ),
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
