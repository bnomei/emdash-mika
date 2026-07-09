/**
 * EmDash plugin descriptor and runtime registration for Mika commerce routes, storage collections,
 * and scheduled maintenance (stock reservation release, email outbox, ephemeral purge).
 *
 * Descriptor storage uses {@link toDescriptorStorageConfig} (single-field indexes only).
 * Runtime {@link definePlugin} uses {@link toPluginStorageConfig} (full composites).
 */
import { definePlugin, type PluginContext, type PluginDescriptor } from "emdash";
import { optionalProperty } from "./internal/object";

/** Host capabilities the Mika plugin requests, shared by the descriptor and the runtime plugin. */
const MIKA_PLUGIN_CAPABILITIES = ["content:read", "email:send"] as const;

import type { MikaBackendRepositories } from "./api/backend";
import type { MikaEmailOutboxRunner } from "./api/email-outbox";
import { createMikaMaintenanceRunner, type MikaMaintenanceRunResult } from "./api/maintenance";
import { createMikaPluginRoutes } from "./api/route-handlers";
import { MIKA_PLUGIN_ID } from "./api/routes";
import {
  assertMikaApiWired,
  createMikaApi,
  isMikaApiWiringError,
  type MikaApiOverrides,
} from "./api/server";
import type { MikaOperationPolicy } from "./api/operation-policy";
import {
  mikaStorageConfig,
  toDescriptorStorageConfig,
  toPluginStorageConfig,
} from "./storage/collections";
import { createISODateTime } from "./types/primitives";
import type { MikaAcpSessionStore } from "./api/acp-session";

/** Stable EmDash plugin id registered for Mika routes and storage. */
export { MIKA_PLUGIN_ID } from "./api/routes";

/**
 * Published plugin semver wired into the EmDash descriptor and runtime — must match the
 * package.json version exactly (test/index.test.ts asserts this on every publish gate run).
 */
export const MIKA_PLUGIN_VERSION = "0.0.0";

/** npm package name used to derive package-owned descriptor and runtime entrypoints. */
export const MIKA_PACKAGE_NAME = "@bnomei/emdash-mika";

/** Default runtime entrypoint imported by EmDash hosts for native plugin activation. */
export const MIKA_RUNTIME_ENTRYPOINT = `${MIKA_PACKAGE_NAME}/server`;

/** Cron task name registered for Mika background maintenance. */
export const MIKA_MAINTENANCE_CRON_TASK = "mika_maintenance";

/** Default cron schedule for maintenance when the host does not override it. */
export const MIKA_MAINTENANCE_CRON_SCHEDULE = "* * * * *";

/** Descriptor-level toggles for the maintenance cron job. */
export interface MikaMaintenancePluginOptions {
  /** When false, the maintenance cron task is not registered. */
  readonly enabled?: boolean;
  /** Cron expression override; defaults to {@link MIKA_MAINTENANCE_CRON_SCHEDULE}. */
  readonly schedule?: string;
}

/** Runtime dependencies injected when the maintenance cron handler executes. */
export interface MikaMaintenanceRuntimeOptions extends MikaMaintenancePluginOptions {
  /** Repository ports injected into maintenance sweeps when the host uses a custom backend. */
  readonly repositories?: Pick<
    MikaBackendRepositories,
    "account" | "ephemeral" | "ledger" | "ops" | "session" | "stock"
  >;
  /** ACP session store for expired-session cleanup during maintenance. */
  readonly acpSessionStore?: MikaAcpSessionStore;
  /** Email outbox runner for lease-based delivery sweeps. */
  readonly emailOutboxRunner?: MikaEmailOutboxRunner;
}

/** JSON-safe options carried by the static plugin descriptor into the host entrypoint module. */
export interface MikaDescriptorPluginOptions {
  /** Descriptor-level maintenance cron toggles. */
  readonly maintenance?: MikaMaintenancePluginOptions;
  /** Wiring assertion forwarded to {@link createMikaPlugin}; see {@link MikaCreatePluginOptions}. */
  readonly assertWired?: boolean | readonly string[];
}

/** Options passed to the static plugin descriptor factory (`mikaPlugin`). */
export interface MikaDescriptorOptions extends MikaDescriptorPluginOptions {
  /** npm package name or path used as the plugin entrypoint in the descriptor. */
  readonly entrypoint?: string;
}

