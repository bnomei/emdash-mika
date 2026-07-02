// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

/**
 * Minimal Astro project whose only job is to type-check the copyable Mika
 * storefront templates with the real Astro compiler (`astro check`).
 *
 * `src/` is a symlink to `../../../src/templates/astro`, so the files checked
 * here are the actual templates a host would copy — not a stale duplicate.
 * The React integration is required so `.astro` files that mount the Kumo
 * React shell (`MikaKumoAppFrame.tsx` via `client:load`) resolve correctly.
 */
export default defineConfig({
  integrations: [react()],
});
