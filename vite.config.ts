/**
 * vite-plus project config for emdash-mika.
 * Wires formatting, oxlint type-aware linting, and Node test discovery.
 */
import { defineConfig } from "vite-plus";

const generatedPatterns = [
  ".frigg/**",
  "dist/**",
  "node_modules/**",
  "package-lock.json",
  // Preserve the checksum-pinned upstream ACP schema byte-for-byte.
  "test/fixtures/acp/schema.agentic_checkout.2025-09-29.json",
];

export default defineConfig({
  pack: {
    deps: {
      // Astro's slash subpaths and virtual colon modules must both remain host-provided.
      neverBundle: [/^astro(?::|\/)/, "react", "stripe"],
    },
  },
  fmt: {
    ignorePatterns: generatedPatterns,
  },
  lint: {
    ignorePatterns: generatedPatterns,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["test/*.test.ts"],
    environment: "node",
    pool: "forks",
  },
});
