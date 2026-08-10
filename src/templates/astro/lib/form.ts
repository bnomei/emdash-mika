// mika-template-version: 0.1.0
/**
 * Compatibility shim for older copied Astro templates that imported form helpers locally.
 * Re-exports hidden-input and redirect helpers unchanged; new templates should import
 * directly from `@bnomei/emdash-mika/astro` so upgrades pick up the supported entrypoint.
 */
import {
  mikaRedirectInputs as baseMikaRedirectInputs,
  type MikaRedirectInputsInput,
  type MikaRedirectInputsOptions,
} from "@bnomei/emdash-mika/astro";

import { mikaTemplateRoutes } from "./routes";

/** Prefer importing form helpers from `@bnomei/emdash-mika/astro` in new templates. */
export { mikaHiddenInput, mikaReturnToInput } from "@bnomei/emdash-mika/astro";

/** Redirect hidden inputs with template checkout success/cancel fallbacks for copied Astro forms. */
export function mikaRedirectInputs(
  input: MikaRedirectInputsInput,
  options: MikaRedirectInputsOptions = {},
) {
  return baseMikaRedirectInputs(input, {
    successFallback: mikaTemplateRoutes.checkoutSuccess,
    cancelFallback: mikaTemplateRoutes.checkoutCancel,
    ...options,
  });
}
