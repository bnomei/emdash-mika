import { createMikaClient, type MikaClient, type MikaClientOptions } from "./client";
import {
  mikaOperationDefinitions,
  type MikaApiOperationData,
  type MikaRouteOperation,
} from "./operations";
import {
  normalizeAccountExportDownloadInput,
  normalizeAccountExportInput,
  normalizeMagicLinkVerifyInput,
  normalizeOrderInvoiceInput,
} from "./input-normalizers";
import { requestMika } from "./request";
import type { MikaRequestInit } from "./request";
import { createMikaPluginRouteBuilder, type MikaPluginRouteBuilder } from "./routes";
import type {
  AccountDTO,
  AccountDeleteInput,
  AccountExportDTO,
  AccountExportDownloadDTO,
  AccountExportDownloadInput,
  AccountExportInput,
  AccountExportStatusInput,
  AccountPortalInput,
  AddCartItemInput,
  AdminActionResultDTO,
  ApplyCouponInput,
  CartDTO,
  CartQuoteDTO,
  CartQuoteInput,
  CheckoutPreviewDTO,
  CheckoutPreviewInput,
  CheckoutSessionDTO,
  DownloadResolutionDTO,
  DownloadIssueInput,
  EmailResendInput,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  LicenseRevokeInput,
  MagicLinkRequestInput,
  MagicLinkVerifyInput,
  MikaApiResult,
  MergeCartInput,
  MergeWishlistInput,
  MoveWishlistItemToCartInput,
  OrderCancelInput,
  OrderInvoiceDTO,
  OrderInvoiceInput,
  OrderRefundInput,
  ProviderHealthDTO,
  ProviderHealthInput,
  ProviderSyncInput,
  ReleaseExpiredReservationsInput,
  RemoveCartItemInput,
  RemoveCouponInput,
  RemoveWishlistItemInput,
  SaveCartLineForLaterInput,
  StockAdjustInput,
  StartCheckoutInput,
  SubscriptionActionInput,
  UpdateCartItemInput,
  WebhookReceiveDTO,
  WebhookReceiveInput,
  WebhookReplayInput,
  WishlistDTO,
  WishlistItemInput,
} from "./types";
import type { MikaPluginRouteName } from "./routes";

export interface MikaServerClientOptions extends MikaClientOptions {
  readonly forwardCrossOriginCookies?: boolean;
}

