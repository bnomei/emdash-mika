import type { APIContext } from "astro";

import { createMikaRequestContext } from "./api/context";
import { type MikaClientRoute } from "./api/client";
import { resolveMikaApiOverrides, resolveMikaOperationPolicy } from "./api/runtime-api";
import { runMikaOperation } from "./api/operation-runner";
import { mikaOperationDefinitions, type MikaApiOperationData } from "./api/operations";
import {
  createMikaOperationFacade,
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
  MikaApiResult,
  VariantOptionGroupDTO,
  VariantOptionValueDTO,
} from "./api/types";

export type MikaAstroContext = Pick<APIContext, "request" | "url"> &
  Partial<Pick<APIContext, "session" | "currentLocale">>;

export interface MikaAstroClientOptions {
  readonly api?: MikaApiOverrides;
  readonly operationPolicy?: MikaOperationPolicy;
  readonly includeWebhook?: boolean;
}

export type MikaAstroClient<TOptions extends MikaAstroClientOptions | undefined = undefined> =
  MikaOperationFacade &
    (TOptions extends { readonly includeWebhook: true } ? MikaOperationWebhookFacade : {}) & {
      readonly routes: MikaClientRoute;
    };

export interface MikaFormatOptions {
  readonly locales?: Intl.LocalesArgument;
}

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

export interface MikaPurchaseVariantMapItem {
  readonly id: string;
  readonly priceId?: string;
  readonly maxQuantity?: number;
  readonly disabled: boolean;
  readonly options: Record<string, string>;
}

export interface MikaPurchaseModelOptions extends MikaFormatOptions {
  readonly selectedSellableId?: string;
  readonly selectedPriceId?: string;
}

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

export function createMikaAstroClient<
  const TOptions extends MikaAstroClientOptions | undefined = undefined,
>(ctx: MikaAstroContext, options?: TOptions): MikaAstroClient<TOptions> {
  const resolvedOptions: MikaAstroClientOptions = options ?? {};
  const api = createMikaApi(resolveMikaApiOverrides(resolvedOptions.api));
  const requestContext = createMikaRequestContext({
    request: ctx.request,
    url: ctx.url,
    session: ctx.session,
    locale: ctx.currentLocale,
  });
  const requestOperation = <TOperation extends keyof typeof mikaOperationDefinitions>(
    operationKey: TOperation,
    input?: unknown,
  ): Promise<
    MikaApiResult<MikaApiOperationData<(typeof mikaOperationDefinitions)[TOperation]>>
  > => {
    const operation = mikaOperationDefinitions[operationKey];
    return runMikaOperation({
      operation,
      api,
      ctx: requestContext,
      input,
      operationPolicy: resolveMikaOperationPolicy(resolvedOptions.operationPolicy),
    });
  };
  const facade = createMikaOperationFacade(requestOperation, {
    locale: requestContext.locale,
    includeWebhook: resolvedOptions.includeWebhook,
  });

  return {
    routes: createMikaPluginRouteBuilder({
      origin: ctx.url,
    }),
    ...facade,
  } as unknown as MikaAstroClient<TOptions>;
}

export const createMika = createMikaAstroClient;

export function mikaReturnTo(url: URL): string {
  return `${url.pathname}${url.search}`;
}

export type MikaSafeReturnToOptions = MikaSafeReturnPathOptions;

export function mikaSafeReturnTo(
  candidate: string | URL | null | undefined,
  options: MikaSafeReturnToOptions = {},
): string {
  return mikaSafeReturnPath(candidate, options);
}

export function formatMikaMoney(value?: MoneyDTO | null, options: MikaFormatOptions = {}): string {
  if (!value) return "";

  return new Intl.NumberFormat(options.locales, {
    style: "currency",
    currency: value.currency,
  }).format(value.amount / 100);
}

export function formatMikaPrice(price: PriceDTO, options: MikaFormatOptions = {}): string {
  const amount = formatMikaMoney(price, options);
  if (price.mode !== "subscription") return amount;

  return `${amount} ${formatMikaBillingInterval(price)}`;
}

export function formatMikaVariant(
  variantOptions: readonly VariantOptionValueDTO[],
  fallback = "",
): string {
  const values = variantOptions.map((option) => option.label ?? option.value).filter(Boolean);

  return values.length > 0 ? values.join(" / ") : fallback;
}

export function formatMikaSellable(sellable: SellableDTO): string {
  return formatMikaVariant(sellable.variantOptions, sellable.title);
}

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
    selectedOption,
    selectedSellable,
    selectedPrice,
    maxQuantity,
    missingActivePrice,
    unavailable,
    hasGroupedVariants,
    hasExactlyOneActivePricePerSellable,
    useGroupedVariantControls,
    variantGroups,
    variantOptionMap: activeSellables.map(mikaVariantMapItem),
  };
}

export function isMikaPurchasable(availability?: AvailabilityDTO): boolean {
  return availability?.status !== "out_of_stock";
}

export function mikaMaxPurchaseQuantity(availability?: AvailabilityDTO): number | undefined {
  const limits = [availability?.maxPerOrder, availability?.availableQuantity].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

  return limits.length > 0 ? Math.min(...limits) : undefined;
}

export function firstAvailableMikaPurchaseOption(
  options: readonly MikaPurchaseOption[],
): MikaPurchaseOption | undefined {
  return options[firstAvailableMikaPurchaseIndex(options)];
}

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
    priceId: sellable.prices.find((price) => price.active)?.id,
    maxQuantity: mikaMaxPurchaseQuantity(sellable.availability),
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
