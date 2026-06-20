/// <reference types="astro/client" />

import {
  ActionError,
  defineAction,
  type ActionAPIContext,
  type ActionClient,
  type ActionErrorCode,
  type SafeResult,
} from "astro:actions";
import { createMikaRequestContext } from "./api/context";
import {
  callMikaOperation,
  MikaActionInputError,
  mikaActionDefinitions,
  type MikaActionDefinition as MikaOperationActionDefinition,
  type MikaActionName as MikaOperationActionName,
} from "./api/operations";
import { mikaActionTreeSpec, type MikaActionTreeSpec } from "./api/action-tree";
import { runMikaOperationPolicy, type MikaOperationPolicy } from "./api/operation-policy";
import { resolveMikaApiOverrides, resolveMikaOperationPolicy } from "./api/runtime-api";
import { createMikaApi, type MikaApi, type MikaApiOverrides } from "./api/server";
import { z } from "./api/validation";
import type { MikaRequestContext } from "./api/context";
import type {
  AccountExportDTO,
  AccountExportStatusInput,
  AccountDTO,
  AvailabilityDTO,
  CartDTO,
  CheckoutSessionDTO,
  ContentRefDTO,
  MikaApiResult,
  SellableDTO,
  WishlistDTO,
} from "./api/types";

export interface MikaActionsOptions {
  readonly api?: MikaApiOverrides;
  readonly guard?: (
    ctx: ActionAPIContext,
    action: MikaActionName,
    input: unknown,
  ) => Promise<void> | void;
  readonly operationPolicy?: MikaOperationPolicy;
}

export type MikaActionName = MikaOperationActionName;
export type { MikaOperationPolicy } from "./api/operation-policy";

type MikaActionDefinition<
  TName extends MikaActionName = MikaActionName,
  TAccept extends "form" | "json" = "form" | "json",
  TSchema extends z.ZodType = z.ZodType,
> = MikaOperationActionDefinition & {
  readonly name: TName;
  readonly accept: TAccept;
  readonly schema: TSchema;
};

type MikaDefineActionOptions<
  TData,
  TAccept extends "form" | "json",
  TSchema extends z.ZodType,
> = Parameters<typeof defineAction<TData, TAccept, TSchema>>[0];

type MikaActionResult<TOutput> = Promise<SafeResult<Record<string, unknown>, Awaited<TOutput>>>;

type MikaFormActionClient<TOutput> = {
  (input: FormData): MikaActionResult<TOutput>;
  readonly queryString: string;
  readonly orThrow: (input: FormData) => Promise<Awaited<TOutput>>;
};

type MikaJsonActionClient<TInput, TOutput> = {
  (input: TInput): MikaActionResult<TOutput>;
  readonly queryString: string;
  readonly orThrow: (input: TInput) => Promise<Awaited<TOutput>>;
};

export interface MikaActions {
  readonly catalog: {
    readonly sellables: MikaJsonActionClient<ContentRefDTO, readonly SellableDTO[]>;
  };
  readonly stock: {
    readonly availability: MikaJsonActionClient<{ readonly sellableId: string }, AvailabilityDTO>;
  };
  readonly cart: {
    readonly add: MikaFormActionClient<CartDTO>;
    readonly update: MikaFormActionClient<CartDTO>;
    readonly remove: MikaFormActionClient<CartDTO>;
    readonly merge: MikaFormActionClient<CartDTO>;
    readonly applyCoupon: MikaFormActionClient<CartDTO>;
    readonly removeCoupon: MikaFormActionClient<CartDTO>;
  };
  readonly wishlist: {
    readonly add: MikaFormActionClient<WishlistDTO>;
    readonly remove: MikaFormActionClient<WishlistDTO>;
    readonly moveToCart: MikaFormActionClient<CartDTO>;
    readonly saveForLater: MikaFormActionClient<WishlistDTO>;
    readonly merge: MikaFormActionClient<WishlistDTO>;
  };
  readonly checkout: {
    readonly start: MikaFormActionClient<CheckoutSessionDTO>;
    readonly status: MikaJsonActionClient<{ readonly checkoutId: string }, CheckoutSessionDTO>;
  };
  readonly magicLink: {
    readonly request: MikaFormActionClient<{ readonly sent: boolean }>;
    readonly verify: MikaFormActionClient<AccountDTO>;
  };
  readonly account: {
    readonly export: MikaFormActionClient<AccountExportDTO>;
    readonly exportStatus: MikaJsonActionClient<AccountExportStatusInput, AccountExportDTO>;
    readonly delete: MikaFormActionClient<{ readonly requested: boolean }>;
    readonly portal: MikaFormActionClient<{ readonly redirectUrl: string }>;
  };
  readonly subscription: {
    readonly cancel: MikaFormActionClient<AccountDTO>;
    readonly change: MikaFormActionClient<AccountDTO>;
    readonly renew: MikaFormActionClient<AccountDTO>;
  };
}

