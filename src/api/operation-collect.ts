/**
 * Derived operation registries: routes, method names, actions, descriptors, and dispatch.
 * Asserts plugin route IR consistency at module load.
 */
import type { MikaRequestContext } from "./context";
import type { MikaApi } from "./server";
import type { MikaApiResult } from "./types";
import type { MikaAgentOperationMetadata } from "./agent-types";
import {
  mikaPluginRoutePaths,
  publicMikaPluginRouteNames as purePublicMikaPluginRouteNames,
  type MikaPluginRouteName,
} from "./route-paths";
import type {
  MikaApiOperationCall,
  MikaApiOperationData,
  MikaOperationActionDefinition,
  MikaOperationDescriptor,
} from "./operation-define";
import {
  mikaOperationDefinitions,
  mikaRouteOnlyDefinitions,
  type MikaApiOperation,
  type MikaRouteOnlyDefinition,
} from "./operation-definitions";

/** All operations exposed as HTTP plugin routes. */
export const mikaRoutedOperationDefinitions = Object.values(
  mikaOperationDefinitions,
) as readonly MikaApiOperation[];

/** Operations grouped by plugin route path for method-based dispatch. */
export const mikaRouteOperationsByPath = collectMikaRouteOperationsByPath();

type MikaOperationPluginRoutes = {
  readonly [TOperation in MikaApiOperation as TOperation["routeKey"]]: TOperation["routePath"];
} & {
  readonly [TRoute in MikaRouteOnlyDefinition as TRoute["routeKey"]]: TRoute["routePath"];
};

/**
 * Route key to path segment map. Pure SSOT lives in {@link ./route-paths}; this re-export
 * keeps server-side callers stable while asserting IR alignment at module load.
 */
export const mikaOperationPluginRoutes = mikaPluginRoutePaths as typeof mikaPluginRoutePaths &
  MikaOperationPluginRoutes;

/** Route key union for operations marked `public: true`. */
export type MikaOperationPublicRouteName = Extract<
  MikaApiOperation,
  { readonly public: true }
>["routeKey"];

/** Route keys marked `public: true` (no session required). */
export const mikaOperationPublicRouteNames =
  purePublicMikaPluginRouteNames as readonly MikaOperationPublicRouteName[];

assertMikaPluginRoutesConsistent();

/** Type mapping namespaces to registered API method name lists. */
type MikaApiExposedOperation = Exclude<MikaApiOperation, { readonly apiMethod: false }>;
export type MikaOperationApiMethodNames = {
  readonly [TNamespace in MikaApiExposedOperation["namespace"]]: readonly Extract<
    MikaApiExposedOperation,
    { readonly namespace: TNamespace }
  >["method"][];
};

/** Namespace to method name list mirroring {@link MikaApi} shape. */
export const mikaOperationApiMethodNames =
  collectMikaApiMethodNames() as MikaOperationApiMethodNames;

type MikaActionOperation = Extract<
  MikaApiOperation,
  { readonly action: MikaOperationActionDefinition }
>;

/** Map of HTML action keys to action metadata with linked operations. */
export type MikaActionDefinitions = {
  readonly [TOperation in MikaActionOperation as TOperation["action"]["key"]]: TOperation["action"] & {
    readonly operation: TOperation;
  };
};

/** Display name union of all registered HTML actions. */
export type MikaActionName = MikaActionDefinitions[keyof MikaActionDefinitions]["name"];
/** Single HTML action entry with schema and linked operation. */
export type MikaActionDefinition = MikaActionDefinitions[keyof MikaActionDefinitions];

/** HTML form actions keyed by stable action id with linked operations. */
export const mikaActionDefinitions = collectMikaActionDefinitions() as MikaActionDefinitions;

/** Frozen descriptor map keyed by internal operation definition keys. */
export const mikaOperationDescriptors = Object.freeze(
  Object.fromEntries(
    Object.entries(mikaOperationDefinitions).map(([key, operation]) => [
      key,
      mikaOperationDescriptor(operation),
    ]),
  ),
) as {
  readonly [TOperation in keyof typeof mikaOperationDefinitions]: MikaOperationDescriptor;
};

/** Projects a live operation definition into a manifest-safe descriptor. */
export function mikaOperationDescriptor(operation: MikaApiOperation): MikaOperationDescriptor {
  const descriptor: MikaOperationDescriptor = {
    name: operation.name,
    namespace: operation.namespace,
    method: operation.method,
    public: operation.public,
    requiresRequestContext: operation.requiresRequestContext,
    agent: cloneMikaAgentOperationMetadata(operation.agent),
    ...("action" in operation
      ? {
          action: Object.freeze({
            key: operation.action.key,
            name: operation.action.name,
            accept: operation.action.accept,
          }),
        }
      : {}),
    route: Object.freeze({
      key: operation.routeKey,
      path: operation.routePath,
      httpMethod: operation.httpMethod,
      transport: operation.transport,
      ...("searchKeys" in operation
        ? { searchKeys: Object.freeze([...operation.searchKeys]) }
        : {}),
    }),
  };

  return Object.freeze(descriptor);
}

