// mika-template-version: 0.0.0
/**
 * Re-exports Mika Astro Actions from the package subpath.
 * Hosts should customize via `actions/index.ts` (`createMikaActions(options)`), not this shim.
 */
export {
  createMikaActions,
  type MikaActionName,
  type MikaActions,
  type MikaActionsOptions,
} from "@bnomei/emdash-mika/astro-actions";
