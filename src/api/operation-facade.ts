/**
 * Ergonomic typed facade over raw operation keys: namespace.method helpers with input normalizers.
 * Used by server clients and integration tests.
 */
import {
  normalizeAccountExportDownloadInput,
  normalizeAccountExportInput,
  normalizeMagicLinkVerifyInput,
} from "./input-normalizers";
import { mikaOperationDefinitions, type MikaApiOperationData } from "./operations";
import type {
  AccountDeleteInput,
  AccountExportDownloadInput,
  AccountExportInput,
  AccountExportStatusInput,
  AccountPortalInput,
  AddCartItemInput,
  ApplyCouponInput,
  CartQuoteInput,
  CheckoutCancelInput,
  CheckoutPreviewInput,
  CheckoutStatusInput,
  DownloadIssueInput,
  EmailResendInput,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  LicenseRevokeInput,
  MagicLinkRequestInput,
  MagicLinkVerifyInput,
  MergeCartInput,
  MergeWishlistInput,
  MoveWishlistItemToCartInput,
  OrderCancelInput,
  OrderInvoiceInput,
  OrderRefundInput,
  ProviderHealthInput,
  ProviderSyncInput,
  ReleaseExpiredReservationsInput,
  RemoveCartItemInput,
  RemoveCouponInput,
  RemoveWishlistItemInput,
  SaveCartLineForLaterInput,
  StartCheckoutInput,
  StockAdjustInput,
  SubscriptionActionInput,
  UpdateCartItemInput,
  WebhookReceiveInput,
  WebhookReplayInput,
  WishlistItemInput,
  MikaApiResult,
} from "./types";
import type { SellableId } from "../types/primitives";

type MikaOperationKey = keyof typeof mikaOperationDefinitions;
type MikaOperationDefinitionMap = typeof mikaOperationDefinitions;
type MikaFacadeOperationDefinitionKey = {
  readonly [TOperation in MikaOperationKey]: MikaOperationDefinitionMap[TOperation] extends {
    readonly apiMethod: false;
  }
    ? never
    : TOperation;
}[MikaOperationKey];
type MikaFacadeOperationDefinitionMap = Pick<
  MikaOperationDefinitionMap,
  MikaFacadeOperationDefinitionKey
>;
type MikaOperationDefinition = MikaFacadeOperationDefinitionMap[MikaFacadeOperationDefinitionKey];
type MikaOperationKeyFor<TNamespace extends string, TMethod extends string> = {
  readonly [TOperation in MikaFacadeOperationDefinitionKey]: MikaFacadeOperationDefinitionMap[TOperation] extends {
    readonly namespace: TNamespace;
    readonly method: TMethod;
  }
    ? TOperation
    : never;
}[MikaFacadeOperationDefinitionKey];
type MikaOperationFacadeSpec = {
  readonly [TNamespace in MikaOperationDefinition["namespace"]]: {
    readonly [TMethod in Extract<
      MikaOperationDefinition,
      { readonly namespace: TNamespace }
    >["method"]]: MikaOperationKeyFor<TNamespace, TMethod>;
  };
};

/**
 * Low-level operation invoker signature shared by every facade transport (plugin-route fetch
 * client, Astro server runner). Module-internal — not re-exported from any package entry.
 */
export type MikaFacadeInvoke = <TOperation extends MikaOperationKey>(
  operationKey: TOperation,
  input?: unknown,
) => Promise<MikaApiResult<MikaApiOperationData<(typeof mikaOperationDefinitions)[TOperation]>>>;

const emptyInput = () => ({});

/** Namespace/method tree mapping facade calls to {@link mikaOperationDefinitions} keys. */
export const mikaOperationFacadeSpec = collectMikaOperationFacadeSpec();

function collectMikaOperationFacadeSpec(): MikaOperationFacadeSpec {
  const spec: Record<string, Record<string, MikaOperationKey>> = {};

  for (const [key, operation] of Object.entries(mikaOperationDefinitions) as Array<
    [MikaOperationKey, (typeof mikaOperationDefinitions)[MikaOperationKey]]
  >) {
    if ("apiMethod" in operation && operation.apiMethod === false) continue;
    const namespaceSpec = (spec[operation.namespace] ??= {});
    if (namespaceSpec[operation.method]) {
      throw new Error(
        `Mika operation '${operation.namespace}.${operation.method}' is defined more than once.`,
      );
    }
    namespaceSpec[operation.method] = key as MikaFacadeOperationDefinitionKey;
  }

  return spec as MikaOperationFacadeSpec;
}
type MikaFacadeOperationKey<
  TNamespace extends keyof MikaOperationFacadeSpec,
  TMethod extends keyof MikaOperationFacadeSpec[TNamespace],
