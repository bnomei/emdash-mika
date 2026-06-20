import type { MikaRequestContext } from "./context";
import type { MikaApi } from "./server";
import type { MikaApiResult } from "./types";
import { createMikaId } from "../types/primitives";
import type { MikaAgentOperationMetadata } from "./agent-types";
import { agentOperationMetadata } from "./operation-agent-metadata";
import {
  accountExportDownloadInputSchema,
  accountExportStatusInputSchema,
  addCartItemInputSchema,
  applyCouponInputSchema,
  cartAddFormInputSchema,
  cartQuoteInputSchema,
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

export type MikaOperationHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type MikaOperationTransport = "body" | "search" | "none";
export type MikaActionAccept = "form" | "json";

type MikaApiOperationCall<TInput, TData> = {
  call(api: MikaApi, ctx: MikaRequestContext, input: TInput): Promise<MikaApiResult<TData>>;
}["call"];

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
function defineMikaOperation(definition: any): any {
  return normalizeMikaOperationDefinition(definition);
}

function normalizeMikaOperationDefinition(
  definition: MikaApiOperationBaseInputDefinition & {
    readonly schema?: z.ZodType;
    readonly action?: MikaOperationActionInputDefinition;
    readonly call: MikaApiOperationCall<unknown, unknown>;
  },
): MikaApiOperationDefinition {
  const name = definition.name ?? `${definition.namespace}.${definition.method}`;
  const { action: actionInput, ...operation } = definition;
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
    ...(action ? { action: action as MikaOperationActionDefinition } : {}),
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

export type MikaApiOperationData<TOperation extends { readonly call: (...args: any) => any }> =
  TOperation extends { readonly call: (...args: any) => Promise<MikaApiResult<infer TData>> }
    ? TData
    : never;

export type MikaApiOperationInput<TOperation> = TOperation extends {
  readonly schema: z.ZodType<infer TInput>;
}
  ? TInput
  : undefined;

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
  const purchase = input.purchase ? new URLSearchParams(input.purchase) : undefined;
  const purchaseSellableId = parsePurchaseMikaId(purchase?.get("sellableId"), "sellableId");
  const purchasePriceId = parsePurchaseMikaId(purchase?.get("priceId"), "priceId");
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
  const customer =
    input.email || input.name || input.company || input.vatId
      ? {
          email: input.email,
          name: input.name,
          company: input.company,
          vatId: input.vatId,
        }
      : undefined;

  return {
    cartId: input.cartId,
    sellableId: input.sellableId,
    priceId: input.priceId,
    quantity: input.quantity,
    provider: input.provider,
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
    call: (api, _ctx, input) => api.stock.availability(input),
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
    call: (api, ctx) => api.cart.get(ctx),
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
    call: (api, ctx, input) => api.cart.quote(ctx, input),
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
    call: (api, ctx, input) => api.cart.add(ctx, input),
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
    call: (api, ctx, input) => api.cart.update(ctx, input),
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
    call: (api, ctx, input) => api.cart.remove(ctx, input),
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
    call: (api, ctx, input) => api.cart.merge(ctx, input),
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
    call: (api, ctx, input) => api.cart.applyCoupon(ctx, input),
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
    call: (api, ctx, input) => api.cart.removeCoupon(ctx, input),
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
    call: (api, ctx) => api.wishlist.get(ctx),
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
    call: (api, ctx, input) => api.wishlist.add(ctx, input),
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
    call: (api, ctx, input) => api.wishlist.remove(ctx, input),
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
    call: (api, ctx, input) => api.wishlist.moveToCart(ctx, input),
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
    call: (api, ctx, input) => api.wishlist.saveForLater(ctx, input),
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
    call: (api, ctx, input) => api.wishlist.merge(ctx, input),
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
    call: (api, ctx, input) => api.checkout.start(ctx, input),
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
    call: (api, ctx, input) => api.checkout.preview(ctx, input),
  }),
  checkoutStatus: defineMikaOperation({
    namespace: "checkout",
    method: "status",
    routeKey: "checkoutStatus",
    routePath: "checkout/status",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.checkoutRead,
    schema: checkoutStatusInputSchema,
    searchKeys: ["checkoutId"],
    action: jsonAction(),
    call: (api, _ctx, input) => api.checkout.status(input),
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
    call: (api, ctx, input) => api.magicLink.request(ctx, input),
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
    call: (api, ctx, input) => api.magicLink.verify(ctx, input),
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
    call: (api, ctx) => api.account.get(ctx),
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
    call: (api, ctx, input) => api.account.export(ctx, input),
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
    call: (api, ctx, input) => api.account.exportStatus(ctx, input),
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
    call: (api, ctx, input) => api.account.exportDownload(ctx, input),
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
    call: (api, ctx, input) => api.account.delete(ctx, input),
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
    call: (api, ctx, input) => api.account.portal(ctx, input),
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
    call: (api, ctx, input) => api.subscription.cancel(ctx, input),
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
    call: (api, ctx, input) => api.subscription.change(ctx, input),
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
    call: (api, ctx, input) => api.subscription.renew(ctx, input),
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
    call: (api, _ctx, input) => api.download.resolve(input),
  }),
  orderInvoice: defineMikaOperation({
    namespace: "order",
    method: "invoice",
    routeKey: "orderInvoice",
    routePath: "orders/invoice",
    httpMethod: "GET",
    transport: "search",
    public: false,
    requiresRequestContext: false,
    agent: agentOperationMetadata.orderRead,
    schema: orderInvoiceInputSchema,
    searchKeys: ["orderId", "returnTo"],
    call: (api, _ctx, input) => api.order.invoice(input),
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
    call: (api, ctx, input) => api.webhook.receive(ctx, input),
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
    call: (api, _ctx, input) => api.admin.providerHealth(input),
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
    call: (api, _ctx, input) => api.admin.providerSync(input),
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
    call: (api, _ctx, input) => api.admin.stockAdjust(input),
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
    call: (api, _ctx, input) => api.admin.releaseExpiredReservations(input),
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
    call: (api, _ctx, input) => api.admin.webhookReplay(input),
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
    call: (api, _ctx, input) => api.admin.orderRefund(input),
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
    call: (api, _ctx, input) => api.admin.orderCancel(input),
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
    call: (api, _ctx, input) => api.admin.entitlementGrant(input),
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
    call: (api, _ctx, input) => api.admin.entitlementRevoke(input),
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
    call: (api, _ctx, input) => api.admin.emailResend(input),
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
    call: (api, _ctx, input) => api.admin.licenseRevoke(input),
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
    call: (api, _ctx, input) => api.admin.downloadIssue(input),
  }),
});

