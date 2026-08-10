/**
 * {@link MikaApi} interface and stub factory: namespace method contracts and not-implemented wiring.
 * Production handlers are supplied by {@link createMikaBackendApi} or host overrides.
 */
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
  CheckoutCancelInput,
  CheckoutStatusInput,
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
import type { SellableId } from "../types/primitives";
import type { MikaRequestContext } from "./context";
import { mikaOperationApiMethodNames } from "./operations";

/** Typed commerce API surface grouped by namespace (catalog through admin). */
export interface MikaApi {
  /** Catalog reads keyed by content reference; returns active sellables with availability snapshots. */
  readonly catalog: {
    sellables(input: {
      readonly contentRef: ContentRefDTO;
    }): Promise<MikaApiResult<readonly SellableDTO[]>>;
  };
  /** On-hand stock availability for a sellable id. */
  readonly stock: {
    availability(input: {
      readonly sellableId: SellableId;
    }): Promise<MikaApiResult<AvailabilityDTO>>;
  };
  /** Session-bound cart mutations: lines, coupons, and anonymous-session merge. */
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
  /** Saved-for-later list with move-to-cart and cart-line save helpers. */
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
  /** Hosted checkout handoff: reserves stock, claims cart, and opens a provider session. */
  readonly checkout: {
    start(
      ctx: MikaRequestContext,
      input: StartCheckoutInput,
    ): Promise<MikaApiResult<CheckoutSessionDTO>>;
    preview(
      ctx: MikaRequestContext,
      input: CheckoutPreviewInput,
    ): Promise<MikaApiResult<CheckoutPreviewDTO>>;
    status(
      ctx: MikaRequestContext,
      input: CheckoutStatusInput,
    ): Promise<MikaApiResult<CheckoutSessionDTO>>;
    cancel(
      ctx: MikaRequestContext,
      input: CheckoutCancelInput,
    ): Promise<MikaApiResult<CheckoutSessionDTO>>;
  };
  /** Passwordless account access; verify consumes a one-time token and binds the customer session. */
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
  /** Customer profile, GDPR export/delete, and provider billing portal handoff. */
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
  /** Provider-backed subscription cancel, plan change, and renewal actions. */
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
  /** Download tokens expose opaque evidence; host overrides may resolve it before confirmation. */
  readonly download: {
    resolve(input: { readonly token: string }): Promise<MikaApiResult<DownloadResolutionDTO>>;
    confirm(input: { readonly token: string }): Promise<MikaApiResult<DownloadResolutionDTO>>;
  };
  /** Customer order invoice resolution with optional capability token. */
  readonly order: {
    invoice(
      ctx: MikaRequestContext,
      input: OrderInvoiceInput,
    ): Promise<MikaApiResult<OrderInvoiceDTO>>;
  };
  /** Provider webhook ingest: signature verification, deduplication, and fulfillment workflows. */
  readonly webhook: {
    receive(
      ctx: MikaRequestContext,
      input: WebhookReceiveInput,
    ): Promise<MikaApiResult<WebhookReceiveDTO>>;
  };
  /** Operator mutations: provider sync, stock, webhooks, orders, entitlements, and email replay. */
  readonly admin: {
    providerHealth(input: ProviderHealthInput): Promise<MikaApiResult<ProviderHealthDTO>>;
    providerSync(input: ProviderSyncInput): Promise<MikaApiResult<AdminActionResultDTO>>;
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

/** Partial per-namespace handler overrides merged into {@link createMikaApi}. */
export type MikaApiOverrides = {
  readonly [K in keyof MikaApi]?: Partial<MikaApi[K]>;
};

type MikaApiMethodNameMap = {
  readonly [K in keyof MikaApi]: readonly (keyof MikaApi[K])[];
};

/** Methods present on {@link MikaApi} but missing from a candidate name map. */
type MissingMikaApiMethods<TNames extends MikaApiMethodNameMap> = {
  [K in keyof MikaApi]: Exclude<keyof MikaApi[K], TNames[K][number]>;
}[keyof MikaApi];

/**
 * Namespaces on a candidate map that are not on {@link MikaApi}.
 * (Extra *methods* inside a known namespace are rejected by `extends MikaApiMethodNameMap`.)
 */
type ExcessMikaApiNamespaces<TNames extends MikaApiMethodNameMap> = Exclude<
  keyof TNames,
  keyof MikaApi
>;

/**
 * Bidirectional pin: every {@link MikaApi} method appears in the name map, every map
 * namespace is a {@link MikaApi} namespace, and every listed method is a real API key.
 * Resolves to `never` when locked.
 */
type MikaApiMethodNameDrift<TNames extends MikaApiMethodNameMap> =
  | MissingMikaApiMethods<TNames>
  | ExcessMikaApiNamespaces<TNames>;

function defineMikaApiMethodNames<const TNames extends MikaApiMethodNameMap>(
  names: MikaApiMethodNameDrift<TNames> extends never ? TNames : never,
): TNames {
  return names;
}

/** Authoritative list of method names on each {@link MikaApi} namespace. */
export const mikaApiMethodNames = defineMikaApiMethodNames(mikaOperationApiMethodNames);

/**
 * Compile-time pin: exposed registry ops (`mikaOperationApiMethodNames`) ↔ {@link MikaApi}.
 * Fails typecheck when either surface gains a method/namespace the other lacks.
 */
type _AssertMikaApiMethodNamesPinned =
  MikaApiMethodNameDrift<typeof mikaOperationApiMethodNames> extends never ? true : never;
const _assertMikaApiMethodNamesPinned: _AssertMikaApiMethodNamesPinned = true;
void _assertMikaApiMethodNamesPinned;

type MikaApiNamespace = keyof typeof mikaApiMethodNames;
const mikaNotImplementedApiMethod = Symbol("mika.notImplementedApiMethod");

type NotImplementedMikaApiMethod = {
  (...args: readonly unknown[]): Promise<MikaApiResult<unknown>>;
  readonly [mikaNotImplementedApiMethod]: string;
};

/** Builds a {@link MikaApi} with not-implemented stubs replaced by provided overrides. */
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
      namespaceOverrides?.[String(method)] ?? createNotImplementedMikaApiMethod(namespace, method),
    ]),
  ) as MikaApi[TNamespace];
}

