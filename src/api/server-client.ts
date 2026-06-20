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

export interface MikaServerClientOptions extends MikaClientOptions {
  readonly forwardCrossOriginCookies?: boolean;
}

export interface MikaServerClient extends MikaServerOperationFacade {
  readonly routes: MikaPluginRouteBuilder;
}

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
