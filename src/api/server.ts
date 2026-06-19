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
  AvailabilityDTO,
  CartDTO,
  CartQuoteDTO,
  CartQuoteInput,
  CheckoutPreviewDTO,
  CheckoutPreviewInput,
  CheckoutSessionDTO,
  ContentRefDTO,
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
  SellableDTO,
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
import type { MikaRequestContext } from "./context";
import { mikaOperationApiMethodNames } from "./operations";

export interface MikaApi {
  readonly catalog: {
    sellables(input: {
      readonly contentRef: ContentRefDTO;
    }): Promise<MikaApiResult<readonly SellableDTO[]>>;
  };
  readonly stock: {
    availability(input: { readonly sellableId: string }): Promise<MikaApiResult<AvailabilityDTO>>;
  };
  readonly cart: {
    get(ctx: MikaRequestContext): Promise<MikaApiResult<CartDTO>>;
    quote(ctx: MikaRequestContext, input: CartQuoteInput): Promise<MikaApiResult<CartQuoteDTO>>;
    add(ctx: MikaRequestContext, input: AddCartItemInput): Promise<MikaApiResult<CartDTO>>;
    update(ctx: MikaRequestContext, input: UpdateCartItemInput): Promise<MikaApiResult<CartDTO>>;
    remove(ctx: MikaRequestContext, input: RemoveCartItemInput): Promise<MikaApiResult<CartDTO>>;
    merge(ctx: MikaRequestContext, input: MergeCartInput): Promise<MikaApiResult<CartDTO>>;
    applyCoupon(ctx: MikaRequestContext, input: ApplyCouponInput): Promise<MikaApiResult<CartDTO>>;
    removeCoupon(
      ctx: MikaRequestContext,
      input: RemoveCouponInput,
    ): Promise<MikaApiResult<CartDTO>>;
  };
  readonly wishlist: {
    get(ctx: MikaRequestContext): Promise<MikaApiResult<WishlistDTO>>;
    add(ctx: MikaRequestContext, input: WishlistItemInput): Promise<MikaApiResult<WishlistDTO>>;
    remove(
      ctx: MikaRequestContext,
      input: RemoveWishlistItemInput,
    ): Promise<MikaApiResult<WishlistDTO>>;
    moveToCart(
      ctx: MikaRequestContext,
      input: MoveWishlistItemToCartInput,
    ): Promise<MikaApiResult<CartDTO>>;
    saveForLater(
      ctx: MikaRequestContext,
      input: SaveCartLineForLaterInput,
    ): Promise<MikaApiResult<WishlistDTO>>;
    merge(ctx: MikaRequestContext, input: MergeWishlistInput): Promise<MikaApiResult<WishlistDTO>>;
  };
  readonly checkout: {
    start(
      ctx: MikaRequestContext,
      input: StartCheckoutInput,
    ): Promise<MikaApiResult<CheckoutSessionDTO>>;
    preview(
      ctx: MikaRequestContext,
      input: CheckoutPreviewInput,
    ): Promise<MikaApiResult<CheckoutPreviewDTO>>;
    status(input: { readonly checkoutId: string }): Promise<MikaApiResult<CheckoutSessionDTO>>;
  };
  readonly magicLink: {
    request(
      ctx: MikaRequestContext,
      input: MagicLinkRequestInput,
    ): Promise<MikaApiResult<{ sent: boolean }>>;
    verify(
      ctx: MikaRequestContext,
      input: MagicLinkVerifyInput,
    ): Promise<MikaApiResult<AccountDTO>>;
  };
  readonly account: {
    get(ctx: MikaRequestContext): Promise<MikaApiResult<AccountDTO>>;
    export(
      ctx: MikaRequestContext,
      input: AccountExportInput,
    ): Promise<MikaApiResult<AccountExportDTO>>;
    exportStatus(
      ctx: MikaRequestContext,
      input: AccountExportStatusInput,
    ): Promise<MikaApiResult<AccountExportDTO>>;
    exportDownload(
      ctx: MikaRequestContext,
      input: AccountExportDownloadInput,
    ): Promise<MikaApiResult<AccountExportDownloadDTO>>;
    delete(
      ctx: MikaRequestContext,
      input: AccountDeleteInput,
    ): Promise<MikaApiResult<{ requested: boolean }>>;
    portal(
      ctx: MikaRequestContext,
      input: AccountPortalInput,
    ): Promise<MikaApiResult<{ redirectUrl: string }>>;
  };
  readonly subscription: {
    cancel(
      ctx: MikaRequestContext,
      input: SubscriptionActionInput,
    ): Promise<MikaApiResult<AccountDTO>>;
    change(
      ctx: MikaRequestContext,
      input: SubscriptionActionInput,
    ): Promise<MikaApiResult<AccountDTO>>;
    renew(
      ctx: MikaRequestContext,
      input: SubscriptionActionInput,
    ): Promise<MikaApiResult<AccountDTO>>;
  };
  readonly download: {
    resolve(input: { readonly token: string }): Promise<MikaApiResult<DownloadResolutionDTO>>;
  };
  readonly order: {
    invoice(input: OrderInvoiceInput): Promise<MikaApiResult<OrderInvoiceDTO>>;
  };
  readonly webhook: {
    receive(
      ctx: MikaRequestContext,
      input: WebhookReceiveInput,
    ): Promise<MikaApiResult<WebhookReceiveDTO>>;
  };
  readonly admin: {
    providerHealth(input: ProviderHealthInput): Promise<MikaApiResult<ProviderHealthDTO>>;
    providerSync(input: ProviderSyncInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    stockAdjust(input: StockAdjustInput): Promise<MikaApiResult<AdminActionResultDTO>>;
    releaseExpiredReservations(
      input: ReleaseExpiredReservationsInput,
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

export type MikaApiOverrides = {
  readonly [K in keyof MikaApi]?: Partial<MikaApi[K]>;
};

type MikaApiMethodNameMap = {
  readonly [K in keyof MikaApi]: readonly (keyof MikaApi[K])[];
};

type MissingMikaApiMethods<TNames extends MikaApiMethodNameMap> = {
  [K in keyof MikaApi]: Exclude<keyof MikaApi[K], TNames[K][number]>;
}[keyof MikaApi];

function defineMikaApiMethodNames<const TNames extends MikaApiMethodNameMap>(
  names: MissingMikaApiMethods<TNames> extends never ? TNames : never,
): TNames {
  return names;
}

export const mikaApiMethodNames = defineMikaApiMethodNames(mikaOperationApiMethodNames);

type MikaApiNamespace = keyof typeof mikaApiMethodNames;

export function createMikaApi(overrides: MikaApiOverrides = {}): MikaApi {
  return {
    catalog: createMikaApiNamespace("catalog", overrides.catalog),
    stock: createMikaApiNamespace("stock", overrides.stock),
    cart: createMikaApiNamespace("cart", overrides.cart),
    wishlist: createMikaApiNamespace("wishlist", overrides.wishlist),
    checkout: createMikaApiNamespace("checkout", overrides.checkout),
    magicLink: createMikaApiNamespace("magicLink", overrides.magicLink),
    account: createMikaApiNamespace("account", overrides.account),
    subscription: createMikaApiNamespace("subscription", overrides.subscription),
    download: createMikaApiNamespace("download", overrides.download),
    order: createMikaApiNamespace("order", overrides.order),
    webhook: createMikaApiNamespace("webhook", overrides.webhook),
    admin: createMikaApiNamespace("admin", overrides.admin),
  };
}

function createMikaApiNamespace<TNamespace extends MikaApiNamespace>(
  namespace: TNamespace,
  overrides: MikaApiOverrides[TNamespace] | undefined,
): MikaApi[TNamespace] {
  const namespaceOverrides = overrides as Partial<Record<string, unknown>> | undefined;

  return Object.fromEntries(
    mikaApiMethodNames[namespace].map((method) => [
      method,
      namespaceOverrides?.[String(method)] ??
        (() => notImplemented(`${namespace}.${String(method)}`)),
    ]),
  ) as MikaApi[TNamespace];
}

export async function notImplemented<TData>(feature: string): Promise<MikaApiResult<TData>> {
  return {
    ok: false,
    status: 501,
    error: {
      code: "NOT_IMPLEMENTED",
      message: `Mika API '${feature}' has not been wired yet.`,
    },
  };
}