/** Options limiting which namespaces or methods {@link assertMikaApiWired} inspects. */
export interface AssertMikaApiWiredOptions {
  readonly scope?: readonly string[];
}

/**
 * Machine-readable discriminator for {@link assertMikaApiWired} failures, so callers can tailor
 * remediation without string-matching the message. Internal: intentionally not re-exported from
 * the `/server` package entry. The thrown value stays an ordinary Error subclass with the same
 * human-facing message for consumers.
 */
export type MikaApiWiringErrorCode = "unknown_scope" | "missing_methods";

export class MikaApiWiringError extends Error {
  readonly code: MikaApiWiringErrorCode;

  constructor(code: MikaApiWiringErrorCode, message: string) {
    super(message);
    this.name = "MikaApiWiringError";
    this.code = code;
  }
}

/** Narrows an unknown thrown value to a {@link MikaApiWiringError} with the given code. */
export function isMikaApiWiringError(
  error: unknown,
  code?: MikaApiWiringErrorCode,
): error is MikaApiWiringError {
  return error instanceof MikaApiWiringError && (code === undefined || error.code === code);
}

/** Throws when any requested method still resolves to the not-implemented stub. */
export function assertMikaApiWired(api: MikaApi, options: AssertMikaApiWiredOptions = {}): void {
  const scope = options.scope ? new Set(options.scope) : undefined;
  const unknownScope = scope
    ? [...scope].filter((entry) => !mikaApiWireScopeNames().has(entry)).sort()
    : [];
  if (unknownScope.length > 0) {
    throw new MikaApiWiringError(
      "unknown_scope",
      `Unknown Mika API wiring scope: ${unknownScope.join(", ")}.`,
    );
  }

  const missing: string[] = [];

  for (const [namespace, methods] of Object.entries(mikaApiMethodNames)) {
    for (const method of methods) {
      const name = `${namespace}.${String(method)}`;
      if (scope && !scope.has(namespace) && !scope.has(name)) continue;

      const candidate = api[namespace as keyof MikaApi][method as never] as unknown;
      if (isNotImplementedMikaApiMethod(candidate)) missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new MikaApiWiringError(
      "missing_methods",
      `Mika API is missing wired methods: ${missing.sort().join(", ")}.`,
    );
  }
}

function mikaApiWireScopeNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [namespace, methods] of Object.entries(mikaApiMethodNames)) {
    names.add(namespace);
    for (const method of methods) {
      names.add(`${namespace}.${String(method)}`);
    }
  }

  return names;
}

/** Standard not-implemented {@link MikaApiResult} returned by unwired stub methods. */
async function notImplemented<TData>(feature: string): Promise<MikaApiResult<TData>> {
  return {
    ok: false,
    status: 501,
    error: {
      code: "NOT_IMPLEMENTED",
      message: `Mika API '${feature}' has not been wired yet.`,
    },
  };
}

function createNotImplementedMikaApiMethod<TNamespace extends MikaApiNamespace>(
  namespace: TNamespace,
  method: PropertyKey,
): NotImplementedMikaApiMethod {
  const feature = `${namespace}.${String(method)}`;
  return Object.assign(() => notImplemented(feature), {
    [mikaNotImplementedApiMethod]: feature,
  });
}

function isNotImplementedMikaApiMethod(value: unknown): value is NotImplementedMikaApiMethod {
  return (
    typeof value === "function" &&
    mikaNotImplementedApiMethod in value &&
    typeof value[mikaNotImplementedApiMethod] === "string"
  );
}
