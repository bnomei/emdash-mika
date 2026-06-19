import type { MikaRequestContext } from "./context";
import type { MikaApi } from "./server";
import type { MikaApiResult } from "./types";
import {
  MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
  type MikaAgentIdempotencyMetadata,
  type MikaAgentOperationMetadata,
} from "./agent-types";
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

export type MikaOperationHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type MikaOperationTransport = "body" | "search" | "none";
export type MikaActionAccept = "form" | "json";

type MikaApiOperationCall<TInput> = {
  call(api: MikaApi, ctx: MikaRequestContext, input: TInput): Promise<MikaApiResult<unknown>>;
}["call"];

interface MikaOperationActionDefinition {
  readonly key: string;
  readonly name: string;
  readonly accept: MikaActionAccept;
  readonly schema: z.ZodType;
}

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
  readonly action?: MikaOperationActionDefinition;
}

type MikaApiOperationDefinition = MikaApiOperationBaseDefinition & {
  readonly schema?: z.ZodType;
  readonly call: MikaApiOperationCall<unknown>;
};

function defineMikaOperation<
  const TSchema extends z.ZodType,
  const TDefinition extends MikaApiOperationBaseDefinition,
>(
  definition: TDefinition & {
    readonly schema: TSchema;
    readonly call: MikaApiOperationCall<z.infer<TSchema>>;
  },
): TDefinition & {
  readonly schema: TSchema;
  readonly call: MikaApiOperationCall<z.infer<TSchema>>;
};
function defineMikaOperation<const TDefinition extends MikaApiOperationBaseDefinition>(
  definition: TDefinition & {
    readonly schema?: undefined;
    readonly call: MikaApiOperationCall<undefined>;
  },
): TDefinition & {
  readonly schema?: undefined;
  readonly call: MikaApiOperationCall<undefined>;
};
function defineMikaOperation(definition: MikaApiOperationDefinition): MikaApiOperationDefinition {
  return definition;
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
});

type MikaAgentOperationMetadataInput = Omit<
  MikaAgentOperationMetadata,
  "scopes" | "requiredProofs"
> &
  Partial<Pick<MikaAgentOperationMetadata, "scopes" | "requiredProofs">>;

const hostOwnedIdempotencyKey = {
  keyHeader: MIKA_AGENT_IDEMPOTENCY_KEY_HEADER,
  scope: "actor_operation_resource_input",
  replay: "same_key_same_input",
  owner: "host",
} as const satisfies MikaAgentIdempotencyMetadata;

function defineAgentOperationMetadata<
  const TDefinitions extends Record<string, MikaAgentOperationMetadataInput>,
>(
  definitions: TDefinitions,
): { readonly [TKey in keyof TDefinitions]: MikaAgentOperationMetadata } {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [
      key,
      {
        ...definition,
        scopes: definition.scopes ?? [definition.capability],
        requiredProofs: definition.requiredProofs ?? [],
        ...(definition.idempotency === "not_needed" || definition.idempotencyKey
          ? {}
          : { idempotencyKey: hostOwnedIdempotencyKey }),
      },
    ]),
  ) as { readonly [TKey in keyof TDefinitions]: MikaAgentOperationMetadata };
}