function cloneMikaAgentOperationMetadata(
  agent: MikaAgentOperationMetadata,
): MikaAgentOperationMetadata {
  return Object.freeze({
    ...agent,
    scopes: Object.freeze([...agent.scopes]),
    ...(agent.idempotencyKey ? { idempotencyKey: Object.freeze({ ...agent.idempotencyKey }) } : {}),
    resources: Object.freeze([...agent.resources]),
    ...(agent.acceptsProofs ? { acceptsProofs: Object.freeze([...agent.acceptsProofs]) } : {}),
    requiredProofs: Object.freeze([...agent.requiredProofs]),
  });
}

/** Dispatches validated input to the operation's bound {@link MikaApi} handler. */
export function callMikaOperation<TOperation extends MikaApiOperation>(
  operation: TOperation,
  api: MikaApi,
  ctx: MikaRequestContext,
  input: unknown,
): Promise<MikaApiResult<MikaApiOperationData<TOperation>>>;
export function callMikaOperation<TData>(
  operation: MikaApiOperation,
  api: MikaApi,
  ctx: MikaRequestContext,
  input: unknown,
): Promise<MikaApiResult<TData>>;
export function callMikaOperation(
  operation: MikaApiOperation,
  api: MikaApi,
  ctx: MikaRequestContext,
  input: unknown,
): Promise<MikaApiResult<unknown>> {
  // Dynamic route/action dispatch loses the schema-to-operation correlation after validation.
  const call = operation.call as MikaApiOperationCall<unknown, unknown>;
  return call(api, ctx, input);
}

/**
 * Ensures operation IR route keys/paths and public flags match the pure {@link mikaPluginRoutePaths}
 * map (browser-safe SSOT). Throws at module load on drift or duplicate path:method pairs.
 */
function assertMikaPluginRoutesConsistent(): void {
  const routeMethods = new Set<string>();
  const coveredKeys = new Set<string>();

  for (const route of Object.values(mikaRouteOnlyDefinitions)) {
    assertRoutePathMatchesMap(route.routeKey, route.routePath);
    coveredKeys.add(route.routeKey);
  }

  for (const operation of mikaRoutedOperationDefinitions) {
    assertRoutePathMatchesMap(operation.routeKey, operation.routePath);
    coveredKeys.add(operation.routeKey);

    const routeMethod = `${operation.routePath}:${operation.httpMethod}`;
    if (routeMethods.has(routeMethod)) {
      throw new Error(
        `Mika route '${operation.routePath}' defines duplicate ${operation.httpMethod} operations.`,
      );
    }
    routeMethods.add(routeMethod);
  }

  for (const routeKey of Object.keys(mikaPluginRoutePaths) as MikaPluginRouteName[]) {
    if (!coveredKeys.has(routeKey)) {
      throw new Error(
        `Mika route path map key '${routeKey}' is missing from operation/route-only definitions.`,
      );
    }
  }

  const derivedPublic = [
    ...new Set(
      mikaRoutedOperationDefinitions
        .filter((operation) => operation.public)
        .map((operation) => operation.routeKey),
    ),
  ].sort();
  const expectedPublic = [...purePublicMikaPluginRouteNames].sort();
  if (
    derivedPublic.length !== expectedPublic.length ||
    derivedPublic.some((key, index) => key !== expectedPublic[index])
  ) {
    throw new Error(
      `Mika public route names drifted (IR: ${derivedPublic.join(", ") || "(none)"}; map: ${expectedPublic.join(", ")}).`,
    );
  }
}

function assertRoutePathMatchesMap(routeKey: string, routePath: string): void {
  if (!(routeKey in mikaPluginRoutePaths)) {
    throw new Error(
      `Mika route key '${routeKey}' is missing from the pure route path map (route-paths.ts).`,
    );
  }
  const expectedPath = mikaPluginRoutePaths[routeKey as MikaPluginRouteName];
  if (expectedPath !== routePath) {
    throw new Error(
      `Mika route key '${routeKey}' maps to '${routePath}' in IR but '${expectedPath}' in route-paths.ts.`,
    );
  }
}

function collectMikaRouteOperationsByPath(): ReadonlyMap<string, readonly MikaApiOperation[]> {
  const operationsByPath = new Map<string, MikaApiOperation[]>();

  for (const operation of mikaRoutedOperationDefinitions) {
    const operations = operationsByPath.get(operation.routePath) ?? [];
    operations.push(operation);
    operationsByPath.set(operation.routePath, operations);
  }

  return operationsByPath;
}

function collectMikaApiMethodNames(): Record<string, readonly string[]> {
  const methodNames: Record<string, string[]> = {};

  for (const operation of Object.values(mikaOperationDefinitions)) {
    if ("apiMethod" in operation && operation.apiMethod === false) continue;
    methodNames[operation.namespace] ??= [];
    if (!methodNames[operation.namespace]?.includes(operation.method)) {
      methodNames[operation.namespace]?.push(operation.method);
    }
  }

  return methodNames;
}

function collectMikaActionDefinitions(): Record<
  string,
  MikaOperationActionDefinition & { readonly operation: MikaApiOperation }
> {
  const actions: Record<
    string,
    MikaOperationActionDefinition & { readonly operation: MikaApiOperation }
  > = {};

  for (const operation of Object.values(mikaOperationDefinitions)) {
    if (!("action" in operation)) continue;
    const { action } = operation;
    if (actions[action.key]) {
      throw new Error(`Mika action key '${action.key}' is defined more than once.`);
    }
    actions[action.key] = {
      ...action,
      operation,
    };
  }

  return actions;
}
