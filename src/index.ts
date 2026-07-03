/**
 * Root package entry for the EmDash Mika plugin: descriptor factory, id/version constants, and
 * descriptor-safe options for host registration.
 *
 * Runtime wiring lives on subpaths (`/server`, `/astro`, `/astro-actions`, `/agent`, `/acp`,
 * `/stripe`, `/admin`, `/client`, `/email`, `/provider`, `/types`) — import those for API
 * construction, storefront templates, and provider adapters.
 */
/** Plugin descriptor factory, constants, and descriptor-safe options for EmDash host registration. */
export {
  MIKA_PACKAGE_NAME,
  MIKA_MAINTENANCE_CRON_SCHEDULE,
  MIKA_MAINTENANCE_CRON_TASK,
  MIKA_PLUGIN_ID,
  MIKA_PLUGIN_VERSION,
  MIKA_RUNTIME_ENTRYPOINT,
  mika,
  mikaPlugin,
  type MikaDescriptorOptions,
  type MikaDescriptorPluginOptions,
  type MikaMaintenancePluginOptions,
} from "./plugin";
