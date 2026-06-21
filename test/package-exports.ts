import type { mikaPlugin, MikaOperationDescriptor, MikaOperationPolicy } from "@bnomei/emdash-mika";
import type {
  createMikaAgentManifest,
  mikaAgentManifestJsonSchema,
  MikaAgentActionDescriptor,
  MikaActionRun,
  MikaAgentManifest,
  MikaAgentManifestJsonSchema,
} from "@bnomei/emdash-mika/agent";
import type { createMikaAdminActionsManifest } from "@bnomei/emdash-mika/admin";
import type { createMika, MikaAstroClient, MikaPurchaseModel } from "@bnomei/emdash-mika/astro";
import type {
  createMikaActions,
  MikaActionName,
  MikaActions,
  MikaOperationPolicy as MikaActionsOperationPolicy,
} from "@bnomei/emdash-mika/astro-actions";
import type { createMikaClient, MikaClient, MikaClientOptions } from "@bnomei/emdash-mika/client";
import type { MikaEmailInput, renderMikaEmail } from "@bnomei/emdash-mika/email";
import type { createMikaProviderRegistry, MikaProviderAdapter } from "@bnomei/emdash-mika/provider";
import type { MikaProvider } from "@bnomei/emdash-mika/react";
import type {
  assertMikaApiWired,
  CreateMikaBackendApiInput,
  createEmDashMikaEmailSender,
  createMikaBackendApi,
  createMikaEmailOutboxRunner,
  createMikaServerClient,
  MikaApi,
  MikaBackendDependencies,
  MikaEmailDeliveryMessage,
  MikaEmailOutboxRunner,
  MikaApiOverrides,
  MikaOperationPolicy as MikaServerOperationPolicy,
  MikaOperationDescriptor as MikaServerOperationDescriptor,
  MikaServerClient,
} from "@bnomei/emdash-mika/server";
import type {
  CartDTO,
  CartQuoteDTO,
  createMikaId,
  CurrencyCode,
  CheckoutPreviewDTO,
  DownloadDTO,
  ISODateTime,
  MikaActorContext,
  MikaId,
  MikaPaymentAuthorizationRef,
  MIKA_ERROR_CODES,
  MIKA_PROVIDER_CAPABILITIES,
  MikaApiResult,
  MoneyDTO,
  OrderSummaryDTO,
  ProviderHealthDTO,
  SellableDTO,
} from "@bnomei/emdash-mika/types";

export type PackageEntryContract = {
  readonly root: typeof mikaPlugin;
  readonly agent: typeof createMikaAgentManifest;
  readonly agentManifestSchema: typeof mikaAgentManifestJsonSchema;
  readonly agentManifestSchemaType: MikaAgentManifestJsonSchema;
  readonly agentManifest: MikaAgentManifest;
  readonly agentAction: MikaAgentActionDescriptor;
  readonly actionRun: MikaActionRun;
  readonly admin: typeof createMikaAdminActionsManifest;
  readonly astro: typeof createMika;
  readonly astroClient: MikaAstroClient;
  readonly purchase: MikaPurchaseModel;
  readonly actions: typeof createMikaActions;
  readonly actionsClient: MikaActions;
  readonly actionName: MikaActionName;
  readonly operationPolicy: MikaOperationPolicy;
  readonly operationDescriptor: MikaOperationDescriptor;
  readonly actionsOperationPolicy: MikaActionsOperationPolicy;
  readonly client: typeof createMikaClient;
  readonly clientFacade: MikaClient;
  readonly clientOptions: MikaClientOptions;
  readonly email: typeof renderMikaEmail;
  readonly emailInput: MikaEmailInput<"magic_link">;
  readonly provider: typeof createMikaProviderRegistry;
  readonly providerAdapter: MikaProviderAdapter;
  readonly react: typeof MikaProvider;
  readonly server: typeof createMikaServerClient;
  readonly serverFacade: MikaServerClient;
  readonly backend: typeof createMikaBackendApi;
  readonly emailOutboxRunnerFactory: typeof createMikaEmailOutboxRunner;
  readonly emdashEmailSenderFactory: typeof createEmDashMikaEmailSender;
  readonly emailOutboxRunner: MikaEmailOutboxRunner;
  readonly emailDeliveryMessage: MikaEmailDeliveryMessage;
  readonly assertWired: typeof assertMikaApiWired;
  readonly backendInput: CreateMikaBackendApiInput;
  readonly backendDependencies: MikaBackendDependencies;
  readonly api: MikaApi;
  readonly apiOverrides: MikaApiOverrides;
  readonly serverOperationPolicy: MikaServerOperationPolicy;
  readonly serverOperationDescriptor: MikaServerOperationDescriptor;
  readonly result: MikaApiResult<CartDTO | CartQuoteDTO | CheckoutPreviewDTO | ProviderHealthDTO>;
  readonly errorCodes: typeof MIKA_ERROR_CODES;
  readonly providerCapabilities: typeof MIKA_PROVIDER_CAPABILITIES;
  readonly actor: MikaActorContext;
  readonly paymentAuthorization: MikaPaymentAuthorizationRef;
  readonly idFactory: typeof createMikaId;
  readonly id: MikaId;
  readonly currency: CurrencyCode;
  readonly timestamp: ISODateTime;
  readonly money: MoneyDTO;
  readonly sellable: SellableDTO;
  readonly order: OrderSummaryDTO;
  readonly download: DownloadDTO;
};

export type MissingRootMikaApi =
  // @ts-expect-error Server API contracts are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaApi;

export type MissingRootMikaApiOverrides =
  // @ts-expect-error Server API contracts are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaApiOverrides;

export type MissingRootCreateMikaBackendApi =
  // @ts-expect-error Backend API composition is intentionally exported from the server subpath.
  typeof import("@bnomei/emdash-mika").createMikaBackendApi;

export type MissingApiSubpath =
  // @ts-expect-error The API internals are intentionally not a package subpath.
  typeof import("@bnomei/emdash-mika/api");

export type MissingOperationRegistry =
  // @ts-expect-error Operation metadata is intentionally internal to the source package.
  typeof import("@bnomei/emdash-mika/server").mikaOperationDefinitions;

export type MissingOperationRunner =
  // @ts-expect-error Operation execution helpers are intentionally internal.
  typeof import("@bnomei/emdash-mika/server").runMikaOperation;

export type MissingCallMikaOperation =
  // @ts-expect-error Dynamic operation dispatch is intentionally internal.
  typeof import("@bnomei/emdash-mika/server").callMikaOperation;

export type MissingRootAssertMikaApiWired =
  // @ts-expect-error Server wiring assertions are intentionally exported from the server subpath.
  typeof import("@bnomei/emdash-mika").assertMikaApiWired;

export type MissingAccidentalTypes =
  // @ts-expect-error Deprecated aliases should not appear through the published types barrel.
  import("@bnomei/emdash-mika/types").CouponResultDTO;