export type MikaApiOperation =
  (typeof mikaOperationDefinitions)[keyof typeof mikaOperationDefinitions];
export type MikaRouteOperation = MikaApiOperation;
export type MikaRouteOnlyDefinition =
  (typeof mikaRouteOnlyDefinitions)[keyof typeof mikaRouteOnlyDefinitions];

export const mikaRoutedOperationDefinitions = Object.values(
  mikaOperationDefinitions,
) as readonly MikaRouteOperation[];

export const mikaRouteOperationsByPath = collectMikaRouteOperationsByPath();

type MikaOperationPluginRoutes = {
  readonly [TOperation in MikaRouteOperation as TOperation["routeKey"]]: TOperation["routePath"];
} & {
  readonly [TRoute in MikaRouteOnlyDefinition as TRoute["routeKey"]]: TRoute["routePath"];
};

export const mikaOperationPluginRoutes = collectMikaPluginRoutes() as MikaOperationPluginRoutes;

export type MikaOperationPublicRouteName = Extract<
  MikaRouteOperation,
  { readonly public: true }
>["routeKey"];

export const mikaOperationPublicRouteNames = mikaRoutedOperationDefinitions
  .filter(
    (operation): operation is Extract<MikaRouteOperation, { readonly public: true }> =>
      operation.public,
  )
  .map((operation) => operation.routeKey) as readonly MikaOperationPublicRouteName[];

export type MikaOperationApiMethodNames = {
  readonly [TNamespace in MikaApiOperation["namespace"]]: readonly Extract<
    MikaApiOperation,
    { readonly namespace: TNamespace }
  >["method"][];
};

export const mikaOperationApiMethodNames =
  collectMikaApiMethodNames() as MikaOperationApiMethodNames;

type MikaActionOperation = Extract<
  MikaApiOperation,
  { readonly action: MikaOperationActionDefinition }
>;

export type MikaActionDefinitions = {
  readonly [TOperation in MikaActionOperation as TOperation["action"]["key"]]: TOperation["action"] & {
    readonly operation: TOperation;
  };
};

export type MikaActionName = MikaActionDefinitions[keyof MikaActionDefinitions]["name"];
export type MikaActionDefinition = MikaActionDefinitions[keyof MikaActionDefinitions];

export const mikaActionDefinitions = collectMikaActionDefinitions() as MikaActionDefinitions;

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
