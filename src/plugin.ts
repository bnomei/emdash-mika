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
export const MIKA_PLUGIN_VERSION = "0.1.0";
export const MIKA_PACKAGE_NAME = "@bnomei/emdash-mika";
export const MIKA_MAINTENANCE_CRON_TASK = "mika_maintenance";
export const MIKA_MAINTENANCE_CRON_SCHEDULE = "* * * * *";

export interface MikaMaintenancePluginOptions {
  readonly enabled?: boolean;
  readonly schedule?: string;
}

/**
 * Runtime maintenance options. The scheduled cron only releases expired stock
 * reservations (via `api.admin`) unless the host also supplies `repositories`
 * and `emailOutboxRunner` here — without them the email outbox, ephemeral
 * purge, and account-delete batch tasks report `skipped`. These are live
 * objects, so they can only be passed when calling `createPlugin` directly (not
 * through the serializable plugin descriptor).
 */
export interface MikaMaintenanceRuntimeOptions extends MikaMaintenancePluginOptions {
  readonly repositories?: Pick<MikaBackendRepositories, "ephemeral" | "ops" | "stock">;
  readonly emailOutboxRunner?: MikaEmailOutboxRunner;
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
  readonly maintenance?: MikaMaintenanceRuntimeOptions;
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
          // When the host wires these, the cron also drains the email outbox,
          // purges expired ephemeral records, and processes account-delete
          // batches. Without them only stock reservation release runs and the
          // other tasks report `skipped`.
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

export const mika = mikaPlugin;
export default mikaPlugin;
