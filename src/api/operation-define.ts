/**
 * Operation definition helpers: `defineMikaOperation`, action factories, and related types.
 */
import type { MikaRequestContext } from "./context";
import type { MikaApi } from "./server";
import type { MikaApiResult } from "./types";
import type {
  MikaAgentActionAccept,
  MikaAgentActionDescriptor,
  MikaAgentOperationHttpMethod,
  MikaAgentOperationMetadata,
  MikaAgentOperationTransport,
} from "./agent-types";
import type { z } from "./validation";

/** HTTP verbs used by plugin route operations. Single-sourced from the agent manifest vocabulary. */
export type MikaOperationHttpMethod = MikaAgentOperationHttpMethod;
/** Where validated input is read on the HTTP request. */
export type MikaOperationTransport = MikaAgentOperationTransport;
/** Accepted encoding for HTML action endpoints. */
export type MikaActionAccept = MikaAgentActionAccept;

/**
 * Serializable view of an operation for manifests, routing, and policy. Same shape as
 * {@link MikaAgentActionDescriptor} but with a guaranteed (non-optional) route — every routed
 * operation has one.
 */
export interface MikaOperationDescriptor extends MikaAgentActionDescriptor {
  readonly route: NonNullable<MikaAgentActionDescriptor["route"]>;
}

export type MikaApiOperationCall<TInput, TData> = {
  call(api: MikaApi, ctx: MikaRequestContext, input: TInput): Promise<MikaApiResult<TData>>;
}["call"];
type MikaApiMethodData<
  TNamespace extends string,
  TMethod extends string,
> = TNamespace extends keyof MikaApi
  ? TMethod extends keyof MikaApi[TNamespace]
    ? MikaApi[TNamespace][TMethod] extends (
        ...args: readonly any[]
      ) => Promise<MikaApiResult<infer TData>>
      ? TData
      : unknown
    : unknown
  : unknown;

export type MikaOperationActionNormalizer = (input: any) => unknown;

export interface MikaOperationActionDefinition<TActionInput = unknown> {
  readonly key: string;
  readonly name: string;
  readonly accept: MikaActionAccept;
  readonly schema: z.ZodType<TActionInput>;
  readonly normalize?: MikaOperationActionNormalizer;
}

export type MikaOperationActionInputDefinition<
  TActionSchema extends z.ZodType | undefined = z.ZodType,
> = {
  readonly accept: MikaActionAccept;
  readonly schema?: TActionSchema;
  readonly normalize?: MikaOperationActionNormalizer;
};

export interface MikaApiOperationBaseDefinition {
  readonly name: string;
  readonly namespace: string;
  readonly method: string;
  readonly routeKey: string;
  readonly routePath: string;
  readonly httpMethod: MikaOperationHttpMethod;
  readonly transport: MikaOperationTransport;
  readonly public: boolean;
  readonly requiresRequestContext: boolean;
  readonly agent: MikaAgentOperationMetadata;
  readonly apiMethod?: false;
  readonly searchKeys?: readonly string[];
}

// The operation name is always derived from `${namespace}.${method}`; it is never supplied on input.
type MikaApiOperationBaseInputDefinition = Omit<MikaApiOperationBaseDefinition, "name">;

export type MikaApiOperationDefinition = MikaApiOperationBaseDefinition & {
  readonly schema?: z.ZodType;
  /**
   * Whether {@link schema} declares an `idempotencyKey` field, computed once at definition time
   * from Zod's public `shape` accessor (never `_def` internals, which are not stable across Zod
   * majors). Consumers should read this flag instead of introspecting `schema` themselves.
   */
  readonly acceptsIdempotencyKey: boolean;
  readonly action?: MikaOperationActionDefinition;
  readonly call: MikaApiOperationCall<unknown, unknown>;
};

// The operation (and its action) name is always the derived `${namespace}.${method}`.
type MikaOperationName<TDefinition> = TDefinition extends {
  readonly namespace: infer TNamespace extends string;
  readonly method: infer TMethod extends string;
}
  ? `${TNamespace}.${TMethod}`
  : string;