> = MikaOperationFacadeSpec[TNamespace][TMethod] & MikaOperationKey;
type MikaFacadeResult<
  TNamespace extends keyof MikaOperationFacadeSpec,
  TMethod extends keyof MikaOperationFacadeSpec[TNamespace],
> = Promise<
  MikaApiResult<
    MikaApiOperationData<
      (typeof mikaOperationDefinitions)[MikaFacadeOperationKey<TNamespace, TMethod>]
    >
  >
>;

/** Storefront and account operations exposed as nested async methods. */
export interface MikaOperationFacade {
  readonly catalog: {
    sellables(
      collection: string,
      id: string,
      options?: { readonly locale?: string },
    ): MikaFacadeResult<"catalog", "sellables">;
  };
  readonly stock: {
    availability(sellableId: SellableId): MikaFacadeResult<"stock", "availability">;
  };
  readonly cart: {
    get(): MikaFacadeResult<"cart", "get">;
    quote(input?: CartQuoteInput): MikaFacadeResult<"cart", "quote">;
    add(input: AddCartItemInput): MikaFacadeResult<"cart", "add">;
    update(input: UpdateCartItemInput): MikaFacadeResult<"cart", "update">;
    remove(input: RemoveCartItemInput): MikaFacadeResult<"cart", "remove">;
    merge(input?: MergeCartInput): MikaFacadeResult<"cart", "merge">;
    applyCoupon(input: ApplyCouponInput): MikaFacadeResult<"cart", "applyCoupon">;
    removeCoupon(input?: RemoveCouponInput): MikaFacadeResult<"cart", "removeCoupon">;
  };
  readonly wishlist: {
    get(): MikaFacadeResult<"wishlist", "get">;
    add(input: WishlistItemInput): MikaFacadeResult<"wishlist", "add">;
    remove(input: RemoveWishlistItemInput): MikaFacadeResult<"wishlist", "remove">;
    moveToCart(input: MoveWishlistItemToCartInput): MikaFacadeResult<"wishlist", "moveToCart">;
    saveForLater(input: SaveCartLineForLaterInput): MikaFacadeResult<"wishlist", "saveForLater">;
    merge(input?: MergeWishlistInput): MikaFacadeResult<"wishlist", "merge">;
  };
  readonly checkout: {
    start(input?: StartCheckoutInput): MikaFacadeResult<"checkout", "start">;
    preview(input?: CheckoutPreviewInput): MikaFacadeResult<"checkout", "preview">;
    status(input: CheckoutStatusInput): MikaFacadeResult<"checkout", "status">;
    cancel(input: CheckoutCancelInput): MikaFacadeResult<"checkout", "cancel">;
  };
  readonly magicLink: {
    request(input: MagicLinkRequestInput): MikaFacadeResult<"magicLink", "request">;
    verify(input: MagicLinkVerifyInput | string): MikaFacadeResult<"magicLink", "verify">;
  };
  readonly account: {
    get(): MikaFacadeResult<"account", "get">;
    export(input?: AccountExportInput): MikaFacadeResult<"account", "export">;
    exportStatus(
      input: AccountExportStatusInput | string,
    ): MikaFacadeResult<"account", "exportStatus">;
    exportDownload(
      input: AccountExportDownloadInput | string,
    ): MikaFacadeResult<"account", "exportDownload">;
    delete(input?: AccountDeleteInput): MikaFacadeResult<"account", "delete">;
    portal(input?: AccountPortalInput | string): MikaFacadeResult<"account", "portal">;
  };
  readonly subscription: {
    cancel(input: SubscriptionActionInput): MikaFacadeResult<"subscription", "cancel">;
    change(input: SubscriptionActionInput): MikaFacadeResult<"subscription", "change">;
    renew(input: SubscriptionActionInput): MikaFacadeResult<"subscription", "renew">;
  };
  readonly download: {
    resolve(token: string): MikaFacadeResult<"download", "resolve">;
    confirm(token: string): MikaFacadeResult<"download", "confirm">;
  };
  readonly order: {
    invoice(input: OrderInvoiceInput): MikaFacadeResult<"order", "invoice">;
  };
}

/** Webhook ingest surface (typically server-only). */
export interface MikaOperationWebhookFacade {
  readonly webhook: {
    receive(input: WebhookReceiveInput): MikaFacadeResult<"webhook", "receive">;
  };
}

