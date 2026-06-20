import { mikaSafeReturnTo } from "@bnomei/emdash-mika/astro";

import { mikaTemplateRoutes } from "./routes";

export function mikaHiddenInput(name: string, value: string | number | null | undefined) {
  return {
    name,
    value: value === null || value === undefined ? "" : String(value),
  };
}

export function mikaReturnToInput(returnTo: string) {
  return mikaHiddenInput("returnTo", mikaSafeReturnTo(returnTo));
}

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
