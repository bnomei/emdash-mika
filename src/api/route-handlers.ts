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
import { mikaOperationInputWithIdempotencyContext } from "./operation-idempotency";
import {
  parseMikaOperationInput,
  mikaRouteOperationsByPath,
  type MikaRouteOperation,
} from "./operations";
import { runMikaOperation } from "./operation-runner";
import type { MikaOperationPolicy } from "./operation-policy";
import type { MikaApiResult } from "./types";
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
  /**
   * Observer for unexpected throws converted into the generic INTERNAL envelope at the route
   * boundary — a host MikaApi override or MikaOperationPolicy hook that throws, or malformed
   * input breaking pre-dispatch parsing. Defaults to console.error so the original error, stack,
   * and cause are never silently dropped.
   */
  readonly onError?: (input: { readonly scope: string; readonly error: unknown }) => void;
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

  let resultAdapter: Parameters<typeof toMikaAdminActionRunResult>[1];
  try {
    const resolved = resolveMikaAdminActionInvocation(ctx.input);
    if (!resolved.ok) return toMikaAdminActionRunResult(resolved);
    resultAdapter = resolved.data.resultAdapter;

    const mikaContext = requestContext(ctx, resolved.data.invocationId);
    if (resolved.data.operation.agent.idempotency === "required" && !mikaContext.idempotencyKey) {
      return toMikaAdminActionRunResult(idempotencyKeyRequired(resolved.data.operation.name));
    }
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
    });

    return toMikaAdminActionRunResult(result, resultAdapter);
  } catch (error) {
    observeRouteError(options, "actionsRunner", error);
    return toMikaAdminActionRunResult(mikaInternalFailure(), resultAdapter);
  }
}

/**
 * Generic 500 envelope for unexpected throws at the plugin route boundary. Built-in operation
 * handlers already return structured {@link MikaApiResult} failures for every case they
 * anticipate (including webhook receive, whose retryable-vs-terminal status codes are decided
 * inside the handler); the route-level catches that return this guard genuinely unexpected
 * throws — a host `MikaApi` override or {@link MikaOperationPolicy} hook that throws, or
 * pre-dispatch input parsing and request-context construction breaking on malformed requests.
 */
function mikaInternalFailure(): MikaApiResult<never> {
  return {
    ok: false,
    status: 500,
    error: {
      code: "INTERNAL",
      message: "Mika operation failed.",
    },
  };
}

/** 409 envelope for idempotency-required operations invoked without an idempotency key. */
function idempotencyKeyRequired(operationName: string): MikaApiResult<never> {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CONFLICT",
      message: `Mika operation '${operationName}' requires an idempotency key.`,
    },
  };
}

/** Reports a route-boundary failure to the host observer; observer bugs never break the envelope. */
function observeRouteError(options: MikaPluginRoutesOptions, scope: string, error: unknown): void {
  try {
    if (options.onError) {
      options.onError({ scope, error });
      return;
    }
    console.error(`Mika route handler failed (${scope}).`, error);
  } catch {
    // Observer bugs must not break the never-throw route boundary.
  }
}

async function handleRouteOperation(
  api: MikaApi,
  ctx: MikaRouteContext,
  operations: readonly MikaRouteOperation[],
  options: MikaPluginRoutesOptions,
): Promise<unknown> {
  const operation = selectRouteOperation(ctx.request, operations);
  if (!operation) return methodNotAllowed(ctx.request, operations);

  try {
    const parsedInput = parseMikaOperationInput(operation, ctx.input, ctx.request.url);
    if (!parsedInput.ok) return parsedInput.result;

    const mikaContext = requestContext(ctx);
    if (
      operation.name.startsWith("admin.") &&
      operation.agent.idempotency === "required" &&
      !mikaContext.idempotencyKey
    ) {
      return idempotencyKeyRequired(operation.name);
    }

    return await runMikaOperation({
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
  } catch (error) {
    observeRouteError(options, `operation:${operation.name}`, error);
    return mikaInternalFailure();
  }
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
