/**
 * Provider-feature dispatch: resolves a configured provider adapter method (checking capability
 * and availability) into a callable, or a structured failure. Shared by admin, account, checkout,
 * and subscription flows — it is provider plumbing, not audit-specific, so it lives on its own
 * rather than inside admin-audit.ts.
 */
import type { MikaProviderAdapter } from "../../provider";
import type { MikaProviderCapability } from "../types";
import type { ProviderName } from "../../types/primitives";
import { providerFailed, providerUnsupportedForAction } from "./errors";
import type { MikaApiFailure } from "./errors";
import type { MikaBackendDependencies } from "./ports";

export type MikaProviderMethodName = Extract<
  {
    readonly [K in keyof MikaProviderAdapter]: NonNullable<MikaProviderAdapter[K]> extends (
      ...args: any[]
    ) => any
      ? K
      : never;
  }[keyof MikaProviderAdapter],
  keyof MikaProviderAdapter
>;

export type MikaProviderFeature<TMethod extends MikaProviderMethodName> =
  | {
      readonly ok: true;
      readonly providerName: ProviderName;
      readonly provider: MikaProviderAdapter;
      readonly method: NonNullable<MikaProviderAdapter[TMethod]>;
    }
  | MikaApiFailure;

export interface MikaProviderFeatureOptions<TMethod extends MikaProviderMethodName> {
  readonly providerName?: ProviderName;
  readonly method: TMethod;
  readonly capability?: MikaProviderCapability;
  readonly capabilityFailureMessage?: string;
  readonly missingProviderMessage?: string;
  readonly unsupportedMessage: (providerName: ProviderName) => string;
}

export async function requireProviderFeature<TMethod extends MikaProviderMethodName>(
  input: MikaBackendDependencies,
  options: MikaProviderFeatureOptions<TMethod>,
): Promise<MikaProviderFeature<TMethod>> {
  const providerName = options.providerName ?? input.defaults?.provider;
  if (!providerName) {
    return providerUnsupportedForAction(
      options.missingProviderMessage ?? "No provider is configured.",
    );
  }

  const provider = input.providers.get(providerName);
  if (!provider) {
    return providerUnsupportedForAction(`Provider '${providerName}' is not configured.`);
  }

  if (options.capability) {
    let capabilities: readonly MikaProviderCapability[];
    try {
      capabilities = await provider.capabilities();
    } catch {
      return providerFailed(
        options.capabilityFailureMessage ?? "Provider capabilities could not be verified.",
      );
    }
    if (!capabilities.includes(options.capability)) {
      return providerUnsupportedForAction(options.unsupportedMessage(providerName));
    }
  }

  const method = provider[options.method];
  if (typeof method !== "function") {
    return providerUnsupportedForAction(options.unsupportedMessage(providerName));
  }

  return {
    ok: true,
    providerName,
    provider,
    method: method as NonNullable<MikaProviderAdapter[TMethod]>,
  };
}
