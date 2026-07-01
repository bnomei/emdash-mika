/**
 * Public package entry for the EmDash Mika plugin: descriptor factory, plugin id/version constants,
 * and commerce operation descriptor types for host integration.
 */
export {
  MIKA_PACKAGE_NAME,
  MIKA_MAINTENANCE_CRON_SCHEDULE,
  MIKA_MAINTENANCE_CRON_TASK,
  MIKA_PLUGIN_ID,
  MIKA_PLUGIN_VERSION,
  createPlugin,
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
