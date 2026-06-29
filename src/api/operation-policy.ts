/**
 * Optional host policy gate evaluated before each operation runs (auth, rate limits, feature flags).
 */
import type { MikaRequestContext } from "./context";
import type { MikaOperationDescriptor } from "./operations";
import type { MikaApiResult } from "./types";

/** Inputs available to a policy function for an impending operation call. */
export interface MikaOperationPolicyInput {
  readonly descriptor: MikaOperationDescriptor;
  readonly ctx: MikaRequestContext;
  readonly input: unknown;
}

/** `true`/void allows; `false` forbids; a failed result rejects with that envelope. */
export type MikaOperationPolicyDecision = MikaApiResult<never> | boolean | void;

/** Host-defined authorization or guard executed before operation dispatch. */
export type MikaOperationPolicy = (
  input: MikaOperationPolicyInput,
) => MikaOperationPolicyDecision | Promise<MikaOperationPolicyDecision>;

/** Normalizes a policy decision into a rejection result, if any. */
export async function runMikaOperationPolicy(
  policy: MikaOperationPolicy | undefined,
  input: MikaOperationPolicyInput,
): Promise<MikaApiResult<never> | undefined> {
  if (!policy) return undefined;

  const decision = await policy(input);
  if (decision === undefined || decision === true) return undefined;
  if (decision === false) return operationForbidden(input.descriptor.name);
  if (decision.ok) return undefined;
  return decision;
}

function operationForbidden(operation: string): MikaApiResult<never> {
  return {
    ok: false,
    status: 403,
    error: {
      code: "FORBIDDEN",
      message: `Mika operation '${operation}' is not allowed.`,
    },
  };
}
