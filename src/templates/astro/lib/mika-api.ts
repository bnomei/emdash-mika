// mika-template-version: 0.1.0
/**
 * Host backend API module for the Astro storefront template.
 * Replace the empty overrides with `createMikaBackendApi({ ... })` wired to host repositories,
 * providers, and notifications — see examples/backend-provider.md. Left unedited, plugin
 * construction fails loudly (assertWired) instead of answering 501 on every route.
 */
import type { MikaApiOverrides } from "@bnomei/emdash-mika/server";

/** Host-owned Mika backend implementation consumed by the plugin entrypoint and actions. */
export const api: MikaApiOverrides = {};
