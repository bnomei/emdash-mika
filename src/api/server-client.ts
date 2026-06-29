/**
 * Server-side HTTP client with full operation facade (including admin and webhook namespaces).
 * Forwards same-origin cookies from the incoming request by default.
 */
import { createMikaClient, type MikaClientOptions } from "./client";
import {
  mikaOperationRequestInit,
  mikaOperationDefinitions,
  type MikaApiOperationData,
} from "./operations";
import { createMikaOperationFacade, type MikaServerOperationFacade } from "./operation-facade";
import { requestMika } from "./request";
import type { MikaRequestInit } from "./request";
import { createMikaPluginRouteBuilder, type MikaPluginRouteBuilder } from "./routes";
import type { MikaApiResult } from "./types";
import type { MikaPluginRouteName } from "./routes";

/** Server client options including cross-origin cookie forwarding control. */
export interface MikaServerClientOptions extends MikaClientOptions {
  readonly forwardCrossOriginCookies?: boolean;
}

/** {@link MikaServerOperationFacade} plus plugin route URL builder. */
export interface MikaServerClient extends MikaServerOperationFacade {
  readonly routes: MikaPluginRouteBuilder;
}

/** Creates a fetch client that invokes operations via plugin HTTP routes. */
export function createMikaServerClient(options: MikaServerClientOptions = {}): MikaServerClient {
  const request = <TData>(route: MikaPluginRouteName, init: MikaRequestInit = {}) =>
    requestMika<TData>(route, init, options);
  const requestOperation = <TOperation extends keyof typeof mikaOperationDefinitions>(
    operationKey: TOperation,
    input?: unknown,
  ): Promise<
    MikaApiResult<MikaApiOperationData<(typeof mikaOperationDefinitions)[TOperation]>>
  > => {
    const operation = mikaOperationDefinitions[operationKey];
    return request<MikaApiOperationData<(typeof mikaOperationDefinitions)[TOperation]>>(
      operation.routeKey as MikaPluginRouteName,
      mikaOperationRequestInit(operation, input),
    );
  };
  const routes = createMikaPluginRouteBuilder({
    apiBase: options.apiBase,
    pluginId: options.pluginId,
    origin: options.baseUrl ?? options.request?.url,
  });
  const facade = createMikaOperationFacade(requestOperation, {
    includeAdmin: true,
    includeWebhook: true,
  });

  return {
    ...createMikaClient(options),
    ...facade,
    routes,
  };
}
