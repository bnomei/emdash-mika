/**
 * Operation registry: descriptors, routes, agent metadata, schemas, and dispatch to {@link MikaApi}.
 * Single source of truth for plugin routes, action definitions, and agent manifests.
 *
 * Implementation is split across:
 * - {@link ./operation-define} — definition helpers and core types
 * - {@link ./operation-definitions} — const operation/route maps
 * - {@link ./operation-collect} — derived registries and descriptors
 */
/** Operation input transport helpers for body, search-param, and form-encoded requests. */
export { mikaOperationRequestInit, parseMikaOperationInput } from "./operation-transport";

export type {
  MikaOperationHttpMethod,
  MikaOperationTransport,
  MikaActionAccept,
  MikaOperationDescriptor,
  MikaApiOperationData,
} from "./operation-define";
export { MikaActionInputError } from "./operation-define";

export { mikaRouteOnlyDefinitions, mikaOperationDefinitions } from "./operation-definitions";
export type { MikaApiOperation, MikaRouteOnlyDefinition } from "./operation-definitions";

export {
  mikaRoutedOperationDefinitions,
  mikaRouteOperationsByPath,
  mikaOperationPluginRoutes,
  mikaOperationPublicRouteNames,
  mikaOperationApiMethodNames,
  mikaActionDefinitions,
  mikaOperationDescriptors,
  mikaOperationDescriptor,
  callMikaOperation,
} from "./operation-collect";
export type {
  MikaOperationPublicRouteName,
  MikaOperationApiMethodNames,
  MikaActionDefinitions,
  MikaActionName,
  MikaActionDefinition,
} from "./operation-collect";
