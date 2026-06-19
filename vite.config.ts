import { defineConfig } from "vite-plus";

const generatedPatterns = [".frigg/**", "dist/**", "node_modules/**", "package-lock.json"];

export default defineConfig({
  fmt: {
    ignorePatterns: generatedPatterns,
  },
  lint: {
    ignorePatterns: generatedPatterns,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