/** Admin mutation surface (typically server-only). */
export interface MikaOperationAdminFacade {
  readonly admin: {
    providerHealth(input?: ProviderHealthInput): MikaFacadeResult<"admin", "providerHealth">;
    providerSync(input?: ProviderSyncInput): MikaFacadeResult<"admin", "providerSync">;
    stockAdjust(input: StockAdjustInput): MikaFacadeResult<"admin", "stockAdjust">;
    releaseExpiredReservations(
      input?: ReleaseExpiredReservationsInput,
    ): MikaFacadeResult<"admin", "releaseExpiredReservations">;
    webhookReplay(input: WebhookReplayInput): MikaFacadeResult<"admin", "webhookReplay">;
    orderRefund(input: OrderRefundInput): MikaFacadeResult<"admin", "orderRefund">;
    orderCancel(input: OrderCancelInput): MikaFacadeResult<"admin", "orderCancel">;
    entitlementGrant(input: EntitlementGrantInput): MikaFacadeResult<"admin", "entitlementGrant">;
    entitlementRevoke(
      input: EntitlementRevokeInput,
    ): MikaFacadeResult<"admin", "entitlementRevoke">;
    emailResend(input: EmailResendInput): MikaFacadeResult<"admin", "emailResend">;
    licenseRevoke(input: LicenseRevokeInput): MikaFacadeResult<"admin", "licenseRevoke">;
    downloadIssue(input: DownloadIssueInput): MikaFacadeResult<"admin", "downloadIssue">;
  };
}

/** Full facade including webhook and admin namespaces. */
export type MikaServerOperationFacade = MikaOperationFacade &
  MikaOperationWebhookFacade &
  MikaOperationAdminFacade;

/**
 * Bidirectional pin: hand {@link MikaServerOperationFacade} namespaces/methods match
 * registry-derived {@link mikaOperationFacadeSpec} (from ops with `apiMethod !== false`).
 */
type MikaFacadeRegistryDrift =
  | {
      readonly [K in keyof MikaOperationFacadeSpec]: Exclude<
        keyof MikaOperationFacadeSpec[K],
        K extends keyof MikaServerOperationFacade ? keyof MikaServerOperationFacade[K] : never
      >;
    }[keyof MikaOperationFacadeSpec]
  | {
      readonly [K in keyof MikaServerOperationFacade]: Exclude<
        keyof MikaServerOperationFacade[K],
        K extends keyof MikaOperationFacadeSpec ? keyof MikaOperationFacadeSpec[K] : never
      >;
    }[keyof MikaServerOperationFacade]
  | Exclude<keyof MikaOperationFacadeSpec, keyof MikaServerOperationFacade>
  | Exclude<keyof MikaServerOperationFacade, keyof MikaOperationFacadeSpec>;

type _AssertMikaFacadePinnedToRegistry = MikaFacadeRegistryDrift extends never
  ? true
  : MikaFacadeRegistryDrift;
const _assertMikaFacadePinnedToRegistry: _AssertMikaFacadePinnedToRegistry = true;
void _assertMikaFacadePinnedToRegistry;

type MikaOperationFacadeForOptions<TOptions extends MikaOperationFacadeOptions | undefined> =
  MikaOperationFacade &
    (TOptions extends { readonly includeWebhook: true } ? MikaOperationWebhookFacade : {}) &
    (TOptions extends { readonly includeAdmin: true } ? MikaOperationAdminFacade : {});
type Writable<TValue> = {
  -readonly [TKey in keyof TValue]: TValue[TKey];
};

/** Options controlling locale defaults and optional namespace inclusion. */
export interface MikaOperationFacadeOptions {
  readonly locale?: string;
  /** Exposes the admin namespace; intended for server-side clients only. */
  readonly includeAdmin?: boolean;
  /** Exposes webhook.receive; intended for server-side ingest routes. */
  readonly includeWebhook?: boolean;
}

/** Builds a typed facade from a low-level operation invoker function. */
export function createMikaOperationFacade<
  const TOptions extends MikaOperationFacadeOptions | undefined = undefined,
