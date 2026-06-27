/**
 * Hidden form field builders for Astro Actions in the storefront template.
 * Sanitizes return and redirect paths before they are posted with mutations.
 */
import { mikaSafeReturnTo } from "@bnomei/emdash-mika/astro";

import { mikaTemplateRoutes } from "./routes";

/** Name/value pair for a hidden `<input>`; nullish values become empty strings. */
export function mikaHiddenInput(name: string, value: string | number | null | undefined) {
  return {
    name,
    value: value === null || value === undefined ? "" : String(value),
  };
}

/** Hidden `returnTo` field validated through {@link mikaSafeReturnTo}. */
export function mikaReturnToInput(returnTo: string) {
  return mikaHiddenInput("returnTo", mikaSafeReturnTo(returnTo));
}

/** Checkout redirect hidden fields with template route fallbacks. */
export function mikaRedirectInputs(input: {
  readonly successPath: string;
  readonly cancelPath: string;
  readonly returnTo: string;
}) {
  return {
    successPath: mikaHiddenInput(
      "successPath",
      mikaSafeReturnTo(input.successPath, { fallback: mikaTemplateRoutes.checkoutSuccess }),
    ),
    cancelPath: mikaHiddenInput(
      "cancelPath",
      mikaSafeReturnTo(input.cancelPath, { fallback: mikaTemplateRoutes.checkoutCancel }),
    ),
    returnTo: mikaReturnToInput(input.returnTo),
  };
}
