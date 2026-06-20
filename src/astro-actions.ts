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

  const defineMikaAction = <
    TName extends MikaActionName,
    TAccept extends "form" | "json",
    TSchema extends z.ZodType,
    TData = unknown,
  >(
    definition: MikaActionDefinition<TName, TAccept, TSchema>,
    input: TSchema,
    request: (
      api: MikaApi,
      requestContext: MikaRequestContext,
      input: unknown,
    ) => Promise<MikaApiResult<TData>>,
  ): ActionClient<TData, TAccept, TSchema> =>
    createActionClient(definition, input, (actionInput, ctx) => {
      const requestInput = normalizeMikaActionInput(definition, actionInput);
      return run(ctx, definition, requestInput, (api, requestContext) =>
        request(api, requestContext, requestInput),
      );
    });

  const runOperation = <TData>(
    definition: MikaActionDefinition,
    api: MikaApi,
    requestContext: MikaRequestContext,
    input: unknown,
  ): Promise<MikaApiResult<TData>> =>
    callMikaOperation(definition.operation, api, requestContext, input) as Promise<
      MikaApiResult<TData>
    >;

  const actions = {
    catalog: {
      sellables: defineMikaAction(
        mikaActionDefinitions.catalogSellables,
        mikaActionDefinitions.catalogSellables.schema,
        (api, ctx, input) =>
          runOperation<readonly SellableDTO[]>(
            mikaActionDefinitions.catalogSellables,
            api,
            ctx,
            input,
          ),
      ),
    },
    stock: {
      availability: defineMikaAction(
        mikaActionDefinitions.stockAvailability,
        mikaActionDefinitions.stockAvailability.schema,
        (api, ctx, input) =>
          runOperation<AvailabilityDTO>(mikaActionDefinitions.stockAvailability, api, ctx, input),
      ),
    },
    cart: {
      add: defineMikaAction(
        mikaActionDefinitions.cartAdd,
        mikaActionDefinitions.cartAdd.schema,
        (api, ctx, input) => runOperation<CartDTO>(mikaActionDefinitions.cartAdd, api, ctx, input),
      ),
      update: defineMikaAction(
        mikaActionDefinitions.cartUpdate,
        mikaActionDefinitions.cartUpdate.schema,
        (api, ctx, input) =>
          runOperation<CartDTO>(mikaActionDefinitions.cartUpdate, api, ctx, input),
      ),
      remove: defineMikaAction(
        mikaActionDefinitions.cartRemove,
        mikaActionDefinitions.cartRemove.schema,
        (api, ctx, input) =>
          runOperation<CartDTO>(mikaActionDefinitions.cartRemove, api, ctx, input),
      ),
      merge: defineMikaAction(
        mikaActionDefinitions.cartMerge,
        mikaActionDefinitions.cartMerge.schema,
        (api, ctx, input) =>
          runOperation<CartDTO>(mikaActionDefinitions.cartMerge, api, ctx, input),
      ),
      applyCoupon: defineMikaAction(
        mikaActionDefinitions.cartApplyCoupon,
        mikaActionDefinitions.cartApplyCoupon.schema,
        (api, ctx, input) =>
          runOperation<CartDTO>(mikaActionDefinitions.cartApplyCoupon, api, ctx, input),
      ),
      removeCoupon: defineMikaAction(
        mikaActionDefinitions.cartRemoveCoupon,
        mikaActionDefinitions.cartRemoveCoupon.schema,
        (api, ctx, input) =>
          runOperation<CartDTO>(mikaActionDefinitions.cartRemoveCoupon, api, ctx, input),
      ),
    },
    wishlist: {
      add: defineMikaAction(
        mikaActionDefinitions.wishlistAdd,
        mikaActionDefinitions.wishlistAdd.schema,
        (api, ctx, input) =>
          runOperation<WishlistDTO>(mikaActionDefinitions.wishlistAdd, api, ctx, input),
      ),
      remove: defineMikaAction(
        mikaActionDefinitions.wishlistRemove,
        mikaActionDefinitions.wishlistRemove.schema,
        (api, ctx, input) =>
          runOperation<WishlistDTO>(mikaActionDefinitions.wishlistRemove, api, ctx, input),
      ),
      moveToCart: defineMikaAction(
        mikaActionDefinitions.wishlistMoveToCart,
        mikaActionDefinitions.wishlistMoveToCart.schema,
        (api, ctx, input) =>
          runOperation<CartDTO>(mikaActionDefinitions.wishlistMoveToCart, api, ctx, input),
      ),
      saveForLater: defineMikaAction(
        mikaActionDefinitions.wishlistSaveForLater,
        mikaActionDefinitions.wishlistSaveForLater.schema,
        (api, ctx, input) =>
          runOperation<WishlistDTO>(mikaActionDefinitions.wishlistSaveForLater, api, ctx, input),
      ),
      merge: defineMikaAction(
        mikaActionDefinitions.wishlistMerge,
        mikaActionDefinitions.wishlistMerge.schema,
        (api, ctx, input) =>
          runOperation<WishlistDTO>(mikaActionDefinitions.wishlistMerge, api, ctx, input),
      ),
    },
    checkout: {
      start: defineMikaAction(
        mikaActionDefinitions.checkoutStart,
        mikaActionDefinitions.checkoutStart.schema,
        (api, ctx, input) =>
          runOperation<CheckoutSessionDTO>(mikaActionDefinitions.checkoutStart, api, ctx, input),
      ),
      status: defineMikaAction(
        mikaActionDefinitions.checkoutStatus,
        mikaActionDefinitions.checkoutStatus.schema,
        (api, ctx, input) =>
          runOperation<CheckoutSessionDTO>(mikaActionDefinitions.checkoutStatus, api, ctx, input),
      ),
    },
    magicLink: {
      request: defineMikaAction(
        mikaActionDefinitions.magicLinkRequest,
        mikaActionDefinitions.magicLinkRequest.schema,
        (api, ctx, input) =>
          runOperation<{ readonly sent: boolean }>(
            mikaActionDefinitions.magicLinkRequest,
            api,
            ctx,
            input,
          ),
      ),
      verify: defineMikaAction(
        mikaActionDefinitions.magicLinkVerify,
        mikaActionDefinitions.magicLinkVerify.schema,
        (api, ctx, input) =>
          runOperation<AccountDTO>(mikaActionDefinitions.magicLinkVerify, api, ctx, input),
      ),
    },
    account: {
      export: defineMikaAction(
        mikaActionDefinitions.accountExport,
        mikaActionDefinitions.accountExport.schema,
        (api, ctx, input) =>
          runOperation<AccountExportDTO>(mikaActionDefinitions.accountExport, api, ctx, input),
      ),
      exportStatus: defineMikaAction(
        mikaActionDefinitions.accountExportStatus,
        mikaActionDefinitions.accountExportStatus.schema,
        (api, ctx, input) =>
          runOperation<AccountExportDTO>(
            mikaActionDefinitions.accountExportStatus,
            api,
            ctx,
            input,
          ),
      ),
      delete: defineMikaAction(
        mikaActionDefinitions.accountDelete,
        mikaActionDefinitions.accountDelete.schema,
        (api, ctx, input) =>
          runOperation<{ readonly requested: boolean }>(
            mikaActionDefinitions.accountDelete,
            api,
            ctx,
            input,
          ),
      ),
      portal: defineMikaAction(
        mikaActionDefinitions.accountPortal,
        mikaActionDefinitions.accountPortal.schema,
        (api, ctx, input) =>
          runOperation<{ readonly redirectUrl: string }>(
            mikaActionDefinitions.accountPortal,
            api,
            ctx,
            input,
          ),
      ),
    },
    subscription: {
      cancel: defineMikaAction(
        mikaActionDefinitions.subscriptionCancel,
        mikaActionDefinitions.subscriptionCancel.schema,
        (api, ctx, input) =>
          runOperation<AccountDTO>(mikaActionDefinitions.subscriptionCancel, api, ctx, input),
      ),
      change: defineMikaAction(
        mikaActionDefinitions.subscriptionChange,
        mikaActionDefinitions.subscriptionChange.schema,
        (api, ctx, input) =>
          runOperation<AccountDTO>(mikaActionDefinitions.subscriptionChange, api, ctx, input),
      ),
      renew: defineMikaAction(
        mikaActionDefinitions.subscriptionRenew,
        mikaActionDefinitions.subscriptionRenew.schema,
        (api, ctx, input) =>
          runOperation<AccountDTO>(mikaActionDefinitions.subscriptionRenew, api, ctx, input),
      ),
    },
  } satisfies MikaActions;

  return actions;
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
