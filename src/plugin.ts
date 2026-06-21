import {
  definePlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginStorageConfig,
} from "emdash";

import { createMikaMaintenanceRunner } from "./api/maintenance";
import { createMikaPluginRoutes } from "./api/route-handlers";
import { setDefaultMikaApiOverrides, setDefaultMikaOperationPolicy } from "./api/runtime-api";
import { MIKA_PLUGIN_ID } from "./api/routes";
import { createMikaApi, type MikaApiOverrides } from "./api/server";
import type { MikaOperationPolicy } from "./api/operation-policy";
import { mikaStorageConfig } from "./storage/collections";
import { createISODateTime } from "./types/primitives";

export { MIKA_PLUGIN_ID } from "./api/routes";
export const MIKA_PLUGIN_VERSION = "0.1.0";
export const MIKA_PACKAGE_NAME = "@bnomei/emdash-mika";
export const MIKA_MAINTENANCE_CRON_TASK = "mika_maintenance";
export const MIKA_MAINTENANCE_CRON_SCHEDULE = "* * * * *";

export interface MikaMaintenancePluginOptions {
  readonly enabled?: boolean;
  readonly schedule?: string;
}

export interface MikaDescriptorOptions {
  readonly entrypoint?: string;
  readonly api?: MikaApiOverrides;
  readonly operationPolicy?: MikaOperationPolicy;
  readonly maintenance?: MikaMaintenancePluginOptions;
}

export interface MikaCreatePluginOptions {
  readonly api?: MikaApiOverrides;
  readonly operationPolicy?: MikaOperationPolicy;
  readonly maintenance?: MikaMaintenancePluginOptions;
}

type MikaCronEvent = {
  readonly name: string;
  readonly scheduledAt: string;
};

export function mikaPlugin(
  options: MikaDescriptorOptions = {},
): PluginDescriptor<MikaCreatePluginOptions> {
  const entrypoint = options.entrypoint ?? MIKA_PACKAGE_NAME;
  const pluginOptions: MikaCreatePluginOptions = {
    ...(options.api === undefined ? {} : { api: options.api }),
    ...(options.operationPolicy === undefined ? {} : { operationPolicy: options.operationPolicy }),
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
  };

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
  setDefaultMikaOperationPolicy(options.operationPolicy);
  const api = createMikaApi(options.api);
  const maintenance = options.maintenance ?? {};
  const maintenanceEnabled = maintenance.enabled !== false;
  const maintenanceSchedule = maintenance.schedule ?? MIKA_MAINTENANCE_CRON_SCHEDULE;

  const registerMaintenance = async (_event: unknown, ctx: PluginContext) => {
    if (!ctx.cron) return;

    if (!maintenanceEnabled) {
      await ctx.cron.cancel(MIKA_MAINTENANCE_CRON_TASK);
      return;
    }

    await ctx.cron.schedule(MIKA_MAINTENANCE_CRON_TASK, {
      schedule: maintenanceSchedule,
    });
  };

  return definePlugin({
    id: MIKA_PLUGIN_ID,
    version: MIKA_PLUGIN_VERSION,
    capabilities: ["content:read", "email:send"],
    storage: mikaStorageConfig as PluginStorageConfig,
    routes: createMikaPluginRoutes(api, { operationPolicy: options.operationPolicy }),
    hooks: {
      "plugin:install": registerMaintenance,
      "plugin:activate": registerMaintenance,
      cron: async (event: MikaCronEvent) => {
        if (!maintenanceEnabled || event.name !== MIKA_MAINTENANCE_CRON_TASK) return;

        const result = await createMikaMaintenanceRunner({ api }).runOnce({
          now: createISODateTime(event.scheduledAt),
        });
        if (result.stockReservations.status === "failed") {
          throw new Error(result.stockReservations.error);
        }
      },
    },
  });
}

export const mika = mikaPlugin;
export default mikaPlugin;