>(invoke: MikaFacadeInvoke, options?: TOptions): MikaOperationFacadeForOptions<TOptions> {
  const resolvedOptions: MikaOperationFacadeOptions = options ?? {};
  const facade: Writable<
    MikaOperationFacade & Partial<MikaOperationWebhookFacade> & Partial<MikaOperationAdminFacade>
  > = {
    catalog: {
      sellables: (
        collection: string,
        id: string,
        catalogOptions: { readonly locale?: string } = {},
      ) =>
        invoke(mikaOperationFacadeSpec.catalog.sellables, {
          collection,
          id,
          locale: catalogOptions.locale ?? resolvedOptions.locale,
        }),
    },
    stock: {
      availability: (sellableId: SellableId) =>
        invoke(mikaOperationFacadeSpec.stock.availability, { sellableId }),
    },
    cart: {
      get: () => invoke(mikaOperationFacadeSpec.cart.get),
      quote: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.cart.quote, input),
      add: (input: unknown) => invoke(mikaOperationFacadeSpec.cart.add, input),
      update: (input: unknown) => invoke(mikaOperationFacadeSpec.cart.update, input),
      remove: (input: unknown) => invoke(mikaOperationFacadeSpec.cart.remove, input),
      merge: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.cart.merge, input),
      applyCoupon: (input: unknown) => invoke(mikaOperationFacadeSpec.cart.applyCoupon, input),
      removeCoupon: (input = emptyInput()) =>
        invoke(mikaOperationFacadeSpec.cart.removeCoupon, input),
    },
    wishlist: {
      get: () => invoke(mikaOperationFacadeSpec.wishlist.get),
      add: (input: unknown) => invoke(mikaOperationFacadeSpec.wishlist.add, input),
      remove: (input: unknown) => invoke(mikaOperationFacadeSpec.wishlist.remove, input),
      moveToCart: (input: unknown) => invoke(mikaOperationFacadeSpec.wishlist.moveToCart, input),
      saveForLater: (input: unknown) =>
        invoke(mikaOperationFacadeSpec.wishlist.saveForLater, input),
      merge: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.wishlist.merge, input),
    },
    checkout: {
      start: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.checkout.start, input),
      preview: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.checkout.preview, input),
      status: (input) => invoke(mikaOperationFacadeSpec.checkout.status, input),
      cancel: (input) => invoke(mikaOperationFacadeSpec.checkout.cancel, input),
    },
    magicLink: {
      request: (input) => invoke(mikaOperationFacadeSpec.magicLink.request, input),
      verify: (input) =>
        invoke(mikaOperationFacadeSpec.magicLink.verify, normalizeMagicLinkVerifyInput(input)),
    },
    account: {
      get: () => invoke(mikaOperationFacadeSpec.account.get),
      export: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.account.export, input),
      exportStatus: (input) =>
        invoke(mikaOperationFacadeSpec.account.exportStatus, normalizeAccountExportInput(input)),
      exportDownload: (input) =>
        invoke(
          mikaOperationFacadeSpec.account.exportDownload,
          normalizeAccountExportDownloadInput(input),
        ),
      delete: (input = emptyInput()) => invoke(mikaOperationFacadeSpec.account.delete, input),
      portal: (input = emptyInput()) =>
        invoke(
          mikaOperationFacadeSpec.account.portal,
          typeof input === "string" ? { returnTo: input } : input,
        ),
    },
    subscription: {
      cancel: (input: unknown) => invoke(mikaOperationFacadeSpec.subscription.cancel, input),
      change: (input: unknown) => invoke(mikaOperationFacadeSpec.subscription.change, input),
      renew: (input: unknown) => invoke(mikaOperationFacadeSpec.subscription.renew, input),
    },
    download: {
      resolve: (token: string) => invoke(mikaOperationFacadeSpec.download.resolve, { token }),
      confirm: (token: string) => invoke(mikaOperationFacadeSpec.download.confirm, { token }),
    },
    order: {
      invoice: (input) => invoke(mikaOperationFacadeSpec.order.invoice, input),
    },
  };

  if (resolvedOptions.includeWebhook) {
    const webhookFacade: MikaOperationWebhookFacade["webhook"] = {
      receive: (input) => invoke(mikaOperationFacadeSpec.webhook.receive, input),
    };
    facade.webhook = webhookFacade;
  }

  if (resolvedOptions.includeAdmin) {
    const adminFacade: MikaOperationAdminFacade["admin"] = {
      providerHealth: (input = emptyInput()) =>
        invoke(mikaOperationFacadeSpec.admin.providerHealth, input),
      providerSync: (input = emptyInput()) =>
        invoke(mikaOperationFacadeSpec.admin.providerSync, input),
      stockAdjust: (input) => invoke(mikaOperationFacadeSpec.admin.stockAdjust, input),
      releaseExpiredReservations: (input = emptyInput()) =>
        invoke(mikaOperationFacadeSpec.admin.releaseExpiredReservations, input),
      webhookReplay: (input) => invoke(mikaOperationFacadeSpec.admin.webhookReplay, input),
      orderRefund: (input) => invoke(mikaOperationFacadeSpec.admin.orderRefund, input),
      orderCancel: (input) => invoke(mikaOperationFacadeSpec.admin.orderCancel, input),
      entitlementGrant: (input) => invoke(mikaOperationFacadeSpec.admin.entitlementGrant, input),
      entitlementRevoke: (input) => invoke(mikaOperationFacadeSpec.admin.entitlementRevoke, input),
      emailResend: (input) => invoke(mikaOperationFacadeSpec.admin.emailResend, input),
      licenseRevoke: (input) => invoke(mikaOperationFacadeSpec.admin.licenseRevoke, input),
      downloadIssue: (input) => invoke(mikaOperationFacadeSpec.admin.downloadIssue, input),
    };
    facade.admin = adminFacade;
  }

  return facade as MikaOperationFacadeForOptions<TOptions>;
}
