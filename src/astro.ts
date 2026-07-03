/**
 * Astro server integration: request-scoped MikaApi facade, plugin route builder, purchase UI
 * models from sellables, and locale-aware money/variant formatting helpers.
 */
import type { APIContext } from "astro";

import { optionalProperty } from "./internal/object";
import { createMikaRequestContext } from "./api/context";
import type { MikaSessionAccess } from "./api/context";
import type { MikaClientRoute } from "./api/client";
import { runMikaOperation } from "./api/operation-runner";
import { mikaOperationDefinitions } from "./api/operations";
import {
  createMikaOperationFacade,
  type MikaFacadeInvoke,
  type MikaOperationFacade,
  type MikaOperationWebhookFacade,
} from "./api/operation-facade";
import { serializeMikaPurchaseField } from "./api/form-contracts";
import type { MikaOperationPolicy } from "./api/operation-policy";
import { mikaSafeReturnPath, type MikaSafeReturnPathOptions } from "./api/redirect-policy";
import { createMikaPluginRouteBuilder } from "./api/routes";
import { createMikaApi, type MikaApiOverrides } from "./api/server";
import type {
  AvailabilityDTO,
  MoneyDTO,
  PriceDTO,
  SellableDTO,
  VariantOptionGroupDTO,
  VariantOptionValueDTO,
} from "./api/types";

/** Minimal Astro API context slice used to build request-scoped Mika clients. */
export type MikaAstroContext = Pick<APIContext, "request" | "url"> &
  Partial<Pick<APIContext, "session" | "currentLocale">>;

/** Overrides for API wiring, operation policy, and optional webhook facade on Astro pages. */
export interface MikaAstroClientOptions {
  readonly api?: MikaApiOverrides;
  readonly operationPolicy?: MikaOperationPolicy;
  readonly includeWebhook?: boolean;
}

/** Request-scoped Mika operation facade plus plugin route builder for Astro server code. */
export type MikaAstroClient<TOptions extends MikaAstroClientOptions | undefined = undefined> =
  MikaOperationFacade &
    (TOptions extends { readonly includeWebhook: true } ? MikaOperationWebhookFacade : {}) & {
      readonly routes: MikaClientRoute;
    };

/** Locale hints passed to Intl formatters for money and price labels. */
export interface MikaFormatOptions {
  readonly locales?: Intl.LocalesArgument;
}

/** One selectable sellable/price pair with serialized form fields for add-to-cart. */
export interface MikaPurchaseOption {
  readonly sellable: SellableDTO;
  readonly price: PriceDTO;
  readonly value: string;
  readonly fields: {
    readonly sellableId: string;
    readonly priceId: string;
    readonly purchase: string;
  };
  readonly label: string;
  readonly disabled: boolean;
}

/** Client-side variant control state for one sellable in grouped purchase pickers. */
export interface MikaPurchaseVariantMapItem {
  readonly id: string;
  readonly priceId?: string;
  readonly maxQuantity?: number;
  readonly disabled: boolean;
  readonly options: Record<string, string>;
}

/** Pre-selected sellable or price and locale hints for purchase view-models. */
export interface MikaPurchaseModelOptions extends MikaFormatOptions {
  readonly selectedSellableId?: string;
  readonly selectedPriceId?: string;
}

/** View-model for purchase UI controls derived from active sellables, prices, and stock limits. */
export interface MikaPurchaseModel {
  readonly activeSellables: readonly SellableDTO[];
  readonly options: readonly MikaPurchaseOption[];
  readonly selectedOptionIndex: number;
  readonly selectedOption?: MikaPurchaseOption;
  readonly selectedSellable?: SellableDTO;
  readonly selectedPrice?: PriceDTO;
  readonly maxQuantity?: number;
  readonly missingActivePrice: boolean;
  readonly unavailable: boolean;
  readonly hasGroupedVariants: boolean;
  readonly hasExactlyOneActivePricePerSellable: boolean;
  readonly useGroupedVariantControls: boolean;
  readonly variantGroups: readonly VariantOptionGroupDTO[];
  readonly variantOptionMap: readonly MikaPurchaseVariantMapItem[];
}