/** Options resolved at plugin activation for API overrides, policy, and maintenance wiring. */
export interface MikaCreatePluginOptions {
  /** Runtime API handler overrides merged at route construction. */
  readonly api?: MikaApiOverrides;
  /** Runtime operation policy for plugin route handlers. */
  readonly operationPolicy?: MikaOperationPolicy;
  /** Maintenance cron dependencies resolved when the cron handler runs. */
  readonly maintenance?: MikaMaintenanceRuntimeOptions;
  /**
   * Asserts the constructed MikaApi has no not-implemented stubs at plugin construction, so a
   * missing backend fails loudly instead of answering 501 on every route at runtime. Defaults to
   * asserting every namespace; pass a scope array (namespace or `namespace.method` names) to
   * assert a subset, or `false` to accept partial wiring.
   */
  readonly assertWired?: boolean | readonly string[];
}

type MikaCronEvent = {
  readonly name: string;
  readonly scheduledAt: string;
};

/** Builds the EmDash plugin descriptor for Mika with storage, routes, and maintenance defaults. */
export function mikaPlugin(
  options: MikaDescriptorOptions = {},
): PluginDescriptor<MikaDescriptorPluginOptions> {
  const runtimeOptions = options as MikaDescriptorOptions &
    Partial<Pick<MikaCreatePluginOptions, "api" | "operationPolicy">>;
  const dropped = (["api", "operationPolicy"] as const).filter(
    (key) => runtimeOptions[key] !== undefined,
  );
  if (dropped.length > 0) {
    throw new Error(
      `mikaPlugin() received ${dropped.join(" and ")} in descriptor options, but the EmDash host ` +
        "JSON-serializes descriptor options into a generated module, so function values are " +
        "silently dropped before createPlugin() runs" +
        (dropped.includes("operationPolicy")
          ? " — a dropped operationPolicy would silently disable the host's authorization guard"
          : "") +
        ". Move live wiring into a host entrypoint module that exports createPlugin(options) " +
        "and merges it (copyable template: src/templates/astro/lib/mika-plugin.ts), then register " +
        'it with mikaPlugin({ entrypoint: fileURLToPath(new URL("./src/lib/mika-plugin.ts", ' +
        "import.meta.url)) }). Only JSON-safe options (maintenance.enabled, maintenance.schedule, " +
        "assertWired) cross the descriptor boundary.",
    );
  }
  assertDescriptorSafeOptions(options);
  const entrypoint = options.entrypoint ?? MIKA_RUNTIME_ENTRYPOINT;
  const descriptorMaintenance =
    options.maintenance === undefined
      ? undefined
      : {
          ...(options.maintenance.enabled === undefined
            ? {}
            : { enabled: options.maintenance.enabled }),
          ...(options.maintenance.schedule === undefined
            ? {}
            : { schedule: options.maintenance.schedule }),
        };
  const pluginOptions: MikaDescriptorPluginOptions = {
    ...(descriptorMaintenance === undefined ? {} : { maintenance: descriptorMaintenance }),
    ...(options.assertWired === undefined ? {} : { assertWired: options.assertWired }),
  };

  return {
    id: MIKA_PLUGIN_ID,
    version: MIKA_PLUGIN_VERSION,
    format: "native",
    entrypoint,
    options: pluginOptions,
    capabilities: [...MIKA_PLUGIN_CAPABILITIES],
    // Descriptor declaration only accepts single-field indexes; composites flatten.
    storage: toDescriptorStorageConfig(mikaStorageConfig),
  };
}

function assertDescriptorSafeOptions(options: MikaDescriptorOptions): void {
  const descriptorOptions = options as {
    readonly entrypoint?: unknown;
    readonly maintenance?: {
      readonly enabled?: unknown;
      readonly schedule?: unknown;
    };
    readonly assertWired?: unknown;
  };
  if (
    descriptorOptions.entrypoint !== undefined &&
    typeof descriptorOptions.entrypoint !== "string"
  ) {
    throw new Error("mikaPlugin() descriptor option entrypoint must be a string.");
  }

  if (descriptorOptions.maintenance !== undefined) {
    if (
      typeof descriptorOptions.maintenance !== "object" ||
      descriptorOptions.maintenance === null ||
      Array.isArray(descriptorOptions.maintenance)
    ) {
      throw new Error(
        "mikaPlugin() descriptor option maintenance must be an object with JSON-safe enabled and schedule fields.",
      );
    }
    if (
      descriptorOptions.maintenance.enabled !== undefined &&
      typeof descriptorOptions.maintenance.enabled !== "boolean"
    ) {
      throw new Error("mikaPlugin() descriptor option maintenance.enabled must be a boolean.");
    }
    if (
      descriptorOptions.maintenance.schedule !== undefined &&
      typeof descriptorOptions.maintenance.schedule !== "string"
    ) {
      throw new Error("mikaPlugin() descriptor option maintenance.schedule must be a string.");
    }
  }

  if (
    descriptorOptions.assertWired !== undefined &&
    typeof descriptorOptions.assertWired !== "boolean" &&
    !isStringArray(descriptorOptions.assertWired)
  ) {
    throw new Error(
      "mikaPlugin() descriptor option assertWired must be a boolean or an array of strings.",
    );
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") {
      return false;
    }
  }

  return true;
}

