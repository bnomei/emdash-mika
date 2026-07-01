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

export { mikaHiddenInput, mikaReturnToInput } from "@bnomei/emdash-mika/astro";

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
