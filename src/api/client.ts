/**
 * Browser-safe HTTP client for public Mika plugin routes (catalog and stock).
 * Builds plugin URLs and normalizes JSON {@link MikaApiResult} envelopes.
 */
import type { AvailabilityDTO, MikaApiResult, SellableDTO } from "./types";
import { createMikaPluginRouteBuilder } from "./routes";
import type { MikaPublicPluginRouteName } from "./routes";
import { requestMika, type MikaRequestInit } from "./request";

/** Per-request overrides for plugin route URL construction. */
export interface MikaClientRouteOptions {
  readonly pluginId?: string;
  readonly apiBase?: string;
  readonly origin?: string | URL;
  readonly search?: Record<string, string | number | boolean | undefined>;
}

/** Factory options for {@link createMikaClient}. */
export interface MikaClientOptions extends Pick<MikaClientRouteOptions, "apiBase" | "pluginId"> {
  readonly baseUrl?: string | URL;
  readonly fetch?: typeof fetch;
  readonly request?: Request;
  readonly headers?: HeadersInit;
}

/** Locale hint when resolving sellables for a content entry. */
export interface CatalogSellablesOptions {
  readonly locale?: string;
}

/** Public plugin route keys accepted by the browser client. */
export type MikaClientRouteName = MikaPublicPluginRouteName;

/** Resolves a public plugin route name to an absolute or site-relative URL. */
export type MikaClientRoute = (
  route: MikaClientRouteName,
  options?: MikaClientRouteOptions,
) => string;

/** Minimal typed client surface for unauthenticated storefront reads. */
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

/** Creates a fetch-based client for public catalog and stock endpoints. */
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
