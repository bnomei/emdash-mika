/**
 * Operation registry: descriptors, routes, agent metadata, schemas, and dispatch to {@link MikaApi}.
 * Single source of truth for plugin routes, action definitions, and agent manifests.
 */
import type { MikaRequestContext } from "./context";
import type { MikaApi } from "./server";
import type { MikaApiResult } from "./types";
import { createMikaId } from "../types/primitives";
import { normalizeMikaCheckoutCustomer, parseMikaPurchaseField } from "./form-contracts";
import type { MikaAgentOperationMetadata } from "./agent-types";
import { agentOperationMetadata } from "./operation-agent-metadata";
import {
  accountExportDownloadInputSchema,
  accountExportStatusInputSchema,
  addCartItemInputSchema,
  applyCouponInputSchema,
  cartAddFormInputSchema,
  cartQuoteInputSchema,
  checkoutCancelInputSchema,
  checkoutPreviewInputSchema,
  checkoutStartFormInputSchema,
  checkoutStatusInputSchema,
  contentRefInputSchema,
  downloadIssueInputSchema,
  downloadResolveInputSchema,
  emailResendInputSchema,
  entitlementGrantInputSchema,
  entitlementRevokeInputSchema,
  licenseRevokeInputSchema,
  magicLinkRequestInputSchema,
  magicLinkVerifyInputSchema,
  mergeCartInputSchema,
  mergeWishlistInputSchema,
  moveWishlistItemToCartInputSchema,
  orderCancelInputSchema,
  orderInvoiceInputSchema,
  orderRefundInputSchema,
  providerHealthInputSchema,
  providerSyncInputSchema,
  releaseExpiredReservationsInputSchema,
  removeCartItemInputSchema,
  removeCouponInputSchema,
  removeWishlistItemInputSchema,
  returnToInputSchema,
  saveCartLineForLaterInputSchema,
  startCheckoutInputSchema,
  stockAdjustInputSchema,
  stockAvailabilityInputSchema,
  subscriptionCancelInputSchema,
  subscriptionChangeInputSchema,
  subscriptionRenewInputSchema,
  updateCartItemInputSchema,
  webhookReceiveInputSchema,
  webhookReplayInputSchema,
  wishlistItemInputSchema,
  type z,
} from "./validation";

export { mikaOperationRequestInit, parseMikaOperationInput } from "./operation-transport";

/** HTTP verbs used by plugin route operations. */
export type MikaOperationHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
/** Where validated input is read on the HTTP request. */
export type MikaOperationTransport = "body" | "search" | "none";
/** Accepted encoding for HTML action endpoints. */
export type MikaActionAccept = "form" | "json";

/** Serializable view of an operation for manifests, routing, and policy. */
export interface MikaOperationDescriptor {
  readonly name: string;
  readonly namespace: string;
  readonly method: string;
  readonly public: boolean;
  readonly requiresRequestContext: boolean;
  readonly agent: MikaAgentOperationMetadata;
  readonly action?: {
    readonly key: string;
    readonly name: string;
    readonly accept: MikaActionAccept;
  };
  readonly route: {
    readonly key: string;
    readonly path: string;
    readonly httpMethod: MikaOperationHttpMethod;
    readonly transport: MikaOperationTransport;
    readonly searchKeys?: readonly string[];
  };
}

