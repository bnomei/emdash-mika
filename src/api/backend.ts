import type { MikaProviderRegistry } from "../provider";
import type { MikaRepositories } from "../storage/repositories";
import { catalogSellablesToDTO } from "../model/builders";
import type {
  CurrencyCode,
  ISODateTime,
  JsonObject,
  MikaId,
  ProviderName,
} from "../types/primitives";
import { createMikaApi, type MikaApi, type MikaApiOverrides } from "./server";

type PublicContract<TValue> = Pick<TValue, keyof TValue>;

export type MikaBackendRepositories = {
  readonly [K in keyof MikaRepositories]: PublicContract<MikaRepositories[K]>;
};

export type MikaBackendNow = () => Date;
export type MikaBackendISODateTime = () => ISODateTime;
export type MikaBackendIdFactory = (namespace: string) => MikaId;
export type MikaBackendHashInput = string | Uint8Array;
export type MikaBackendHashHelper = (input: MikaBackendHashInput) => Promise<string> | string;

export interface MikaBackendDefaults {
  readonly currency?: CurrencyCode;
  readonly locale?: string;
  readonly provider?: ProviderName;
}

export interface MikaBackendConfig {
  readonly accountExport?: {
    readonly ttlMs?: number;
  };
  readonly cart?: {
    readonly ttlMs?: number;
  };
  readonly checkout?: {
    readonly cancelUrl?: string;
    readonly successUrl?: string;
    readonly ttlMs?: number;
  };
  readonly download?: {
    readonly tokenTtlMs?: number;
  };
  readonly magicLink?: {
    readonly ttlMs?: number;
  };
  readonly metadata?: JsonObject;
  readonly wishlist?: {
    readonly ttlMs?: number;
  };
}

export interface MikaBackendDependencies {
  readonly config?: MikaBackendConfig;
  readonly createId: MikaBackendIdFactory;
  readonly defaults?: MikaBackendDefaults;
  readonly hash: MikaBackendHashHelper;
  readonly isoNow?: MikaBackendISODateTime;
  readonly now: MikaBackendNow;
  readonly providers: MikaProviderRegistry;
  readonly repositories: MikaBackendRepositories;
}

export interface CreateMikaBackendApiInput extends MikaBackendDependencies {
  readonly overrides?: MikaApiOverrides;
}

export function createMikaBackendApi(input: CreateMikaBackendApiInput): MikaApi {
  return createMikaApi({
    ...input.overrides,
    catalog: {
      sellables: async ({ contentRef }) => {
        const catalogItem = await input.repositories.catalog.findItemByContent(contentRef);
        if (!catalogItem) {
          return { ok: true, status: 200, data: [] };
        }

        const activeSellables = catalogItem.aggregate.sellables.filter(
          (sellable) => sellable.active,
        );
        const stockRecords = await Promise.all(
          activeSellables.map(async (sellable) => ({
            sellableId: sellable.id,
            stock: await input.repositories.stock.findBySellableId(sellable.id),
          })),
        );
        const stockBySellableId = new Map(
          stockRecords.flatMap((record) =>
            record.stock ? [[record.sellableId, record.stock] as const] : [],
          ),
        );

        return {
          ok: true,
          status: 200,
          data: catalogSellablesToDTO({
            catalog: catalogItem.aggregate,
            stockBySellableId,
          }),
        };
      },
      ...input.overrides?.catalog,
    },
  });
}
