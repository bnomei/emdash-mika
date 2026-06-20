import type { MikaRequestContext } from "./context";
import {
  callMikaOperation,
  mikaOperationDescriptor,
  type MikaApiOperation,
  type MikaApiOperationData,
} from "./operations";
import { runMikaOperationPolicy, type MikaOperationPolicy } from "./operation-policy";
import type { MikaApi } from "./server";
import type { MikaApiResult } from "./types";

export interface RunMikaOperationInput<TOperation extends MikaApiOperation = MikaApiOperation> {
  readonly operation: TOperation;
  readonly api: MikaApi;
  readonly ctx: MikaRequestContext;
  readonly input: unknown;
  readonly operationPolicy?: MikaOperationPolicy;
}

export async function runMikaOperation<TOperation extends MikaApiOperation>({
  operation,
  api,
  ctx,
  input,
  operationPolicy,
}: RunMikaOperationInput<TOperation>): Promise<MikaApiResult<MikaApiOperationData<TOperation>>> {
  const policyRejection = await runMikaOperationPolicy(operationPolicy, {
    descriptor: mikaOperationDescriptor(operation),
    ctx,
    input,
  });
  if (policyRejection) return policyRejection;

  return callMikaOperation(operation, api, ctx, input);
}