type MikaApiOperationCall<TInput, TData> = {
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

type MikaOperationActionNormalizer = (input: any) => unknown;

interface MikaOperationActionDefinition<TActionInput = unknown> {
  readonly key: string;
  readonly name: string;
  readonly accept: MikaActionAccept;
  readonly schema: z.ZodType<TActionInput>;
  readonly normalize?: MikaOperationActionNormalizer;
}

type MikaOperationActionInputDefinition<TActionSchema extends z.ZodType | undefined = z.ZodType> = {
  readonly key?: string;
  readonly name?: string;
  readonly accept: MikaActionAccept;
  readonly schema?: TActionSchema;
  readonly normalize?: MikaOperationActionNormalizer;
};

interface MikaApiOperationBaseDefinition {
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
  readonly searchKeys?: readonly string[];
}

type MikaApiOperationBaseInputDefinition = Omit<MikaApiOperationBaseDefinition, "name"> & {
  readonly name?: string;
};

type MikaApiOperationDefinition = MikaApiOperationBaseDefinition & {
  readonly schema?: z.ZodType;
  readonly action?: MikaOperationActionDefinition;
  readonly call: MikaApiOperationCall<unknown, unknown>;
};

type MikaOperationName<TDefinition> = TDefinition extends {
  readonly namespace: infer TNamespace extends string;
  readonly method: infer TMethod extends string;
}
  ? `${TNamespace}.${TMethod}`
  : string;

type MikaDefinedOperationName<TDefinition> = TDefinition extends {
  readonly name: infer TName extends string;
}
  ? TName
  : MikaOperationName<TDefinition>;

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
> = Omit<TAction, "key" | "name" | "schema"> & {
  readonly key: TAction extends { readonly key: infer TActionKey extends string }
    ? TActionKey
    : TKey;
  readonly name: TAction extends { readonly name: infer TActionName extends string }
    ? TActionName
    : MikaDefinedOperationName<TDefinition>;
  readonly schema: MikaDefinedActionSchema<TDefinition, TAction>;
};

type MikaDefinedOperation<TKey extends string, TDefinition> = Omit<
  TDefinition,
  "name" | "action"
> & {
  readonly name: MikaDefinedOperationName<TDefinition>;
} & (TDefinition extends {
    readonly action: infer TAction extends MikaOperationActionInputDefinition;
  }
    ? { readonly action: MikaDefinedOperationAction<TKey, TDefinition, TAction> }
    : {});

function defineMikaOperation<
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
  readonly name: MikaDefinedOperationName<TDefinition>;
  readonly schema: TSchema;
  readonly action?: TDefinition extends {
    readonly action: infer TAction extends MikaOperationActionInputDefinition;
  }
    ? Omit<TAction, "name" | "schema"> & {
        readonly name: MikaDefinedOperationName<TDefinition>;
        readonly schema: MikaDefinedActionSchema<TDefinition, TAction>;
      }
    : never;
  readonly call: MikaApiOperationCall<z.infer<TSchema>, TData>;
};
function defineMikaOperation<
  const TSchema extends z.ZodType,
  const TDefinition extends MikaApiOperationBaseInputDefinition,
>(
  definition: TDefinition & {
    readonly schema: TSchema;
    readonly action?: MikaOperationActionInputDefinition | undefined;
    readonly call?: undefined;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaDefinedOperationName<TDefinition>;
  readonly schema: TSchema;
  readonly action?: TDefinition extends {
    readonly action: infer TAction extends MikaOperationActionInputDefinition;
  }
    ? Omit<TAction, "name" | "schema"> & {
        readonly name: MikaDefinedOperationName<TDefinition>;
        readonly schema: MikaDefinedActionSchema<TDefinition, TAction>;
      }
    : never;
  readonly call: MikaApiOperationCall<
    z.infer<TSchema>,
    MikaApiMethodData<TDefinition["namespace"], TDefinition["method"]>
  >;
};
function defineMikaOperation<TData, const TDefinition extends MikaApiOperationBaseInputDefinition>(
  definition: TDefinition & {
    readonly schema?: undefined;
    readonly action?: undefined;
    readonly call: MikaApiOperationCall<undefined, TData>;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaDefinedOperationName<TDefinition>;
  readonly schema?: undefined;
  readonly call: MikaApiOperationCall<undefined, TData>;
};
function defineMikaOperation<const TDefinition extends MikaApiOperationBaseInputDefinition>(
  definition: TDefinition & {
    readonly schema?: undefined;
    readonly action?: undefined;
    readonly call?: undefined;
  },
): Omit<TDefinition, "name"> & {
  readonly name: MikaDefinedOperationName<TDefinition>;
  readonly schema?: undefined;
  readonly call: MikaApiOperationCall<
    undefined,
    MikaApiMethodData<TDefinition["namespace"], TDefinition["method"]>
  >;
};
function defineMikaOperation(definition: any): any {
  return normalizeMikaOperationDefinition(definition);
}

function normalizeMikaOperationDefinition(
  definition: MikaApiOperationBaseInputDefinition & {
    readonly schema?: z.ZodType;
    readonly action?: MikaOperationActionInputDefinition;
    readonly call?: MikaApiOperationCall<unknown, unknown>;
  },
): MikaApiOperationDefinition {
  const name = definition.name ?? `${definition.namespace}.${definition.method}`;
  const { action: actionInput, call, ...operation } = definition;
  const action =
    actionInput === undefined
      ? undefined
      : {
          ...actionInput,
          name: actionInput.name ?? name,
          schema: actionInput.schema ?? definition.schema,
        };

  if (action && !action.schema) {
    throw new Error(`Mika action '${name}' is missing an input schema.`);
  }

  return {
    ...operation,
    name,
    call: call ?? createDefaultMikaOperationCall(operation),
    ...(action ? { action: action as MikaOperationActionDefinition } : {}),
  };
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

function defineMikaOperations<
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
              key: operation.action.key ?? key,
            },
          }
        : operation,
    ]),
  ) as {
    readonly [TKey in keyof TDefinitions]: MikaDefinedOperation<TKey & string, TDefinitions[TKey]>;
  };
}

