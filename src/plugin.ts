/**
 * EmDash plugin descriptor and runtime registration for Mika commerce routes, storage collections,
 * and scheduled maintenance (stock reservation release, email outbox, ephemeral purge).
 */
import {
  definePlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginStorageConfig,
} from "emdash";

import type { MikaBackendRepositories } from "./api/backend";
import type { MikaEmailOutboxRunner } from "./api/email-outbox";
import { createMikaMaintenanceRunner, type MikaMaintenanceRunResult } from "./api/maintenance";
import { createMikaPluginRoutes } from "./api/route-handlers";
import { setDefaultMikaApiOverrides, setDefaultMikaOperationPolicy } from "./api/runtime-api";
import { MIKA_PLUGIN_ID } from "./api/routes";
import { createMikaApi, type MikaApiOverrides } from "./api/server";
import type { MikaOperationPolicy } from "./api/operation-policy";
import { mikaStorageConfig } from "./storage/collections";
import { createISODateTime } from "./types/primitives";

export { MIKA_PLUGIN_ID } from "./api/routes";

/** Published plugin semver wired into the EmDash descriptor and runtime. */
export const MIKA_PLUGIN_VERSION = "0.1.0";

/** npm package name used as the default plugin entrypoint. */
export const MIKA_PACKAGE_NAME = "@bnomei/emdash-mika";

/** Cron task name registered for Mika background maintenance. */
export const MIKA_MAINTENANCE_CRON_TASK = "mika_maintenance";

/** Default cron schedule for maintenance when the host does not override it. */
export const MIKA_MAINTENANCE_CRON_SCHEDULE = "* * * * *";

/** Descriptor-level toggles for the maintenance cron job. */
export interface MikaMaintenancePluginOptions {
  readonly enabled?: boolean;
  readonly schedule?: string;
}

/** Runtime dependencies injected when the maintenance cron handler executes. */
export interface MikaMaintenanceRuntimeOptions extends MikaMaintenancePluginOptions {
  readonly repositories?: Pick<
    MikaBackendRepositories,
    "account" | "ephemeral" | "ledger" | "ops" | "stock"
  >;
  readonly emailOutboxRunner?: MikaEmailOutboxRunner;
}

/** Options passed to the static plugin descriptor factory (`mikaPlugin`). */
export interface MikaDescriptorOptions {
  readonly entrypoint?: string;
  readonly api?: MikaApiOverrides;
  readonly operationPolicy?: MikaOperationPolicy;
  readonly maintenance?: MikaMaintenancePluginOptions;
}

/** Options resolved at plugin activation for API overrides, policy, and maintenance wiring. */
export interface MikaCreatePluginOptions {
  readonly api?: MikaApiOverrides;
  readonly operationPolicy?: MikaOperationPolicy;
  readonly maintenance?: MikaMaintenanceRuntimeOptions;
}

type MikaCronEvent = {
  readonly name: string;
  readonly scheduledAt: string;
};

/** Builds the EmDash plugin descriptor for Mika with storage, routes, and maintenance defaults. */
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

/** Registers the live Mika plugin: HTTP routes, storage schema, cron maintenance, and hooks. */
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
      await cancelMaintenance(_event, ctx);
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
      "plugin:deactivate": cancelMaintenance,
      "plugin:uninstall": cancelMaintenance,
      cron: async (event: MikaCronEvent, ctx: PluginContext) => {
        if (!maintenanceEnabled || event.name !== MIKA_MAINTENANCE_CRON_TASK) return;

        const result = await createMikaMaintenanceRunner({
          api,
          ...(maintenance.repositories ? { repositories: maintenance.repositories } : {}),
          ...(maintenance.emailOutboxRunner
            ? { emailOutboxRunner: maintenance.emailOutboxRunner }
            : {}),
        }).runOnce({
          now: createISODateTime(event.scheduledAt),
        });
        logMikaMaintenanceResult(ctx, result);
        if (result.stockReservations.status === "failed") {
          throw new Error(result.stockReservations.error);
        }
      },
    },
  });
}

async function cancelMaintenance(_event: unknown, ctx: PluginContext): Promise<void> {
  if (!ctx.cron) return;

  await ctx.cron.cancel(MIKA_MAINTENANCE_CRON_TASK);
}

function logMikaMaintenanceResult(ctx: PluginContext, result: MikaMaintenanceRunResult): void {
  const summary = summarizeMikaMaintenanceResult(result);
  const hasFailure = Object.values(summary.tasks).some((task) => task.status === "failed");

  if (hasFailure) {
    ctx.log.warn("Mika maintenance completed with failures", summary);
    return;
  }

  ctx.log.info("Mika maintenance completed", summary);
}

function summarizeMikaMaintenanceResult(result: MikaMaintenanceRunResult) {
  return {
    now: result.now,
    tasks: {
      emailOutbox: summarizeTask(result.emailOutbox, (taskResult) => ({
        scanned: taskResult.scanned,
        leased: taskResult.leased,
        sent: taskResult.sent,
        failed: taskResult.failed,
        skipped: taskResult.skipped,
        leaseMissed: taskResult.leaseMissed,
        leaseLost: taskResult.leaseLost,
        hasMore: taskResult.hasMore,
      })),
      stockReservations: summarizeTask(result.stockReservations, (taskResult) => ({
        reservationsScanned: taskResult.reservationsScanned,
        reservationsReleased: taskResult.reservationsReleased,
        stockItems: taskResult.stockItems,
      })),
      ephemeralRecords: summarizeTask(result.ephemeralRecords, (taskResult) => ({
        purged: taskResult.purged,
      })),
      accountDeleteRequests: summarizeTask(result.accountDeleteRequests, (taskResult) => ({
        scanned: taskResult.scanned,
        completed: taskResult.completed,
        failed: taskResult.failed,
        hasMore: taskResult.hasMore,
      })),
      stuckWorkflows: summarizeTask(result.stuckWorkflows, (taskResult) => ({
        scanned: taskResult.scanned,
        reclaimed: taskResult.reclaimed,
      })),
    },
  };
}

function summarizeTask<TResult extends object>(
  task:
    | { readonly status: "completed"; readonly result: TResult }
    | { readonly status: "failed"; readonly error: string }
    | { readonly status: "skipped"; readonly reason: string },
  summarize: (result: TResult) => Record<string, unknown>,
): Record<string, unknown> & { readonly status: string } {
  if (task.status === "completed") {
    return {
      status: task.status,
      ...summarize(task.result),
    };
  }

  if (task.status === "failed") {
    return {
      status: task.status,
      error: task.error,
    };
  }

  return {
    status: task.status,
    reason: task.reason,
  };
}

/** Alias for `mikaPlugin` used in EmDash plugin manifests. */
export const mika = mikaPlugin;
export default mikaPlugin;
