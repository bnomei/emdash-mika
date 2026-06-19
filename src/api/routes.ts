import { mikaOperationPluginRoutes, mikaOperationPublicRouteNames } from "./operations";

export const MIKA_PLUGIN_ID = "mika";
export const EMDASH_PLUGIN_API_BASE = "/_emdash/api/plugins";

export const mikaPluginRoutes = mikaOperationPluginRoutes;

export type MikaPluginRouteName = keyof typeof mikaPluginRoutes;

export const publicMikaPluginRouteNames =
  mikaOperationPublicRouteNames satisfies readonly MikaPluginRouteName[];

export type MikaPublicPluginRouteName = (typeof publicMikaPluginRouteNames)[number];

export interface MikaRouteOptions {
  readonly pluginId?: string;
  readonly apiBase?: string;
  readonly origin?: string | URL;
  readonly search?: Record<string, string | number | boolean | undefined>;
}

export type MikaPluginRouteBuilder<TRoute extends MikaPluginRouteName = MikaPluginRouteName> = (
  route: TRoute,
  options?: MikaRouteOptions,
) => string;

export function createMikaPluginRouteBuilder<
  TRoute extends MikaPluginRouteName = MikaPluginRouteName,
>(defaults: MikaRouteOptions = {}): MikaPluginRouteBuilder<TRoute> {
  return (route, options = {}) =>
    mikaPluginRoute(route, {
      apiBase: options.apiBase ?? defaults.apiBase,
      pluginId: options.pluginId ?? defaults.pluginId,
      origin: options.origin ?? defaults.origin,
      search: options.search ?? defaults.search,
    });
}

export function mikaPluginRoute(
  route: MikaPluginRouteName,
  options: MikaRouteOptions = {},
): string {
  const apiBase = stripTrailingSlash(options.apiBase ?? EMDASH_PLUGIN_API_BASE);
  const pluginId = options.pluginId ?? MIKA_PLUGIN_ID;
  const path = mikaPluginRoutes[route];
  const pathname = `${apiBase}/${encodeURIComponent(pluginId)}/${path}`;
  const href =
    options.origin === undefined ? pathname : new URL(pathname, options.origin).toString();

  return appendSearch(href, options.search);
}

function appendSearch(href: string, search: MikaRouteOptions["search"]): string {
  if (!search) return href;

  const url = href.startsWith("http") ? new URL(href) : new URL(href, "http://mika.local");

  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  if (href.startsWith("http")) return url.toString();
  return `${url.pathname}${url.search}`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