function formAction<const TOptions extends Omit<MikaOperationActionInputDefinition, "accept">>(
  options?: TOptions,
): TOptions & { readonly accept: "form" } {
  return { accept: "form", ...options } as TOptions & { readonly accept: "form" };
}

function jsonAction<const TOptions extends Omit<MikaOperationActionInputDefinition, "accept">>(
  options?: TOptions,
): TOptions & { readonly accept: "json" } {
  return { accept: "json", ...options } as TOptions & { readonly accept: "json" };
}

/** Success payload type inferred from an operation's `call` binding. */
export type MikaApiOperationData<TOperation extends { readonly call: (...args: any) => any }> =
  TOperation extends { readonly call: (...args: any) => Promise<MikaApiResult<infer TData>> }
    ? TData
    : never;

/** Validated input type inferred from an operation's Zod schema. */
export type MikaApiOperationInput<TOperation> = TOperation extends {
  readonly schema: z.ZodType<infer TInput>;
}
  ? TInput
  : undefined;

/** Thrown when an HTML action payload cannot be normalized to operation input. */
export class MikaActionInputError extends Error {
  readonly code: "BAD_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "MikaActionInputError";
    this.code = "BAD_REQUEST";
  }
}

function defineMikaRouteOnlyDefinitions<
  const TDefinitions extends Record<
    string,
    { readonly routeKey: string; readonly routePath: string; readonly public: boolean }
  >,
>(definitions: TDefinitions): TDefinitions {
  return definitions;
}

/** Routes without backing API operations (admin manifest and action runner). */
export const mikaRouteOnlyDefinitions = defineMikaRouteOnlyDefinitions({
  actionsManifest: {
    routeKey: "actionsManifest",
    routePath: ".well-known/actions",
    public: false,
  },
  actionsRunner: {
    routeKey: "actionsRunner",
    routePath: ".well-known/actions/run",
    public: false,
  },
});

type CartAddFormInput = z.infer<typeof cartAddFormInputSchema>;
type CheckoutStartFormInput = z.infer<typeof checkoutStartFormInputSchema>;

function normalizeCartAddActionInput(input: CartAddFormInput) {
  const purchase = parseMikaPurchaseField(input.purchase);
  const purchaseSellableId = parsePurchaseMikaId(purchase.sellableId, "sellableId");
  const purchasePriceId = parsePurchaseMikaId(purchase.priceId, "priceId");
  const sellableId = purchaseSellableId ?? input.sellableId;
  const priceId = purchasePriceId ?? input.priceId;

  if (!sellableId) {
    throw new MikaActionInputError("sellableId is required.");
  }

  return {
    sellableId,
    priceId: priceId || undefined,
    variantKey: input.variantKey,
    variantOptions: input.variantOptions,
    quantity: input.quantity,
    returnTo: input.returnTo,
  };
}

function normalizeCheckoutStartActionInput(input: CheckoutStartFormInput) {
  const customer = normalizeMikaCheckoutCustomer(input);

  return {
    cartId: input.cartId,
    sellableId: input.sellableId,
    priceId: input.priceId,
    quantity: input.quantity,
    provider: input.provider,
    couponCode: input.couponCode,
    customer,
    customFields: input.customFields,
    successPath: input.successPath,
    cancelPath: input.cancelPath,
    returnTo: input.returnTo,
  };
}

