import type { AvailabilityDTO, MikaApiResult, SellableDTO } from "./types";
import { createMikaPluginRouteBuilder } from "./routes";
import type { MikaPublicPluginRouteName } from "./routes";
import { requestMika, type MikaRequestInit } from "./request";

export interface MikaClientRouteOptions {
  readonly pluginId?: string;
  readonly apiBase?: string;
  readonly origin?: string | URL;
  readonly search?: Record<string, string | number | boolean | undefined>;
}

export interface MikaClientOptions extends Pick<MikaClientRouteOptions, "apiBase" | "pluginId"> {
  readonly baseUrl?: string | URL;
  readonly fetch?: typeof fetch;
  readonly request?: Request;
  readonly headers?: HeadersInit;
}

export interface CatalogSellablesOptions {
  readonly locale?: string;
}

export type MikaClientRouteName = MikaPublicPluginRouteName;
export type MikaClientRoute = (
  route: MikaClientRouteName,
  options?: MikaClientRouteOptions,
) => string;

export interface MikaClient {
  readonly routes: MikaClientRoute;
  readonly catalog: {
    sellables(
      collection: string,
      id: string,
      options?: CatalogSellablesOptions,
    ): Promise<MikaApiResult<readonly SellableDTO[]>>;
  };
  readonly stock: {
    availability(sellableId: string): Promise<MikaApiResult<AvailabilityDTO>>;
  };
}

export function createMikaClient(options: MikaClientOptions = {}): MikaClient {
  const request = <TData>(route: MikaClientRouteName, init: MikaRequestInit = {}) =>
    requestMika<TData>(route, init, options);
  const routes = createMikaPluginRouteBuilder<MikaClientRouteName>({
    apiBase: options.apiBase,
    pluginId: options.pluginId,
    origin: options.baseUrl ?? options.request?.url,
  });

  return {
    routes,
    catalog: {
      sellables: (collection, id, catalogOptions = {}) =>
        request("catalogSellables", {
          search: { collection, id, locale: catalogOptions.locale },
        }),
    },
    stock: {
      availability: (sellableId) => request("sellableAvailability", { search: { sellableId } }),
    },
  };
}