export function createMikaActions(options: MikaActionsOptions = {}): MikaActions {
  const run = async <T>(
    ctx: ActionAPIContext,
    definition: MikaActionDefinition,
    input: unknown,
    request: (api: MikaApi, requestContext: MikaRequestContext) => Promise<MikaApiResult<T>>,
  ): Promise<T> => {
    const requestContext = actionRequestContext(ctx);
    await options.guard?.(ctx, definition.name, input);
    const policyRejection = await runMikaOperationPolicy(
      resolveMikaOperationPolicy(options.operationPolicy),
      {
        operation: definition.operation,
        ctx: requestContext,
        input,
      },
    );
    if (policyRejection) return unwrap(policyRejection);

    const api = createMikaApi(resolveMikaApiOverrides(options.api));
    return unwrap(await request(api, requestContext));
  };

  const createActionClient = <
    TName extends MikaActionName,
    TAccept extends "form" | "json",
    TSchema extends z.ZodType,
    TData = unknown,
  >(
    definition: MikaActionDefinition<TName, TAccept, TSchema>,
    input: TSchema,
    handler: (actionInput: z.infer<TSchema>, ctx: ActionAPIContext) => Promise<TData>,
  ): ActionClient<TData, TAccept, TSchema> => {
    return defineAction<TData, TAccept, TSchema>({
      accept: definition.accept,
      input,
      handler: handler as MikaDefineActionOptions<TData, TAccept, TSchema>["handler"],
    });
  };

  const defineMikaAction = (
    definition: MikaActionDefinition,
  ): ActionClient<unknown, "form" | "json", z.ZodType> =>
    createActionClient(definition, definition.schema, (actionInput, ctx) => {
      const requestInput = normalizeMikaActionInput(definition, actionInput);
      return run(ctx, definition, requestInput, (api, requestContext) =>
        callMikaOperation(definition.operation, api, requestContext, requestInput),
      );
    });

  const buildMikaActionTree = (spec: MikaActionTreeSpec): unknown =>
    Object.fromEntries(
      Object.entries(spec).map(([key, value]) => [
        key,
        typeof value === "string"
          ? defineMikaAction(mikaActionDefinitions[value])
          : buildMikaActionTree(value),
      ]),
    );

  return buildMikaActionTree(mikaActionTreeSpec) as MikaActions;
}

export const mika: MikaActions = createMikaActions();

function actionRequestContext(ctx: ActionAPIContext): MikaRequestContext {
  return createMikaRequestContext({
    request: ctx.request,
    url: ctx.url,
    session: ctx.session,
    locale: ctx.currentLocale,
  });
}

function unwrap<T>(result: MikaApiResult<T>): T {
  if (result.ok) return result.data;
  throw new ActionError({
    code: actionCode(result.status),
    message: result.error.message,
  });
}

function actionCode(status: number): ActionErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 410) return "GONE";
  if (status === 422) return "UNPROCESSABLE_CONTENT";
  if (status === 429) return "TOO_MANY_REQUESTS";
  if (status === 500) return "INTERNAL_SERVER_ERROR";
  if (status === 501) return "NOT_IMPLEMENTED";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  if (status >= 500) return "INTERNAL_SERVER_ERROR";
  return "BAD_REQUEST";
}

function normalizeMikaActionInput<TSchema extends z.ZodType>(
  definition: MikaActionDefinition<MikaActionName, "form" | "json", TSchema>,
  input: z.infer<TSchema>,
): unknown {
  try {
    const normalize = ("normalize" in definition ? definition.normalize : undefined) as
      | ((input: unknown) => unknown)
      | undefined;
    return normalize ? normalize(input) : input;
  } catch (error) {
    if (!(error instanceof MikaActionInputError)) throw error;
    throw new ActionError({
      code: error.code,
      message: error.message,
    });
  }
}