function parsePurchaseMikaId(value: string | null | undefined, field: string) {
  if (!value) return undefined;

  try {
    return createMikaId(value);
  } catch {
    throw new MikaActionInputError(`${field} is invalid.`);
  }
}

/** Full catalog of Mika API operations with schemas, routes, and dispatch closures. */
export const mikaOperationDefinitions = defineMikaOperations({
  catalogSellables: defineMikaOperation({
    namespace: "catalog",
    method: "sellables",
    routeKey: "catalogSellables",
    routePath: "catalog/sellables",
    httpMethod: "GET",
    transport: "search",
    public: true,
    requiresRequestContext: false,
    agent: agentOperationMetadata.catalogRead,
    schema: contentRefInputSchema,
    searchKeys: ["collection", "id", "locale"],
    action: jsonAction(),
    call: (api, _ctx, input) => api.catalog.sellables({ contentRef: input }),
  }),
  stockAvailability: defineMikaOperation({
    namespace: "stock",
    method: "availability",
    routeKey: "sellableAvailability",
    routePath: "sellables/availability",
    httpMethod: "GET",
    transport: "search",
    public: true,
    requiresRequestContext: false,
    agent: agentOperationMetadata.stockRead,
    schema: stockAvailabilityInputSchema,
    searchKeys: ["sellableId"],
    action: jsonAction(),
  }),
  cartGet: defineMikaOperation({
    namespace: "cart",
    method: "get",
    routeKey: "cart",
    routePath: "cart",
    httpMethod: "GET",
    transport: "none",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartRead,
  }),
  cartQuote: defineMikaOperation({
    namespace: "cart",
    method: "quote",
    routeKey: "cartQuote",
    routePath: "cart/quote",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartQuote,
    schema: cartQuoteInputSchema,
  }),
  cartAdd: defineMikaOperation({
    namespace: "cart",
    method: "add",
    routeKey: "cartItems",
    routePath: "cart/items",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartWrite,
    schema: addCartItemInputSchema,
    action: formAction({
      schema: cartAddFormInputSchema,
      normalize: normalizeCartAddActionInput,
    }),
  }),
  cartUpdate: defineMikaOperation({
    namespace: "cart",
    method: "update",
    routeKey: "cartItem",
    routePath: "cart/item",
    httpMethod: "PATCH",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartWrite,
    schema: updateCartItemInputSchema,
    action: formAction(),
  }),
  cartRemove: defineMikaOperation({
    namespace: "cart",
    method: "remove",
    routeKey: "cartItem",
    routePath: "cart/item",
    httpMethod: "DELETE",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartWrite,
    schema: removeCartItemInputSchema,
    action: formAction(),
  }),
  cartMerge: defineMikaOperation({
    namespace: "cart",
    method: "merge",
    routeKey: "cartMerge",
    routePath: "cart/merge",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartWrite,
    schema: mergeCartInputSchema,
    action: formAction(),
  }),
  cartApplyCoupon: defineMikaOperation({
    namespace: "cart",
    method: "applyCoupon",
    routeKey: "cartCoupon",
    routePath: "cart/coupon",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartWrite,
    schema: applyCouponInputSchema,
    action: formAction(),
  }),
  cartRemoveCoupon: defineMikaOperation({
    namespace: "cart",
    method: "removeCoupon",
    routeKey: "cartCoupon",
    routePath: "cart/coupon",
    httpMethod: "DELETE",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.cartWrite,
    schema: removeCouponInputSchema,
    action: formAction(),
  }),
  wishlistGet: defineMikaOperation({
    namespace: "wishlist",
    method: "get",
    routeKey: "wishlist",
    routePath: "wishlist",
    httpMethod: "GET",
    transport: "none",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.wishlistRead,
  }),
  wishlistAdd: defineMikaOperation({
    namespace: "wishlist",
    method: "add",
    routeKey: "wishlistItems",
    routePath: "wishlist/items",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.wishlistWrite,
    schema: wishlistItemInputSchema,
    action: formAction(),
  }),
  wishlistRemove: defineMikaOperation({
    namespace: "wishlist",
    method: "remove",
    routeKey: "wishlistItem",
    routePath: "wishlist/item",
    httpMethod: "DELETE",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.wishlistWrite,
    schema: removeWishlistItemInputSchema,
    action: formAction(),
  }),
  wishlistMoveToCart: defineMikaOperation({
    namespace: "wishlist",
    method: "moveToCart",
    routeKey: "wishlistMoveToCart",
    routePath: "wishlist/move-to-cart",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.wishlistWrite,
    schema: moveWishlistItemToCartInputSchema,
    action: formAction(),
  }),
  wishlistSaveForLater: defineMikaOperation({
    namespace: "wishlist",
    method: "saveForLater",
    routeKey: "wishlistSaveForLater",
    routePath: "wishlist/save-for-later",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.wishlistWrite,
    schema: saveCartLineForLaterInputSchema,
    action: formAction(),
  }),
  wishlistMerge: defineMikaOperation({
    namespace: "wishlist",
    method: "merge",
    routeKey: "wishlistMerge",
    routePath: "wishlist/merge",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.wishlistWrite,
    schema: mergeWishlistInputSchema,
    action: formAction(),
  }),
  checkoutStart: defineMikaOperation({
    namespace: "checkout",
    method: "start",
    routeKey: "checkout",
    routePath: "checkout",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.checkoutHandoff,
    schema: startCheckoutInputSchema,
    action: formAction({
      schema: checkoutStartFormInputSchema,
      normalize: normalizeCheckoutStartActionInput,
    }),
  }),
  checkoutPreview: defineMikaOperation({
    namespace: "checkout",
    method: "preview",
    routeKey: "checkoutPreview",
    routePath: "checkout/preview",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.checkoutPreview,
    schema: checkoutPreviewInputSchema,
  }),
  checkoutStatus: defineMikaOperation({
    namespace: "checkout",
    method: "status",
    routeKey: "checkoutStatus",
    routePath: "checkout/status",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.checkoutRead,
    schema: checkoutStatusInputSchema,
    searchKeys: ["checkoutId", "token"],
    action: jsonAction(),
  }),
  checkoutCancel: defineMikaOperation({
    namespace: "checkout",
    method: "cancel",
    routeKey: "checkoutAbandon",
    routePath: "checkout/abandon",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.checkoutHandoff,
    schema: checkoutCancelInputSchema,
  }),
  magicLinkRequest: defineMikaOperation({
    namespace: "magicLink",
    method: "request",
    routeKey: "magicLink",
    routePath: "magic-link",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.magicLinkWrite,
    schema: magicLinkRequestInputSchema,
    action: formAction(),
  }),
  magicLinkVerify: defineMikaOperation({
    namespace: "magicLink",
    method: "verify",
    routeKey: "magicLinkVerify",
    routePath: "magic-link/verify",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.magicLinkWrite,
    schema: magicLinkVerifyInputSchema,
    action: formAction(),
  }),
  accountGet: defineMikaOperation({
    namespace: "account",
    method: "get",
    routeKey: "account",
    routePath: "account",
    httpMethod: "GET",
    transport: "none",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.accountRead,
  }),
  accountExport: defineMikaOperation({
    namespace: "account",
    method: "export",
    routeKey: "accountExport",
    routePath: "account/export",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.accountWrite,
    schema: returnToInputSchema,
    action: formAction(),
  }),
  accountExportStatus: defineMikaOperation({
    namespace: "account",
    method: "exportStatus",
    routeKey: "accountExportStatus",
    routePath: "account/export/status",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.accountRead,
    schema: accountExportStatusInputSchema,
    searchKeys: ["exportId"],
    action: jsonAction(),
  }),
  accountExportDownload: defineMikaOperation({
    namespace: "account",
    method: "exportDownload",
    routeKey: "accountExportDownload",
    routePath: "account/export/download",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.accountRead,
    schema: accountExportDownloadInputSchema,
    searchKeys: ["exportId", "token"],
  }),
  accountDelete: defineMikaOperation({
    namespace: "account",
    method: "delete",
    routeKey: "accountDelete",
    routePath: "account/delete",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.accountWrite,
    schema: returnToInputSchema,
    action: formAction(),
  }),
  accountPortal: defineMikaOperation({
    namespace: "account",
    method: "portal",
    routeKey: "accountPortal",
    routePath: "account/portal",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.accountWrite,
    schema: returnToInputSchema,
    action: formAction(),
  }),
  subscriptionCancel: defineMikaOperation({
    namespace: "subscription",
    method: "cancel",
    routeKey: "subscriptionCancel",
    routePath: "subscriptions/cancel",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.subscriptionWrite,
    schema: subscriptionCancelInputSchema,
    action: formAction(),
  }),
  subscriptionChange: defineMikaOperation({
    namespace: "subscription",
    method: "change",
    routeKey: "subscriptionChange",
    routePath: "subscriptions/change",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.subscriptionWrite,
    schema: subscriptionChangeInputSchema,
    action: formAction(),
  }),
  subscriptionRenew: defineMikaOperation({
    namespace: "subscription",
    method: "renew",
    routeKey: "subscriptionRenew",
    routePath: "subscriptions/renew",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.subscriptionWrite,
    schema: subscriptionRenewInputSchema,
    action: formAction(),
  }),
  downloadResolve: defineMikaOperation({
    namespace: "download",
    method: "resolve",
    routeKey: "download",
    routePath: "download",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.downloadRead,
    schema: downloadResolveInputSchema,
    searchKeys: ["token"],
  }),
  downloadConfirm: defineMikaOperation({
    namespace: "download",
    method: "confirm",
    routeKey: "downloadConfirm",
    routePath: "download/confirm",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.downloadRead,
    schema: downloadResolveInputSchema,
    action: formAction(),
  }),
  orderInvoice: defineMikaOperation({
    namespace: "order",
    method: "invoice",
    routeKey: "orderInvoice",
    routePath: "orders/invoice",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.orderRead,
    schema: orderInvoiceInputSchema,
    searchKeys: ["orderId", "token", "returnTo"],
  }),
  webhookReceive: defineMikaOperation({
    namespace: "webhook",
    method: "receive",
    routeKey: "webhook",
    routePath: "webhooks",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: true,
    agent: agentOperationMetadata.webhookReceive,
    schema: webhookReceiveInputSchema,
  }),
  adminProviderHealth: defineMikaOperation({
    namespace: "admin",
    method: "providerHealth",
    routeKey: "adminProviderHealth",
    routePath: "admin/provider/health",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminRead,
    schema: providerHealthInputSchema,
  }),
  adminProviderSync: defineMikaOperation({
    namespace: "admin",
    method: "providerSync",
    routeKey: "adminProviderSync",
    routePath: "admin/provider/sync",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: providerSyncInputSchema,
  }),
  adminStockAdjust: defineMikaOperation({
    namespace: "admin",
    method: "stockAdjust",
    routeKey: "adminStockAdjust",
    routePath: "admin/stock/adjust",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: stockAdjustInputSchema,
  }),
  adminStockReleaseExpiredReservations: defineMikaOperation({
    namespace: "admin",
    method: "releaseExpiredReservations",
    routeKey: "adminStockReleaseExpiredReservations",
    routePath: "admin/stock/release-expired-reservations",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: releaseExpiredReservationsInputSchema,
  }),
  adminWebhookReplay: defineMikaOperation({
    namespace: "admin",
    method: "webhookReplay",
    routeKey: "adminWebhookReplay",
    routePath: "admin/webhooks/replay",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: webhookReplayInputSchema,
  }),
  adminOrderRefund: defineMikaOperation({
    namespace: "admin",
    method: "orderRefund",
    routeKey: "adminOrderRefund",
    routePath: "admin/orders/refund",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: orderRefundInputSchema,
  }),
  adminOrderCancel: defineMikaOperation({
    namespace: "admin",
    method: "orderCancel",
    routeKey: "adminOrderCancel",
    routePath: "admin/orders/cancel",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: orderCancelInputSchema,
  }),
  adminEntitlementGrant: defineMikaOperation({
    namespace: "admin",
    method: "entitlementGrant",
    routeKey: "adminEntitlementGrant",
    routePath: "admin/entitlements/grant",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: entitlementGrantInputSchema,
  }),
  adminEntitlementRevoke: defineMikaOperation({
    namespace: "admin",
    method: "entitlementRevoke",
    routeKey: "adminEntitlementRevoke",
    routePath: "admin/entitlements/revoke",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: entitlementRevokeInputSchema,
  }),
  adminEmailResend: defineMikaOperation({
    namespace: "admin",
    method: "emailResend",
    routeKey: "adminEmailResend",
    routePath: "admin/emails/resend",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: emailResendInputSchema,
  }),
  adminLicenseRevoke: defineMikaOperation({
    namespace: "admin",
    method: "licenseRevoke",
    routeKey: "adminLicenseRevoke",
    routePath: "admin/licenses/revoke",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: licenseRevokeInputSchema,
  }),
  adminDownloadIssue: defineMikaOperation({
    namespace: "admin",
    method: "downloadIssue",
    routeKey: "adminDownloadIssue",
    routePath: "admin/downloads/issue",
    httpMethod: "POST",
    transport: "body",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.adminWrite,
    schema: downloadIssueInputSchema,
  }),
});

