import { createMikaAdminActionsManifest } from "../admin";
import { MIKA_AGENT_IDEMPOTENCY_KEY_HEADER } from "./agent-types";
import { createMikaRequestContext, type MikaSessionAccess } from "./context";
import {
  callMikaOperation,
  parseMikaOperationInput,
  mikaRoutedOperationDefinitions,
  type MikaRouteOperation,
} from "./operations";
import { runMikaOperationPolicy, type MikaOperationPolicy } from "./operation-policy";
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
  };

  for (const [path, operations] of routeOperationsByPath()) {
    routes[path] = {
      public: operations.some((operation) => operation.public),
      handler: async (ctx) => handleRouteOperation(api, ctx, operations, options),
    };
  }

  return routes as MikaPluginRoutes;
}

function routeOperationsByPath(): Map<MikaPluginRoutePath, readonly MikaRouteOperation[]> {
  const operationsByPath = new Map<MikaPluginRoutePath, MikaRouteOperation[]>();

  for (const operation of mikaRoutedOperationDefinitions) {
    const path = operation.routePath as MikaPluginRoutePath;
    const operations = operationsByPath.get(path) ?? [];
    operations.push(operation);
    operationsByPath.set(path, operations);
  }

  return operationsByPath;
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
  const policyRejection = await runMikaOperationPolicy(options.operationPolicy, {
    operation,
    ctx: mikaContext,
    input: parsedInput.data,
  });
  if (policyRejection) return policyRejection;

  return callMikaOperation(operation, api, mikaContext, parsedInput.data);
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

function requestContext(ctx: MikaRouteContext) {
  return createMikaRequestContext({
    request: ctx.request,
    url: ctx.request.url,
    idempotencyKey: requestIdempotencyKey(ctx.request),
    sessionId: ctx.sessionId,
    session: ctx.session,
    locale: ctx.currentLocale,
  });
}

function requestIdempotencyKey(request: Request): string | undefined {
  const value = request.headers.get(MIKA_AGENT_IDEMPOTENCY_KEY_HEADER)?.trim();
  return value && value.length > 0 ? value : undefined;
}
