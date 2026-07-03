// mika-template-version: 0.0.0
/**
 * EmDash plugin entrypoint for the Astro storefront template.
 * The EmDash host JSON-serializes `mikaPlugin()` descriptor options into a generated module, so
 * live wiring (backend api, operation policy, maintenance runtime deps) must merge here, on the
 * host side of that boundary. Register with
 * `mikaPlugin({ entrypoint: fileURLToPath(new URL("./src/lib/mika-plugin.ts", import.meta.url)) })`.
 */
import { createMikaPlugin, type MikaCreatePluginOptions } from "@bnomei/emdash-mika/server";

import { api } from "./mika-api";

/**
 * Called by the EmDash host with the JSON-round-tripped descriptor options from `mikaPlugin()`
 * (`maintenance.enabled`, `maintenance.schedule`, `assertWired`); merges the live backend api.
 * Exported as `createPlugin` because the EmDash host's generated virtual module imports and
 * calls the entrypoint's export by that name — do not rename this export.
 */
export function createPlugin(options: MikaCreatePluginOptions = {}) {
  return createMikaPlugin({
    ...options,
    api,
    // operationPolicy,  // merge a live host authorization guard here when one exists
    // maintenance: { ...options.maintenance, repositories, emailOutboxRunner },  // live cron deps
  });
}