/** One registered operation definition (schema, route, agent metadata, and call binding). */
export type MikaApiOperation =
  (typeof mikaOperationDefinitions)[keyof typeof mikaOperationDefinitions];
/** Operation definition that maps to an HTTP plugin route. */
export type MikaRouteOperation = MikaApiOperation;
/** Route-only entry without a backing API operation (manifest and action runner). */
export type MikaRouteOnlyDefinition =
  (typeof mikaRouteOnlyDefinitions)[keyof typeof mikaRouteOnlyDefinitions];

/** All operations exposed as HTTP plugin routes. */
export const mikaRoutedOperationDefinitions = Object.values(
  mikaOperationDefinitions,
) as readonly MikaRouteOperation[];

/** Operations grouped by plugin route path for method-based dispatch. */
export const mikaRouteOperationsByPath = collectMikaRouteOperationsByPath();

type MikaOperationPluginRoutes = {
  readonly [TOperation in MikaRouteOperation as TOperation["routeKey"]]: TOperation["routePath"];
} & {
  readonly [TRoute in MikaRouteOnlyDefinition as TRoute["routeKey"]]: TRoute["routePath"];
};

/** Route key to path segment map consumed by {@link mikaPluginRoute}. */
export const mikaOperationPluginRoutes = collectMikaPluginRoutes() as MikaOperationPluginRoutes;