const agentOperationMetadata = defineAgentOperationMetadata({
  catalogRead: {
    visible: "public",
    capability: "catalog:read",
    effect: "read",
    risk: "none",
    requiresActor: "none",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["sellable", "price"],
  },
  stockRead: {
    visible: "public",
    capability: "stock:read",
    effect: "read",
    risk: "none",
    requiresActor: "none",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["stock", "sellable"],
  },
  cartRead: {
    visible: "trusted",
    capability: "cart:read",
    effect: "read",
    risk: "low",
    requiresActor: "session",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["cart"],
  },
  cartQuote: {
    visible: "trusted",
    capability: "cart:read",
    effect: "read",
    risk: "low",
    requiresActor: "session",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["cart", "sellable", "price", "stock"],
  },
  cartWrite: {
    visible: "trusted",
    capability: "cart:write",
    effect: "cart_mutation",
    risk: "low",
    requiresActor: "session",
    confirmation: "host",
    idempotency: "recommended",
    resources: ["cart", "sellable", "price"],
  },
  wishlistRead: {
    visible: "trusted",
    capability: "wishlist:read",
    effect: "read",
    risk: "low",
    requiresActor: "session",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["wishlist"],
  },
  wishlistWrite: {
    visible: "trusted",
    capability: "wishlist:write",
    effect: "wishlist_mutation",
    risk: "low",
    requiresActor: "session",
    confirmation: "host",
    idempotency: "recommended",
    resources: ["wishlist", "sellable", "price"],
  },
  checkoutHandoff: {
    visible: "trusted",
    capability: "checkout:start",
    effect: "checkout_handoff",
    risk: "purchase",
    requiresActor: "session",
    confirmation: "payment",
    idempotency: "required",
    resources: ["checkout", "cart", "sellable", "price"],
    acceptsProofs: ["consent", "mandate", "payment_authorization"],
  },
  checkoutPreview: {
    visible: "trusted",
    capability: "checkout:read",
    effect: "read",
    risk: "purchase",
    requiresActor: "session",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["checkout", "cart", "sellable", "price"],
    acceptsProofs: ["consent", "mandate", "payment_authorization"],
  },
  checkoutRead: {
    visible: "trusted",
    capability: "checkout:read",
    effect: "read",
    risk: "purchase",
    requiresActor: "session",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["checkout"],
  },
  magicLinkWrite: {
    visible: "trusted",
    capability: "magic_link:write",
    effect: "account_mutation",
    risk: "account",
    requiresActor: "none",
    confirmation: "host",
    idempotency: "recommended",
    resources: ["account"],
  },
  accountRead: {
    visible: "trusted",
    capability: "account:read",
    effect: "read",
    risk: "account",
    requiresActor: "customer",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["account", "order", "subscription", "download"],
  },
  accountWrite: {
    visible: "trusted",
    capability: "account:write",
    effect: "account_mutation",
    risk: "account",
    requiresActor: "customer",
    confirmation: "user",
    idempotency: "recommended",
    resources: ["account"],
  },
  subscriptionWrite: {
    visible: "trusted",
    capability: "subscription:write",
    effect: "subscription_mutation",
    risk: "account",
    requiresActor: "customer",
    confirmation: "user",
    idempotency: "required",
    resources: ["subscription", "account"],
  },
  downloadRead: {
    visible: "trusted",
    capability: "download:read",
    effect: "download_resolution",
    risk: "low",
    requiresActor: "none",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["download"],
    acceptsProofs: ["receipt"],
  },
  orderRead: {
    visible: "trusted",
    capability: "order:read",
    effect: "read",
    risk: "account",
    requiresActor: "customer",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["order"],
  },
  webhookReceive: {
    visible: "hidden",
    capability: "webhook:receive",
    effect: "webhook_ingest",
    risk: "admin",
    requiresActor: "service",
    confirmation: "none",
    idempotency: "required",
    resources: ["webhook"],
  },
  adminRead: {
    visible: "admin",
    capability: "admin:read",
    effect: "read",
    risk: "admin",
    requiresActor: "admin",
    confirmation: "none",
    idempotency: "not_needed",
    resources: ["admin"],
  },
  adminWrite: {
    visible: "admin",
    capability: "admin:write",
    effect: "admin_mutation",
    risk: "admin",
    requiresActor: "admin",
    confirmation: "user",
    idempotency: "required",
    resources: ["admin"],
  },
});