type MikaDefinedActionSchema<TDefinition, TAction> = TAction extends {
  readonly schema: infer TActionSchema extends z.ZodType;
}
  ? TActionSchema
  : TDefinition extends { readonly schema: infer TSchema extends z.ZodType }
    ? TSchema
    : z.ZodType;

type MikaDefinedOperationAction<
  TKey extends string,
  TDefinition,
  TAction extends MikaOperationActionInputDefinition,
> = Omit<TAction, "schema"> & {
  readonly key: TKey;
  readonly name: MikaOperationName<TDefinition>;
  readonly schema: MikaDefinedActionSchema<TDefinition, TAction>;
};

type MikaDefinedOperation<TKey extends string, TDefinition> = Omit<
  TDefinition,
  "name" | "action"
> & {
  readonly name: MikaOperationName<TDefinition>;
} & (TDefinition extends {
    readonly action: infer TAction extends MikaOperationActionInputDefinition;
  }
    ? { readonly action: MikaDefinedOperationAction<TKey, TDefinition, TAction> }
    : {});

export function defineMikaOperation<
  const TSchema extends z.ZodType,
  TData,
  const TDefinition extends MikaApiOperationBaseInputDefinition,
>(
  definition: TDefinition & {
    readonly schema: TSchema;
    readonly action?: MikaOperationActionInputDefinition | undefined;
    readonly call: MikaApiOperationCall<z.infer<TSchema>, TData>;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaOperationName<TDefinition>;
  readonly schema: TSchema;
  readonly acceptsIdempotencyKey: boolean;
  readonly action?: TDefinition extends {
    readonly action: infer TAction extends MikaOperationActionInputDefinition;
  }
    ? Omit<TAction, "schema"> & {
        readonly name: MikaOperationName<TDefinition>;
        readonly schema: MikaDefinedActionSchema<TDefinition, TAction>;
      }
    : never;
  readonly call: MikaApiOperationCall<z.infer<TSchema>, TData>;
};
export function defineMikaOperation<
  const TSchema extends z.ZodType,
  const TDefinition extends MikaApiOperationBaseInputDefinition,
>(
  definition: TDefinition & {
    readonly schema: TSchema;
    readonly action?: MikaOperationActionInputDefinition | undefined;
    readonly call?: undefined;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaOperationName<TDefinition>;
  readonly schema: TSchema;
  readonly acceptsIdempotencyKey: boolean;
  readonly action?: TDefinition extends {
    readonly action: infer TAction extends MikaOperationActionInputDefinition;
  }
    ? Omit<TAction, "schema"> & {
        readonly name: MikaOperationName<TDefinition>;
        readonly schema: MikaDefinedActionSchema<TDefinition, TAction>;
      }
    : never;
  readonly call: MikaApiOperationCall<
    z.infer<TSchema>,
    MikaApiMethodData<TDefinition["namespace"], TDefinition["method"]>
  >;
};
export function defineMikaOperation<
  TData,
  const TDefinition extends MikaApiOperationBaseInputDefinition,
>(
  definition: TDefinition & {
    readonly schema?: undefined;
    readonly action?: undefined;
    readonly call: MikaApiOperationCall<undefined, TData>;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaOperationName<TDefinition>;
  readonly schema?: undefined;
  readonly acceptsIdempotencyKey: false;
  readonly call: MikaApiOperationCall<undefined, TData>;
};
export function defineMikaOperation<const TDefinition extends MikaApiOperationBaseInputDefinition>(
  definition: TDefinition & {
    readonly schema?: undefined;
    readonly action?: undefined;
    readonly call?: undefined;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaOperationName<TDefinition>;
  readonly schema?: undefined;
  readonly acceptsIdempotencyKey: false;
  readonly call: MikaApiOperationCall<
    undefined,
    MikaApiMethodData<TDefinition["namespace"], TDefinition["method"]>
  >;
};
export function defineMikaOperation(definition: any): any {
  return normalizeMikaOperationDefinition(definition);
}

function normalizeMikaOperationDefinition(
  definition: MikaApiOperationBaseInputDefinition & {
    readonly schema?: z.ZodType;
    readonly action?: MikaOperationActionInputDefinition;
    readonly call?: MikaApiOperationCall<unknown, unknown>;
  },
): MikaApiOperationDefinition {
  const name = `${definition.namespace}.${definition.method}`;
  const { action: actionInput, call, ...operation } = definition;
  const action =
    actionInput === undefined
      ? undefined
      : {
          ...actionInput,
          name,
          schema: actionInput.schema ?? definition.schema,
        };

  if (action && !action.schema) {
    throw new Error(`Mika action '${name}' is missing an input schema.`);
  }

  return {
    ...operation,
    name,
    call: call ?? createDefaultMikaOperationCall(operation),
    acceptsIdempotencyKey: schemaAcceptsIdempotencyKey(definition.schema),
    ...(action ? { action: action as MikaOperationActionDefinition } : {}),
  };
}

/**
 * Detects an `idempotencyKey` field via Zod's public `shape` accessor only — never `_def`
 * internals, whose structure is not part of Zod's stable API and can change across majors.
 */
function schemaAcceptsIdempotencyKey(schema: z.ZodType | undefined): boolean {
  if (!schema) return false;
  const resolvedShape = (schema as { readonly shape?: unknown }).shape;

  return (
    typeof resolvedShape === "object" &&
    resolvedShape !== null &&
    Object.prototype.hasOwnProperty.call(resolvedShape, "idempotencyKey")
  );
}

function createDefaultMikaOperationCall(
  operation: Pick<
    MikaApiOperationBaseDefinition,
    "namespace" | "method" | "requiresRequestContext"
  > & { readonly schema?: z.ZodType },
): MikaApiOperationCall<unknown, unknown> {
  return (api, ctx, input) => {
    const namespace = (api as unknown as Record<string, Record<string, unknown>>)[
      operation.namespace
    ];
    const method = namespace?.[operation.method];
    if (typeof method !== "function") {
      throw new Error(
        `Mika API method '${operation.namespace}.${operation.method}' is unavailable.`,
      );
    }

    if (operation.requiresRequestContext) {
      return operation.schema
        ? (method as (ctx: MikaRequestContext, input: unknown) => Promise<MikaApiResult<unknown>>)(
            ctx,
            input,
          )
        : (method as (ctx: MikaRequestContext) => Promise<MikaApiResult<unknown>>)(ctx);
    }

    return operation.schema
      ? (method as (input: unknown) => Promise<MikaApiResult<unknown>>)(input)
      : (method as () => Promise<MikaApiResult<unknown>>)();
  };
}

export function defineMikaOperations<
  const TDefinitions extends Record<string, ReturnType<typeof defineMikaOperation>>,
>(
  definitions: TDefinitions,
): {
  readonly [TKey in keyof TDefinitions]: MikaDefinedOperation<TKey & string, TDefinitions[TKey]>;
} {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, operation]) => [
      key,
      "action" in operation
        ? {
            ...operation,
            action: {
              ...operation.action,
              key,
            },
          }
        : operation,
    ]),
  ) as {
    readonly [TKey in keyof TDefinitions]: MikaDefinedOperation<TKey & string, TDefinitions[TKey]>;
  };
}

export function formAction<
  const TOptions extends Omit<MikaOperationActionInputDefinition, "accept">,
>(options?: TOptions): TOptions & { readonly accept: "form" } {
  return { accept: "form", ...options } as TOptions & { readonly accept: "form" };
}

export function jsonAction<
  const TOptions extends Omit<MikaOperationActionInputDefinition, "accept">,
>(options?: TOptions): TOptions & { readonly accept: "json" } {
  return { accept: "json", ...options } as TOptions & { readonly accept: "json" };
}

/** Success payload type inferred from an operation's `call` binding. */
export type MikaApiOperationData<TOperation extends { readonly call: (...args: any) => any }> =
  TOperation extends { readonly call: (...args: any) => Promise<MikaApiResult<infer TData>> }
    ? TData
    : never;

/** Thrown when an HTML action payload cannot be normalized to operation input. */
export class MikaActionInputError extends Error {
  readonly code: "BAD_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "MikaActionInputError";
    this.code = "BAD_REQUEST";
  }
}

export function defineMikaRouteOnlyDefinitions<
  const TDefinitions extends Record<
    string,
    { readonly routeKey: string; readonly routePath: string; readonly public: boolean }
  >,
>(definitions: TDefinitions): TDefinitions {
  return definitions;
}
