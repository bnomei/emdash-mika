/**
 * Root package entry for the EmDash Mika plugin: descriptor factory, id/version constants, and
 * published operation descriptor types for host registration.
 *
 * Runtime wiring lives on subpaths (`/server`, `/astro`, `/astro-actions`, `/agent`, `/acp`,
 * `/stripe`, `/admin`, `/client`, `/email`, `/provider`, `/types`) — import those for API
 * construction, storefront templates, and provider adapters.
 */
/** Plugin descriptor factory, constants, and activation options for EmDash host registration. */
export {
  MIKA_PACKAGE_NAME,
  MIKA_MAINTENANCE_CRON_SCHEDULE,
  MIKA_MAINTENANCE_CRON_TASK,
  MIKA_PLUGIN_ID,
  MIKA_PLUGIN_VERSION,
  createMikaPlugin,
  mika,
  mikaPlugin,
  type MikaCreatePluginOptions,
  type MikaDescriptorOptions,
  type MikaMaintenancePluginOptions,
} from "./plugin";
/** Host policy toggles applied when constructing plugin routes and operation runners. */
export type { MikaOperationPolicy } from "./api/operation-policy";
/** Published commerce operation descriptor surfaced to hosts and agent manifests. */
export type { MikaOperationDescriptor } from "./api/operations";