export const mikaOperationDefinitions = {
  catalogSellables: defineMikaOperation({
    name: "catalog.sellables",
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
    action: {
      key: "catalogSellables",
      name: "catalog.sellables",
      accept: "json",
      schema: contentRefInputSchema,
    },
    call: (api, _ctx, input) => api.catalog.sellables({ contentRef: input }),
  }),
  stockAvailability: defineMikaOperation({
    name: "stock.availability",
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
    action: {
      key: "stockAvailability",
      name: "stock.availability",
      accept: "json",
      schema: stockAvailabilityInputSchema,
    },
    call: (api, _ctx, input) => api.stock.availability(input),
  }),
  cartGet: defineMikaOperation({
    name: "cart.get",
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
    name: "cart.quote",
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
    name: "cart.add",
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
    action: {
      key: "cartAdd",
      name: "cart.add",
      accept: "form",
      schema: cartAddFormInputSchema,
    },
    call: (api, ctx, input) => api.cart.add(ctx, input),
  }),
  cartUpdate: defineMikaOperation({
    name: "cart.update",
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
    action: {
      key: "cartUpdate",
      name: "cart.update",
      accept: "form",
      schema: updateCartItemInputSchema,
    },
    call: (api, ctx, input) => api.cart.update(ctx, input),
  }),
  cartRemove: defineMikaOperation({
    name: "cart.remove",
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
    action: {
      key: "cartRemove",
      name: "cart.remove",
      accept: "form",
      schema: removeCartItemInputSchema,
    },
    call: (api, ctx, input) => api.cart.remove(ctx, input),
  }),
  cartMerge: defineMikaOperation({
    name: "cart.merge",
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
    action: {
      key: "cartMerge",
      name: "cart.merge",
      accept: "form",
      schema: mergeCartInputSchema,
    },
    call: (api, ctx, input) => api.cart.merge(ctx, input),
  }),
  cartApplyCoupon: defineMikaOperation({
    name: "cart.applyCoupon",
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
    action: {
      key: "cartApplyCoupon",
      name: "cart.applyCoupon",
      accept: "form",
      schema: applyCouponInputSchema,
    },
    call: (api, ctx, input) => api.cart.applyCoupon(ctx, input),
  }),
  cartRemoveCoupon: defineMikaOperation({
    name: "cart.removeCoupon",
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
    action: {
      key: "cartRemoveCoupon",
      name: "cart.removeCoupon",
      accept: "form",
      schema: removeCouponInputSchema,
    },
    call: (api, ctx, input) => api.cart.removeCoupon(ctx, input),
  }),
  wishlistGet: defineMikaOperation({
    name: "wishlist.get",
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
    name: "wishlist.add",
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
    action: {
      key: "wishlistAdd",
      name: "wishlist.add",
      accept: "form",
      schema: wishlistItemInputSchema,
    },
    call: (api, ctx, input) => api.wishlist.add(ctx, input),
  }),
  wishlistRemove: defineMikaOperation({
    name: "wishlist.remove",
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
    action: {
      key: "wishlistRemove",
      name: "wishlist.remove",
      accept: "form",
      schema: removeWishlistItemInputSchema,
    },
    call: (api, ctx, input) => api.wishlist.remove(ctx, input),
  }),
  wishlistMoveToCart: defineMikaOperation({
    name: "wishlist.moveToCart",
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
    action: {
      key: "wishlistMoveToCart",
      name: "wishlist.moveToCart",
      accept: "form",
      schema: moveWishlistItemToCartInputSchema,
    },
    call: (api, ctx, input) => api.wishlist.moveToCart(ctx, input),
  }),
  wishlistSaveForLater: defineMikaOperation({
    name: "wishlist.saveForLater",
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
    action: {
      key: "wishlistSaveForLater",
      name: "wishlist.saveForLater",
      accept: "form",
      schema: saveCartLineForLaterInputSchema,
    },
    call: (api, ctx, input) => api.wishlist.saveForLater(ctx, input),
  }),
  wishlistMerge: defineMikaOperation({
    name: "wishlist.merge",
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
    action: {
      key: "wishlistMerge",
      name: "wishlist.merge",
      accept: "form",
      schema: mergeWishlistInputSchema,
    },
    call: (api, ctx, input) => api.wishlist.merge(ctx, input),
  }),
  checkoutStart: defineMikaOperation({
    name: "checkout.start",
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
    action: {
      key: "checkoutStart",
      name: "checkout.start",
      accept: "form",
      schema: checkoutStartFormInputSchema,
    },
    call: (api, ctx, input) => api.checkout.start(ctx, input),
  }),
  checkoutPreview: defineMikaOperation({
    name: "checkout.preview",
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
    name: "checkout.status",
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
    action: {
      key: "checkoutStatus",
      name: "checkout.status",
      accept: "json",
      schema: checkoutStatusInputSchema,
    },
    call: (api, _ctx, input) => api.checkout.status(input),
  }),
  magicLinkRequest: defineMikaOperation({
    name: "magicLink.request",
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
    action: {
      key: "magicLinkRequest",
      name: "magicLink.request",
      accept: "form",
      schema: magicLinkRequestInputSchema,
    },
    call: (api, ctx, input) => api.magicLink.request(ctx, input),
  }),
  magicLinkVerify: defineMikaOperation({
    name: "magicLink.verify",
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
    action: {
      key: "magicLinkVerify",
      name: "magicLink.verify",
      accept: "form",
      schema: magicLinkVerifyInputSchema,
    },
    call: (api, ctx, input) => api.magicLink.verify(ctx, input),
  }),
  accountGet: defineMikaOperation({
    name: "account.get",
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
    name: "account.export",
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
    action: {
      key: "accountExport",
      name: "account.export",
      accept: "form",
      schema: returnToInputSchema,
    },
    call: (api, ctx, input) => api.account.export(ctx, input),
  }),
  accountExportStatus: defineMikaOperation({
    name: "account.exportStatus",
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
    action: {
      key: "accountExportStatus",
      name: "account.exportStatus",
      accept: "json",
      schema: accountExportStatusInputSchema,
    },
    call: (api, ctx, input) => api.account.exportStatus(ctx, input),
  }),
  accountExportDownload: defineMikaOperation({
    name: "account.exportDownload",
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
    name: "account.delete",
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
    action: {
      key: "accountDelete",
      name: "account.delete",
      accept: "form",
      schema: returnToInputSchema,
    },
    call: (api, ctx, input) => api.account.delete(ctx, input),
  }),
  accountPortal: defineMikaOperation({
    name: "account.portal",
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
    action: {
      key: "accountPortal",
      name: "account.portal",
      accept: "form",
      schema: returnToInputSchema,
    },
    call: (api, ctx, input) => api.account.portal(ctx, input),
  }),
  subscriptionCancel: defineMikaOperation({
    name: "subscription.cancel",
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
    action: {
      key: "subscriptionCancel",
      name: "subscription.cancel",
      accept: "form",
      schema: subscriptionCancelInputSchema,
    },
    call: (api, ctx, input) => api.subscription.cancel(ctx, input),
  }),
  subscriptionChange: defineMikaOperation({
    name: "subscription.change",
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
    action: {
      key: "subscriptionChange",
      name: "subscription.change",
      accept: "form",
      schema: subscriptionChangeInputSchema,
    },
    call: (api, ctx, input) => api.subscription.change(ctx, input),
  }),
  subscriptionRenew: defineMikaOperation({
    name: "subscription.renew",
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
    action: {
      key: "subscriptionRenew",
      name: "subscription.renew",
      accept: "form",
      schema: subscriptionRenewInputSchema,
    },
    call: (api, ctx, input) => api.subscription.renew(ctx, input),
  }),
  downloadResolve: defineMikaOperation({
    name: "download.resolve",
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
    name: "order.invoice",
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
    name: "webhook.receive",
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
    name: "admin.providerHealth",
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
    name: "admin.providerSync",
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
    name: "admin.stockAdjust",
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
    name: "admin.releaseExpiredReservations",
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
    name: "admin.webhookReplay",
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
    name: "admin.orderRefund",
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
    name: "admin.orderCancel",
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
    name: "admin.entitlementGrant",
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
    name: "admin.entitlementRevoke",
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
    name: "admin.emailResend",
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
    name: "admin.licenseRevoke",
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
    name: "admin.downloadIssue",
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
} as const;

export type MikaApiOperation =
  (typeof mikaOperationDefinitions)[keyof typeof mikaOperationDefinitions];
export type MikaRouteOperation = MikaApiOperation;
export type MikaRouteOnlyDefinition =
  (typeof mikaRouteOnlyDefinitions)[keyof typeof mikaRouteOnlyDefinitions];

export const mikaRoutedOperationDefinitions = Object.values(
  mikaOperationDefinitions,
) as readonly MikaRouteOperation[];

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

export function callMikaOperation<TData = unknown>(
  operation: MikaApiOperation,
  api: MikaApi,
  ctx: MikaRequestContext,
  input: unknown,
): Promise<MikaApiResult<TData>> {
  // Dynamic route/action dispatch loses the schema-to-operation correlation after validation.
  const call = operation.call as MikaApiOperationCall<unknown>;
  return call(api, ctx, input) as Promise<MikaApiResult<TData>>;
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