export interface MikaServerClient extends Omit<MikaClient, "routes"> {
  readonly routes: MikaPluginRouteBuilder;
  readonly cart: {
    get(): Promise<MikaApiResult<CartDTO>>;
    quote(input?: CartQuoteInput): Promise<MikaApiResult<CartQuoteDTO>>;
    add(input: AddCartItemInput): Promise<MikaApiResult<CartDTO>>;
    update(input: UpdateCartItemInput): Promise<MikaApiResult<CartDTO>>;
    remove(input: RemoveCartItemInput): Promise<MikaApiResult<CartDTO>>;
    merge(input?: MergeCartInput): Promise<MikaApiResult<CartDTO>>;
    applyCoupon(input: ApplyCouponInput): Promise<MikaApiResult<CartDTO>>;
    removeCoupon(input?: RemoveCouponInput): Promise<MikaApiResult<CartDTO>>;
  };
  readonly wishlist: {
    get(): Promise<MikaApiResult<WishlistDTO>>;
    add(input: WishlistItemInput): Promise<MikaApiResult<WishlistDTO>>;
    remove(input: RemoveWishlistItemInput): Promise<MikaApiResult<WishlistDTO>>;
    moveToCart(input: MoveWishlistItemToCartInput): Promise<MikaApiResult<CartDTO>>;
    saveForLater(input: SaveCartLineForLaterInput): Promise<MikaApiResult<WishlistDTO>>;
    merge(input?: MergeWishlistInput): Promise<MikaApiResult<WishlistDTO>>;
  };
  readonly checkout: {
    start(input?: StartCheckoutInput): Promise<MikaApiResult<CheckoutSessionDTO>>;
    preview(input?: CheckoutPreviewInput): Promise<MikaApiResult<CheckoutPreviewDTO>>;
    status(checkoutId: string): Promise<MikaApiResult<CheckoutSessionDTO>>;
  };
  readonly magicLink: {
    request(input: MagicLinkRequestInput): Promise<MikaApiResult<{ sent: boolean }>>;
    verify(input: MagicLinkVerifyInput | string): Promise<MikaApiResult<AccountDTO>>;
  };
  readonly account: {
    get(): Promise<MikaApiResult<AccountDTO>>;
    export(input?: AccountExportInput): Promise<MikaApiResult<AccountExportDTO>>;
    exportStatus(
      input: AccountExportStatusInput | string,
    ): Promise<MikaApiResult<AccountExportDTO>>;
    exportDownload(
      input: AccountExportDownloadInput | string,
    ): Promise<MikaApiResult<AccountExportDownloadDTO>>;
    delete(input?: AccountDeleteInput): Promise<MikaApiResult<{ requested: boolean }>>;
    portal(input?: AccountPortalInput | string): Promise<MikaApiResult<{ redirectUrl: string }>>;
  };
  readonly subscription: {
    cancel(input: SubscriptionActionInput): Promise<MikaApiResult<AccountDTO>>;
    change(input: SubscriptionActionInput): Promise<MikaApiResult<AccountDTO>>;
    renew(input: SubscriptionActionInput): Promise<MikaApiResult<AccountDTO>>;
  };
  readonly download: {
    resolve(token: string): Promise<MikaApiResult<DownloadResolutionDTO>>;
  };
  readonly order: {
    invoice(input: OrderInvoiceInput | string): Promise<MikaApiResult<OrderInvoiceDTO>>;
  };
  readonly webhook: {
    receive(input: WebhookReceiveInput): Promise<MikaApiResult<WebhookReceiveDTO>>;
  };
  readonly admin: {
    providerHealth(input?: ProviderHealthInput): Promise<MikaApiResult<ProviderHealthDTO>>;
    providerSync(input?: ProviderSyncInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    stockAdjust(input: StockAdjustInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    releaseExpiredReservations(
      input?: ReleaseExpiredReservationsInput,
    ): Promise<MikaApiResult<AdminActionResultDTO>>;
    webhookReplay(input: WebhookReplayInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    orderRefund(input: OrderRefundInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    orderCancel(input: OrderCancelInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    entitlementGrant(input: EntitlementGrantInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    entitlementRevoke(input: EntitlementRevokeInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    emailResend(input: EmailResendInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    licenseRevoke(input: LicenseRevokeInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    downloadIssue(input: DownloadIssueInput): Promise<MikaApiResult<AdminActionResultDTO>>;
  };
}

export function createMikaServerClient(options: MikaServerClientOptions = {}): MikaServerClient {
  const request = <TData>(route: MikaPluginRouteName, init: MikaRequestInit = {}) =>
    requestMika<TData>(route, init, options);
  const requestOperation = <TOperation extends MikaRouteOperation>(
    operation: TOperation,
    input?: unknown,
  ) =>
    request<MikaApiOperationData<TOperation>>(
      operation.routeKey as MikaPluginRouteName,
      operationRequestInit(operation, input),
    );
  const routes = createMikaPluginRouteBuilder({
    apiBase: options.apiBase,
    pluginId: options.pluginId,
    origin: options.baseUrl ?? options.request?.url,
  });

  return {
    ...createMikaClient(options),
    routes,
    cart: {
      get: () => requestOperation(mikaOperationDefinitions.cartGet),
      quote: (input = {}) => requestOperation(mikaOperationDefinitions.cartQuote, input),
      add: (input) => requestOperation(mikaOperationDefinitions.cartAdd, input),
      update: (input) => requestOperation(mikaOperationDefinitions.cartUpdate, input),
      remove: (input) => requestOperation(mikaOperationDefinitions.cartRemove, input),
      merge: (input = {}) => requestOperation(mikaOperationDefinitions.cartMerge, input),
      applyCoupon: (input) => requestOperation(mikaOperationDefinitions.cartApplyCoupon, input),
      removeCoupon: (input = {}) =>
        requestOperation(mikaOperationDefinitions.cartRemoveCoupon, input),
    },
    wishlist: {
      get: () => requestOperation(mikaOperationDefinitions.wishlistGet),
      add: (input) => requestOperation(mikaOperationDefinitions.wishlistAdd, input),
      remove: (input) => requestOperation(mikaOperationDefinitions.wishlistRemove, input),
      moveToCart: (input) => requestOperation(mikaOperationDefinitions.wishlistMoveToCart, input),
      saveForLater: (input) =>
        requestOperation(mikaOperationDefinitions.wishlistSaveForLater, input),
      merge: (input = {}) => requestOperation(mikaOperationDefinitions.wishlistMerge, input),
    },
    checkout: {
      start: (input = {}) => requestOperation(mikaOperationDefinitions.checkoutStart, input),
      preview: (input = {}) => requestOperation(mikaOperationDefinitions.checkoutPreview, input),
      status: (checkoutId) =>
        requestOperation(mikaOperationDefinitions.checkoutStatus, { checkoutId }),
    },
    magicLink: {
      request: (input) => requestOperation(mikaOperationDefinitions.magicLinkRequest, input),
      verify: (input) =>
        requestOperation(
          mikaOperationDefinitions.magicLinkVerify,
          normalizeMagicLinkVerifyInput(input),
        ),
    },
    account: {
      get: () => requestOperation(mikaOperationDefinitions.accountGet),
      export: (input = {}) => requestOperation(mikaOperationDefinitions.accountExport, input),
      exportStatus: (input) =>
        requestOperation(
          mikaOperationDefinitions.accountExportStatus,
          normalizeAccountExportInput(input),
        ),
      exportDownload: (input) =>
        requestOperation(
          mikaOperationDefinitions.accountExportDownload,
          normalizeAccountExportDownloadInput(input),
        ),
      delete: (input = {}) => requestOperation(mikaOperationDefinitions.accountDelete, input),
      portal: (input = {}) =>
        requestOperation(
          mikaOperationDefinitions.accountPortal,
          typeof input === "string" ? { returnTo: input } : input,
        ),
    },
    subscription: {
      cancel: (input) => requestOperation(mikaOperationDefinitions.subscriptionCancel, input),
      change: (input) => requestOperation(mikaOperationDefinitions.subscriptionChange, input),
      renew: (input) => requestOperation(mikaOperationDefinitions.subscriptionRenew, input),
    },
    download: {
      resolve: (token) => requestOperation(mikaOperationDefinitions.downloadResolve, { token }),
    },
    order: {
      invoice: (input) =>
        requestOperation(mikaOperationDefinitions.orderInvoice, normalizeOrderInvoiceInput(input)),
    },
    webhook: {
      receive: (input) => requestOperation(mikaOperationDefinitions.webhookReceive, input),
    },
    admin: {
      providerHealth: (input = {}) =>
        requestOperation(mikaOperationDefinitions.adminProviderHealth, input),
      providerSync: (input = {}) =>
        requestOperation(mikaOperationDefinitions.adminProviderSync, input),
      stockAdjust: (input) => requestOperation(mikaOperationDefinitions.adminStockAdjust, input),
      releaseExpiredReservations: (input = {}) =>
        requestOperation(mikaOperationDefinitions.adminStockReleaseExpiredReservations, input),
      webhookReplay: (input) =>
        requestOperation(mikaOperationDefinitions.adminWebhookReplay, input),
      orderRefund: (input) => requestOperation(mikaOperationDefinitions.adminOrderRefund, input),
      orderCancel: (input) => requestOperation(mikaOperationDefinitions.adminOrderCancel, input),
      entitlementGrant: (input) =>
        requestOperation(mikaOperationDefinitions.adminEntitlementGrant, input),
      entitlementRevoke: (input) =>
        requestOperation(mikaOperationDefinitions.adminEntitlementRevoke, input),
      emailResend: (input) => requestOperation(mikaOperationDefinitions.adminEmailResend, input),
      licenseRevoke: (input) =>
        requestOperation(mikaOperationDefinitions.adminLicenseRevoke, input),
      downloadIssue: (input) =>
        requestOperation(mikaOperationDefinitions.adminDownloadIssue, input),
    },
  };
}

function operationRequestInit(operation: MikaRouteOperation, input: unknown): MikaRequestInit {
  if (operation.transport === "none") {
    return { method: operation.httpMethod };
  }

  if (operation.transport === "search") {
    return {
      method: operation.httpMethod,
      search: input as MikaRequestInit["search"],
    };
  }

  return {
    method: operation.httpMethod,
    body: input,
  };
}
