export function mikaHiddenInput(name: string, value: string | number | null | undefined) {
  return {
    name,
    value: value === null || value === undefined ? "" : String(value),
  };
}

export function mikaReturnToInput(returnTo: string) {
  return mikaHiddenInput("returnTo", returnTo);
}

export function mikaRedirectInputs(input: {
  readonly successPath: string;
  readonly cancelPath: string;
  readonly returnTo: string;
}) {
  return {
    successPath: mikaHiddenInput("successPath", input.successPath),
    cancelPath: mikaHiddenInput("cancelPath", input.cancelPath),
    returnTo: mikaReturnToInput(input.returnTo),
  };
}