/** Creates a request-scoped Mika client wired to Astro session, locale, and plugin routes. */
export function createMikaAstroClient<
  const TOptions extends MikaAstroClientOptions | undefined = undefined,
>(ctx: MikaAstroContext, options?: TOptions): MikaAstroClient<TOptions> {
  const resolvedOptions: MikaAstroClientOptions = options ?? {};
  const api = createMikaApi(resolvedOptions.api);
  const requestContext = createMikaRequestContext({
    request: ctx.request,
    url: ctx.url,
    ...optionalProperty("session", ctx.session as MikaSessionAccess | undefined),
    ...optionalProperty("locale", ctx.currentLocale),
  });
  const requestOperation: MikaFacadeInvoke = (operationKey, input) => {
    const operation = mikaOperationDefinitions[operationKey];
    return runMikaOperation({
      operation,
      api,
      ctx: requestContext,
      input,
      ...optionalProperty("operationPolicy", resolvedOptions.operationPolicy),
    });
  };
  const facade = createMikaOperationFacade(requestOperation, {
    ...optionalProperty("locale", requestContext.locale),
    ...optionalProperty("includeWebhook", resolvedOptions.includeWebhook),
  });

  return {
    routes: createMikaPluginRouteBuilder({
      origin: ctx.url,
    }),
    ...facade,
  } as unknown as MikaAstroClient<TOptions>;
}

/** Alias for `createMikaAstroClient`. */
export const createMika = createMikaAstroClient;

