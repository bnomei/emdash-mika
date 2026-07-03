/**
 * EmDash plugin URL helpers: route key to path mapping and absolute URL construction.
 */
import { mikaOperationPluginRoutes, mikaOperationPublicRouteNames } from "./operations";

/** Default EmDash plugin identifier for Mika. */
export const MIKA_PLUGIN_ID = "mika";
/** Base path prefix for EmDash plugin API routes. */
const EMDASH_PLUGIN_API_BASE = "/_emdash/api/plugins";

/** Re-exported operation route map keyed by stable route names. */
export const mikaPluginRoutes = mikaOperationPluginRoutes;

/** Union of stable plugin route keys from the operation route map. */
export type MikaPluginRouteName = keyof typeof mikaPluginRoutes;

/** Route names exposed without authentication requirements. */
export const publicMikaPluginRouteNames =
  mikaOperationPublicRouteNames satisfies readonly MikaPluginRouteName[];

/** Route keys for operations that do not require authentication. */
export type MikaPublicPluginRouteName = (typeof publicMikaPluginRouteNames)[number];

/** Options for resolving a plugin route to a URL string. */
export interface MikaRouteOptions {
  readonly pluginId?: string;
  readonly apiBase?: string;
  readonly origin?: string | URL;
  readonly search?: Record<string, string | number | boolean | undefined>;
}

/** Curried route builder with default api base, plugin id, and origin. */
export type MikaPluginRouteBuilder<TRoute extends MikaPluginRouteName = MikaPluginRouteName> = (
  route: TRoute,
  options?: MikaRouteOptions,
) => string;

/** Creates a route builder with frozen default URL options. */
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

/** Resolves a route key to a path or absolute URL with optional search params. */
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
