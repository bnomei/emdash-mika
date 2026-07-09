/**
 * EmDash plugin URL helpers: route key to path mapping and absolute URL construction.
 *
 * Depends only on the Zod-free {@link ./route-paths} map so browser `/client` never
 * evaluates the full operation IR or `astro/zod`.
 */
import { optionalProperty } from "../internal/object";
import {
  mikaPluginRoutePaths,
  publicMikaPluginRouteNames as purePublicMikaPluginRouteNames,
  type MikaPluginRouteName,
  type MikaPublicPluginRouteName,
} from "./route-paths";

/** Default EmDash plugin identifier for Mika. */
export const MIKA_PLUGIN_ID = "mika";
/** Base path prefix for EmDash plugin API routes. */
const EMDASH_PLUGIN_API_BASE = "/_emdash/api/plugins";

/** Re-exported pure route map keyed by stable route names. */
export const mikaPluginRoutes = mikaPluginRoutePaths;

export type { MikaPluginRouteName, MikaPublicPluginRouteName };

/** Route names exposed without authentication requirements. */
export const publicMikaPluginRouteNames =
  purePublicMikaPluginRouteNames satisfies readonly MikaPluginRouteName[];

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
      ...optionalProperty("apiBase", options.apiBase ?? defaults.apiBase),
      ...optionalProperty("pluginId", options.pluginId ?? defaults.pluginId),
      ...optionalProperty("origin", options.origin ?? defaults.origin),
      ...optionalProperty("search", options.search ?? defaults.search),
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
