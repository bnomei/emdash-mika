/**
 * Process-wide defaults for API overrides and operation policy resolved at route construction.
 */
import type { MikaApiOverrides } from "./server";
import type { MikaOperationPolicy } from "./operation-policy";

let defaultMikaApiOverrides: MikaApiOverrides | undefined;
let defaultMikaOperationPolicy: MikaOperationPolicy | undefined;

/** Registers default {@link MikaApi} handler overrides for the current runtime. */
export function setDefaultMikaApiOverrides(overrides: MikaApiOverrides | undefined): void {
  defaultMikaApiOverrides = overrides;
}

/** Registers a default {@link MikaOperationPolicy} applied when routes omit an explicit policy. */
export function setDefaultMikaOperationPolicy(policy: MikaOperationPolicy | undefined): void {
  defaultMikaOperationPolicy = policy;
}

/** Merges call-site overrides with process defaults. */
export function resolveMikaApiOverrides(
  overrides: MikaApiOverrides | undefined,
): MikaApiOverrides | undefined {
  return overrides ?? defaultMikaApiOverrides;
}

/** Merges call-site policy with process defaults. */
export function resolveMikaOperationPolicy(
  policy: MikaOperationPolicy | undefined,
): MikaOperationPolicy | undefined {
  return policy ?? defaultMikaOperationPolicy;
}