/** Route key union for operations marked `public: true`. */
export type MikaOperationPublicRouteName = Extract<
  MikaRouteOperation,
  { readonly public: true }
>["routeKey"];

/** Route keys marked `public: true` (no session required). */
export const mikaOperationPublicRouteNames = mikaRoutedOperationDefinitions
  .filter(
    (operation): operation is Extract<MikaRouteOperation, { readonly public: true }> =>
      operation.public,
  )
  .map((operation) => operation.routeKey) as readonly MikaOperationPublicRouteName[];

/** Type mapping namespaces to registered API method name lists. */
export type MikaOperationApiMethodNames = {
  readonly [TNamespace in MikaApiOperation["namespace"]]: readonly Extract<
    MikaApiOperation,
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

function collectMikaPluginRoutes(): Record<string, string> {
  const routes: Record<string, string> = {};
  const routeMethods = new Set<string>();

  for (const route of Object.values(mikaRouteOnlyDefinitions)) {
    routes[route.routeKey] = route.routePath;
  }

  for (const operation of mikaRoutedOperationDefinitions) {
    const existingPath = routes[operation.routeKey];
    if (existingPath && existingPath !== operation.routePath) {
      throw new Error(
        `Mika route key '${operation.routeKey}' maps to both '${existingPath}' and '${operation.routePath}'.`,
      );
    }

    const routeMethod = `${operation.routePath}:${operation.httpMethod}`;
    if (routeMethods.has(routeMethod)) {
      throw new Error(
        `Mika route '${operation.routePath}' defines duplicate ${operation.httpMethod} operations.`,
      );
    }
    routeMethods.add(routeMethod);
    routes[operation.routeKey] = operation.routePath;
  }

  return routes;
}

function collectMikaRouteOperationsByPath(): ReadonlyMap<string, readonly MikaRouteOperation[]> {
  const operationsByPath = new Map<string, MikaRouteOperation[]>();

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
    methodNames[operation.namespace] ??= [];
    if (methodNames[operation.namespace]?.includes(operation.method)) {
      throw new Error(
        `Mika API method '${operation.namespace}.${operation.method}' is defined more than once.`,
      );
    }
    methodNames[operation.namespace]?.push(operation.method);
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
