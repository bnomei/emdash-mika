/**
 * Process-wide defaults for API overrides and operation policy merged at route construction.
 *
 * Host bootstrap registers defaults once via `setDefault*`; individual route factories may
 * override per call. Tests reset by passing `undefined`.
 */
import type { MikaApiOverrides } from "./server";
import type { MikaOperationPolicy } from "./operation-policy";

// Module-level singletons merged by resolve* when call sites omit explicit values.
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
