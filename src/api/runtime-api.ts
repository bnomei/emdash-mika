import type { MikaApiOverrides } from "./server";

let defaultMikaApiOverrides: MikaApiOverrides | undefined;

export function setDefaultMikaApiOverrides(overrides: MikaApiOverrides | undefined): void {
  defaultMikaApiOverrides = overrides;
}

export function resolveMikaApiOverrides(
  overrides: MikaApiOverrides | undefined,
): MikaApiOverrides | undefined {
  return overrides ?? defaultMikaApiOverrides;
}