/**
 * Registers the live Mika plugin: HTTP routes, storage schema, cron maintenance, and hooks.
 * Call this from a host entrypoint module (see {@link MikaDescriptorOptions.entrypoint}) — the
 * module's own exported function must be named `createPlugin` to match what the EmDash host's
 * generated virtual module calls, so wrap this as `export function createPlugin(options) {
 * return createMikaPlugin({ ...options, api }); }` (copyable template:
 * `src/templates/astro/lib/mika-plugin.ts`).
 *
 * @returns EmDash plugin runtime from `definePlugin`.
 */
export function createMikaPlugin(options: MikaCreatePluginOptions = {}) {
  const api = createMikaApi(options.api);
  const assertWired = options.assertWired ?? true;
  if (assertWired !== false) {
    try {
      assertMikaApiWired(api, Array.isArray(assertWired) ? { scope: assertWired } : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMikaApiWiringError(error, "unknown_scope")) {
        throw new Error(
          `${message} Check the assertWired entries against MikaApi namespace and 'namespace.method' names.`,
        );
      }
      const wiringHint =
        options.api !== undefined
          ? "An api option was provided but its methods are missing — if it was passed through mikaPlugin() in astro.config, note the EmDash host JSON-serializes descriptor options, so live functions cannot cross; register a host entrypoint module that calls createMikaPlugin({ api }) with the live backend instead. If the entrypoint module imports the mika-api template stub, replace its empty overrides with the host backend (createMikaBackendApi())."
          : "Wire the backend (e.g. createMikaBackendApi()) into the plugin's api option.";
      throw new Error(
        `${message} Every unwired method answers 501 at runtime. ${wiringHint} Scope the check with assertWired: ["cart", ...] or pass assertWired: false to accept partial wiring.`,
      );
    }
  }
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
    capabilities: [...MIKA_PLUGIN_CAPABILITIES],
    storage: toPluginStorageConfig(mikaStorageConfig),
    routes: createMikaPluginRoutes(api, {
      ...optionalProperty("operationPolicy", options.operationPolicy),
    }),
    hooks: {
      "plugin:install": registerMaintenance,
      "plugin:activate": registerMaintenance,
      "plugin:deactivate": cancelMaintenance,
      "plugin:uninstall": cancelMaintenance,
      cron: async (event: MikaCronEvent, ctx: PluginContext) => {
        if (!maintenanceEnabled || event.name !== MIKA_MAINTENANCE_CRON_TASK) return;

        const result = await createMikaMaintenanceRunner({
          api,
          ...(maintenance.acpSessionStore ? { acpSessionStore: maintenance.acpSessionStore } : {}),
          ...(maintenance.repositories ? { repositories: maintenance.repositories } : {}),
          ...(maintenance.emailOutboxRunner
            ? { emailOutboxRunner: maintenance.emailOutboxRunner }
            : {}),
        }).runOnce({
          now: createISODateTime(event.scheduledAt),
        });
        logMikaMaintenanceResult(ctx, result);
        // Only stock-reservation failure fails the cron; other task failures are logged as warnings.
        if (result.stockReservations.status === "failed") {
          throw new Error(result.stockReservations.error);
        }
      },
    },
  });
}

/** Native EmDash runtime entrypoint used by descriptors that point at `@bnomei/emdash-mika/server`. */
export function createPlugin(options: MikaCreatePluginOptions = {}) {
  return createMikaPlugin(options);
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
      stuckEmails: summarizeTask(result.stuckEmails, (taskResult) => ({
        scanned: taskResult.scanned,
        reclaimed: taskResult.reclaimed,
      })),
      rawProviderPayloads: summarizeTask(result.rawProviderPayloads, (taskResult) => ({
        scanned: taskResult.scanned,
        purged: taskResult.purged,
      })),
      acpSessions: summarizeTask(result.acpSessions, (taskResult) => ({
        scanned: taskResult.scanned,
        expired: taskResult.expired,
        purged: taskResult.purged,
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
      webhookRetries: summarizeTask(result.webhookRetries, (taskResult) => ({
        scanned: taskResult.scanned,
        retried: taskResult.retried,
        skippedExhausted: taskResult.skippedExhausted,
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

/** Alias for `mikaPlugin` used in EmDash plugin manifests. */
export const mika = mikaPlugin;
/** Default export alias for EmDash manifest entrypoints. */
export default mikaPlugin;