/** Serializes the current URL path and query for checkout return-to parameters. */
export function mikaReturnTo(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/** Open-redirect guard options for post-action return paths. */
export type MikaSafeReturnToOptions = MikaSafeReturnPathOptions;

/** Validates and normalizes a post-checkout return path against open-redirect rules. */
export function mikaSafeReturnTo(
  candidate: string | URL | null | undefined,
  options: MikaSafeReturnToOptions = {},
): string {
  return mikaSafeReturnPath(candidate, options);
}

/** Serializable scalar accepted by hidden form input helpers. */
export type MikaHiddenInputValue = string | number | boolean | null | undefined;

/** Name/value pair for a hidden form input; nullish values become empty strings. */
export function mikaHiddenInput(name: string, value: MikaHiddenInputValue) {
  return {
    name,
    value: value === null || value === undefined ? "" : String(value),
  };
}

/** Return-path validation options for hidden `returnTo` fields. */
export type MikaReturnToInputOptions = MikaSafeReturnToOptions;

/** Hidden `returnTo` input attrs validated through {@link mikaSafeReturnTo}. */
export function mikaReturnToInput(
  returnTo: string | URL | null | undefined,
  options: MikaReturnToInputOptions = {},
) {
  return mikaHiddenInput("returnTo", mikaSafeReturnTo(returnTo, options));
}

/** Checkout success, cancel, and return paths for redirect hidden inputs. */
export interface MikaRedirectInputsInput {
  readonly successPath: string | URL | null | undefined;
  readonly cancelPath: string | URL | null | undefined;
  readonly returnTo: string | URL | null | undefined;
}

/** Fallback paths and origin for validating checkout redirect hidden inputs. */
export interface MikaRedirectInputsOptions {
  readonly successFallback?: string;
  readonly cancelFallback?: string;
  readonly returnToFallback?: string;
  readonly origin?: string | URL;
}

/** Checkout redirect hidden input attrs with caller-controlled fallback paths. */
export function mikaRedirectInputs(
  input: MikaRedirectInputsInput,
  options: MikaRedirectInputsOptions = {},
) {
  return {
    successPath: mikaHiddenInput(
      "successPath",
      mikaSafeReturnTo(input.successPath, {
        ...optionalProperty("origin", options.origin),
        ...optionalProperty("fallback", options.successFallback),
      }),
    ),
    cancelPath: mikaHiddenInput(
      "cancelPath",
      mikaSafeReturnTo(input.cancelPath, {
        ...optionalProperty("origin", options.origin),
        ...optionalProperty("fallback", options.cancelFallback),
      }),
    ),
    returnTo: mikaReturnToInput(input.returnTo, {
      ...optionalProperty("origin", options.origin),
      ...optionalProperty("fallback", options.returnToFallback),
    }),
  };
}

/** Locale-aware currency formatter for Mika `MoneyDTO` minor-unit amounts. */
export function formatMikaMoney(value?: MoneyDTO | null, options: MikaFormatOptions = {}): string {
  if (!value) return "";

  const formatter = new Intl.NumberFormat(options.locales, {
    style: "currency",
    currency: value.currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return formatter.format(value.amount / 10 ** fractionDigits);
}

/** Formats a price including subscription billing interval when applicable. */
export function formatMikaPrice(price: PriceDTO, options: MikaFormatOptions = {}): string {
  const amount = formatMikaMoney(price, options);
  if (price.mode !== "subscription") return amount;

  return `${amount} ${formatMikaBillingInterval(price)}`;
}

/** Human-readable label chain from variant option values. */
export function formatMikaVariant(
  variantOptions: readonly VariantOptionValueDTO[],
  fallback = "",
): string {
  const values = variantOptions.map((option) => option.label ?? option.value).filter(Boolean);

  return values.length > 0 ? values.join(" / ") : fallback;
}

/** Display title preferring variant labels over the sellable title. */
export function formatMikaSellable(sellable: SellableDTO): string {
  return formatMikaVariant(sellable.variantOptions, sellable.title);
}

/** Builds selectable purchase options (sellable + active price) for form controls. */
export function createMikaPurchaseOptions(
  sellables: readonly SellableDTO[],
  options: MikaFormatOptions = {},
): readonly MikaPurchaseOption[] {
  const activeSellables = sellables.filter((sellable) => sellable.active);

  return activeSellables.flatMap((sellable) =>
    sellable.prices
      .filter((price) => price.active)
      .map((price) => {
        const labelParts =
          activeSellables.length > 1
            ? [formatMikaSellable(sellable), formatMikaPrice(price, options)]
            : [formatMikaPrice(price, options)];

        const value = serializeMikaPurchaseField({
          sellableId: sellable.id,
          priceId: price.id,
        });

        return {
          sellable,
          price,
          value,
          fields: {
            sellableId: sellable.id,
            priceId: price.id,
            purchase: value,
          },
          label: labelParts.join(" - "),
          disabled: !isMikaPurchasable(sellable.availability),
        };
      }),
  );
}

/** Assembles the full purchase view-model including variant grouping and availability flags. */
export function createMikaPurchaseModel(
  sellables: readonly SellableDTO[],
  options: MikaPurchaseModelOptions = {},
): MikaPurchaseModel {
  const activeSellables = sellables.filter((sellable) => sellable.active);
  const purchaseOptions = createMikaPurchaseOptions(activeSellables, options);
  const selectedOptionIndex = selectedMikaPurchaseIndex(purchaseOptions, options);
  const selectedOption = purchaseOptions[selectedOptionIndex];
  const selectedSellable =
    selectedOption?.sellable ??
    activeSellables.find((sellable) => sellable.id === options.selectedSellableId) ??
    activeSellables.find((sellable) => isMikaPurchasable(sellable.availability)) ??
    activeSellables[0];
  const selectedPrice =
    selectedOption?.price ??
    selectedSellable?.prices.find(
      (price) => price.active && (!options.selectedPriceId || price.id === options.selectedPriceId),
    ) ??
    selectedSellable?.prices.find((price) => price.active);
  const maxQuantity = mikaMaxPurchaseQuantity(selectedSellable?.availability);
  const variantGroups =
    activeSellables.find((sellable) => sellable.variantGroups?.length)?.variantGroups ?? [];
  const hasGroupedVariants = variantGroups.length > 0;
  const hasExactlyOneActivePricePerSellable = activeSellables.every(
    (sellable) => sellable.prices.filter((price) => price.active).length === 1,
  );
  // Grouped controls when variants span multiple sellables with exactly one active price each.
  const useGroupedVariantControls =
    hasGroupedVariants && activeSellables.length > 1 && hasExactlyOneActivePricePerSellable;
  const missingActivePrice = activeSellables.length > 0 && purchaseOptions.length === 0;
  const unavailable =
    activeSellables.length === 0 ||
    missingActivePrice ||
    (purchaseOptions.length > 0 && purchaseOptions.every((option) => option.disabled)) ||
    activeSellables.every((sellable) => !isMikaPurchasable(sellable.availability));

  return {
    activeSellables,
    options: purchaseOptions,
    selectedOptionIndex,
    ...optionalProperty("selectedOption", selectedOption),
    ...optionalProperty("selectedSellable", selectedSellable),
    ...optionalProperty("selectedPrice", selectedPrice),
    ...optionalProperty("maxQuantity", maxQuantity),
    missingActivePrice,
    unavailable,
    hasGroupedVariants,
    hasExactlyOneActivePricePerSellable,
    useGroupedVariantControls,
    variantGroups,
    variantOptionMap: activeSellables.map(mikaVariantMapItem),
  };
}

/** Whether stock availability allows adding the sellable to cart. */
export function isMikaPurchasable(availability?: AvailabilityDTO): boolean {
  return availability?.status !== "out_of_stock";
}

/** Resolves the effective per-order quantity cap from availability limits. */
export function mikaMaxPurchaseQuantity(availability?: AvailabilityDTO): number | undefined {
  const limits = [availability?.maxPerOrder, availability?.availableQuantity].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

  return limits.length > 0 ? Math.min(...limits) : undefined;
}

/** First enabled purchase option, or the first option when all are disabled. */
export function firstAvailableMikaPurchaseOption(
  options: readonly MikaPurchaseOption[],
): MikaPurchaseOption | undefined {
  return options[firstAvailableMikaPurchaseIndex(options)];
}

/** Index of the first purchasable option for default selection. */
export function firstAvailableMikaPurchaseIndex(options: readonly MikaPurchaseOption[]): number {
  const index = options.findIndex((option) => !option.disabled);
  return index === -1 ? 0 : index;
}

function selectedMikaPurchaseIndex(
  options: readonly MikaPurchaseOption[],
  selection: Pick<MikaPurchaseModelOptions, "selectedSellableId" | "selectedPriceId">,
): number {
  const selectedIndex = options.findIndex(
    (option) =>
      (!selection.selectedSellableId || option.sellable.id === selection.selectedSellableId) &&
      (!selection.selectedPriceId || option.price.id === selection.selectedPriceId),
  );

  return selectedIndex === -1 ? firstAvailableMikaPurchaseIndex(options) : selectedIndex;
}

function mikaVariantMapItem(sellable: SellableDTO): MikaPurchaseVariantMapItem {
  return {
    id: sellable.id,
    ...optionalProperty("priceId", sellable.prices.find((price) => price.active)?.id),
    ...optionalProperty("maxQuantity", mikaMaxPurchaseQuantity(sellable.availability)),
    disabled: !isMikaPurchasable(sellable.availability),
    options: Object.fromEntries(
      sellable.variantOptions.map((option) => [option.option, option.value]),
    ),
  };
}

function formatMikaBillingInterval(price: PriceDTO): string {
  if (!price.interval) return "subscription";

  const count = price.intervalCount ?? 1;
  if (count <= 1) {
    return price.interval === "month" ? "monthly" : "yearly";
  }

  return `every ${count} ${price.interval}s`;
}
