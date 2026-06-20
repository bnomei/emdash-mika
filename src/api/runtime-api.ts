import type { MikaApiOverrides } from "./server";
import type { MikaOperationPolicy } from "./operation-policy";

let defaultMikaApiOverrides: MikaApiOverrides | undefined;
let defaultMikaOperationPolicy: MikaOperationPolicy | undefined;

export function setDefaultMikaApiOverrides(overrides: MikaApiOverrides | undefined): void {
  defaultMikaApiOverrides = overrides;
}

export function setDefaultMikaOperationPolicy(policy: MikaOperationPolicy | undefined): void {
  defaultMikaOperationPolicy = policy;
}

export function resolveMikaApiOverrides(
  overrides: MikaApiOverrides | undefined,
): MikaApiOverrides | undefined {
  return overrides ?? defaultMikaApiOverrides;
}

export function resolveMikaOperationPolicy(
  policy: MikaOperationPolicy | undefined,
): MikaOperationPolicy | undefined {
  return policy ?? defaultMikaOperationPolicy;
}
