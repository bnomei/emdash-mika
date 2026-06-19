import { definePlugin, type PluginDescriptor, type PluginStorageConfig } from "emdash";

import { createMikaPluginRoutes } from "./api/route-handlers";
import { setDefaultMikaApiOverrides } from "./api/runtime-api";
import { MIKA_PLUGIN_ID } from "./api/routes";
import { createMikaApi, type MikaApiOverrides } from "./api/server";
import { mikaStorageConfig } from "./storage/collections";

export { MIKA_PLUGIN_ID } from "./api/routes";
export const MIKA_PLUGIN_VERSION = "0.1.0";
export const MIKA_PACKAGE_NAME = "@bnomei/emdash-mika";

export interface MikaDescriptorOptions {
  readonly entrypoint?: string;
  readonly api?: MikaApiOverrides;
}

export interface MikaCreatePluginOptions {
  readonly api?: MikaApiOverrides;
}

export function mikaPlugin(
  options: MikaDescriptorOptions = {},
): PluginDescriptor<MikaCreatePluginOptions> {
  const entrypoint = options.entrypoint ?? MIKA_PACKAGE_NAME;
  const pluginOptions: MikaCreatePluginOptions =
    options.api === undefined ? {} : { api: options.api };

  return {
    id: MIKA_PLUGIN_ID,
    version: MIKA_PLUGIN_VERSION,
    format: "native",
    entrypoint,
    options: pluginOptions,
    capabilities: ["content:read", "email:send"],
    // EmDash descriptors do not yet model composite indexes; runtime storage below does.
    storage: mikaStorageConfig as never,
  };
}

export function createPlugin(options: MikaCreatePluginOptions = {}) {
  setDefaultMikaApiOverrides(options.api);
  const api = createMikaApi(options.api);

  return definePlugin({
    id: MIKA_PLUGIN_ID,
    version: MIKA_PLUGIN_VERSION,
    capabilities: ["content:read", "email:send"],
    storage: mikaStorageConfig as PluginStorageConfig,
    routes: createMikaPluginRoutes(api),
  });
}

export const mika = mikaPlugin;
export default mikaPlugin;
