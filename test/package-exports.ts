/**
 * Compile-time package export contract checks.
 * Ensures subpath barrels expose expected types and block accidental internals.
 */
import type { mikaPlugin } from "@bnomei/emdash-mika";
import type {
  createMikaAcpCheckoutHandlers,
  createMikaAcpProductFeed,
  MikaAcpCheckoutSession,
} from "@bnomei/emdash-mika/acp";
import type {
  createMikaAgentManifest,
  mikaAgentManifestJsonSchema,
  MikaAgentActionDescriptor,
  MikaActionRun,
  MikaActorContext,
  MikaAgentManifest,
  MikaAgentManifestJsonSchema,
  MikaPaymentAuthorizationRef,
} from "@bnomei/emdash-mika/agent";
import type { createMikaAdminActionsManifest } from "@bnomei/emdash-mika/admin";
import type {
  createMika,
  MikaAstroClient,
  MikaPurchaseModel,
  mikaHiddenInput,
  mikaRedirectInputs,
  mikaReturnToInput,
} from "@bnomei/emdash-mika/astro";
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
  createMikaEmailOutboxRunner as createMikaEmailOutboxRunnerFromServerEmail,
  MikaEmailOutboxRunner as MikaEmailOutboxRunnerFromServerEmail,
} from "@bnomei/emdash-mika/server/email";
import type {
  createMikaMaintenanceRunner as createMikaMaintenanceRunnerFromServerMaintenance,
  MikaMaintenanceRunner as MikaMaintenanceRunnerFromServerMaintenance,
} from "@bnomei/emdash-mika/server/maintenance";
import type {
  MikaStockRepositoryPort as MikaStockRepositoryPortFromServerPorts,
} from "@bnomei/emdash-mika/server/ports";
import type {
  assertMikaApiWired,
  CreateMikaBackendApiInput,
  createPlugin,
  createEmDashMikaEmailSender,
  createMikaBackendApi,
  createMikaEmailOutboxRunner,
  createMikaMaintenanceRunner,
  createMikaPlugin,
  createMikaServerClient,
  MikaApi,
  MikaBackendDependencies,
  MikaCreatePluginOptions,
  MikaEmailDeliveryMessage,
  MikaEmailOutboxRunner,
  MikaMaintenanceRunner,
  MikaMaintenanceRuntimeOptions,
  MikaMaintenanceRunnerInput,
  MikaApiOverrides,
  MikaAccountDeleteRequestedNotificationContext,
  MikaAccountExportReadyNotificationContext,
  MikaCheckoutPaymentFailedNotificationContext,
  MikaDownloadReadyNotificationContext,
  MikaLicenseIssuedNotificationContext,
  MikaMagicLinkRequestedNotificationContext,
  MikaNotificationHook,
  MikaNotificationHookResult,
  MikaNotificationIntent,
  MikaNotificationKind,
  MikaOrderConfirmedNotificationContext,
  MikaOpsWebhookFailedNotificationContext,
  MikaSubscriptionNotificationContext,
  MikaOperationPolicy as MikaServerOperationPolicy,
  MikaOperationDescriptor as MikaServerOperationDescriptor,
  MikaServerClient,
  MikaAccountDeleteJobRepositoryPort,
  MikaAccountRepositoryPort,
  MikaAdminAuditRepositoryPort,
  MikaCatalogRepositoryPort,
  MikaDocumentList,
  MikaEmailOutboxRepositoryPort,
  MikaEphemeralRepositoryPort,
  MikaLedgerRepositoryPort,
  MikaOpsRepositoryPort,
  MikaSessionRepositoryPort,
  MikaStockRepositoryPort,
  MikaWebhookRepositoryPort,
  MikaWorkflowRepositoryPort,
  PaginatedStorageResult,
  ReserveStockRepositoryInput,
  ReserveStockRepositoryResult,
  WorkflowLeaseRepositoryInput,
} from "@bnomei/emdash-mika/server";
import type { createMikaStripeProvider, MikaStripeClient } from "@bnomei/emdash-mika/stripe";
import type {
  CartLine,
  PriceDefinition,
  SellableDefinition,
} from "@bnomei/emdash-mika/types/aggregates";
import type {
  CartDocument,
  CatalogItemDocument,
  OrderDocument,
} from "@bnomei/emdash-mika/types/documents";
import type { EphemeralRecord, StockItemRecord } from "@bnomei/emdash-mika/types/operational";
import type {
  CartDTO,
  CartQuoteDTO,
  CheckoutCancelInput,
  CheckoutPreviewDTO,
  CheckoutStatusInput,
  createMikaId,
  CurrencyCode,
  DownloadDTO,
  ISODateTime,
  MikaId,
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
  readonly nativeRuntimeEntrypoint: typeof createPlugin;
  readonly runtimePlugin: typeof createMikaPlugin;
  readonly createPluginOptions: MikaCreatePluginOptions;
  readonly acpFeed: typeof createMikaAcpProductFeed;
  readonly acpCheckoutHandlers: typeof createMikaAcpCheckoutHandlers;
  readonly acpCheckoutSession: MikaAcpCheckoutSession;
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
  readonly hiddenInput: typeof mikaHiddenInput;
  readonly returnToInput: typeof mikaReturnToInput;
  readonly redirectInputs: typeof mikaRedirectInputs;
  readonly actions: typeof createMikaActions;
  readonly actionsClient: MikaActions;
  readonly actionName: MikaActionName;
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
  readonly maintenanceRunnerFactory: typeof createMikaMaintenanceRunner;
  /** Additive `/server/*` discoverability subpaths re-export the same symbols. */
  readonly serverPortsStock: MikaStockRepositoryPortFromServerPorts;
  readonly serverMaintenanceRunner: MikaMaintenanceRunnerFromServerMaintenance;
  readonly serverMaintenanceFactory: typeof createMikaMaintenanceRunnerFromServerMaintenance;
  readonly serverEmailRunner: MikaEmailOutboxRunnerFromServerEmail;
  readonly serverEmailFactory: typeof createMikaEmailOutboxRunnerFromServerEmail;
  readonly emdashEmailSenderFactory: typeof createEmDashMikaEmailSender;
  readonly emailOutboxRunner: MikaEmailOutboxRunner;
  readonly maintenanceRunner: MikaMaintenanceRunner;
  readonly maintenanceRuntimeOptions: MikaMaintenanceRuntimeOptions;
  readonly maintenanceRunnerInput: MikaMaintenanceRunnerInput;
  readonly emailDeliveryMessage: MikaEmailDeliveryMessage;
  readonly assertWired: typeof assertMikaApiWired;
  readonly backendInput: CreateMikaBackendApiInput;
  readonly backendDependencies: MikaBackendDependencies;
  readonly notificationKind: MikaNotificationKind;
  readonly notificationIntent: MikaNotificationIntent;
  readonly notificationHook: MikaNotificationHook;
  readonly notificationHookResult: MikaNotificationHookResult;
  readonly magicLinkNotificationContext: MikaMagicLinkRequestedNotificationContext;
  readonly orderConfirmedNotificationContext: MikaOrderConfirmedNotificationContext;
  readonly checkoutPaymentFailedNotificationContext: MikaCheckoutPaymentFailedNotificationContext;
  readonly downloadReadyNotificationContext: MikaDownloadReadyNotificationContext;
  readonly licenseIssuedNotificationContext: MikaLicenseIssuedNotificationContext;
  readonly subscriptionNotificationContext: MikaSubscriptionNotificationContext;
  readonly accountExportReadyNotificationContext: MikaAccountExportReadyNotificationContext;
  readonly accountDeleteRequestedNotificationContext: MikaAccountDeleteRequestedNotificationContext;
  readonly opsWebhookFailedNotificationContext: MikaOpsWebhookFailedNotificationContext;
  readonly api: MikaApi;
  readonly apiOverrides: MikaApiOverrides;
  readonly serverOperationPolicy: MikaServerOperationPolicy;
  readonly serverOperationDescriptor: MikaServerOperationDescriptor;
  readonly stripeProvider: typeof createMikaStripeProvider;
  readonly stripeClient: MikaStripeClient;
  readonly result: MikaApiResult<CartDTO | CartQuoteDTO | CheckoutPreviewDTO | ProviderHealthDTO>;
  /** Public operation inputs previously missing from the `/types` barrel. */
  readonly checkoutCancelInput: CheckoutCancelInput;
  readonly checkoutStatusInput: CheckoutStatusInput;
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
  readonly catalogRepositoryPort: MikaCatalogRepositoryPort;
  readonly sessionRepositoryPort: MikaSessionRepositoryPort;
  readonly accountRepositoryPort: MikaAccountRepositoryPort;
  readonly ledgerRepositoryPort: MikaLedgerRepositoryPort;
  readonly opsRepositoryPort: MikaOpsRepositoryPort;
  readonly webhookRepositoryPort: MikaWebhookRepositoryPort;
  readonly accountDeleteJobRepositoryPort: MikaAccountDeleteJobRepositoryPort;
  readonly workflowRepositoryPort: MikaWorkflowRepositoryPort;
  readonly adminAuditRepositoryPort: MikaAdminAuditRepositoryPort;
  readonly emailOutboxRepositoryPort: MikaEmailOutboxRepositoryPort;
  readonly stockRepositoryPort: MikaStockRepositoryPort;
  readonly ephemeralRepositoryPort: MikaEphemeralRepositoryPort;
  readonly sellableDefinition: SellableDefinition;
  readonly priceDefinition: PriceDefinition;
  readonly cartLine: CartLine;
  readonly catalogItemDocument: CatalogItemDocument;
  readonly cartDocument: CartDocument;
  readonly orderDocument: OrderDocument;
  readonly stockItemRecord: StockItemRecord;
  readonly ephemeralRecord: EphemeralRecord;
  readonly documentList: MikaDocumentList<CartDocument>;
  readonly paginatedResult: PaginatedStorageResult<{ id: string }>;
  readonly reserveStockInput: ReserveStockRepositoryInput;
  readonly reserveStockResult: ReserveStockRepositoryResult;
  readonly workflowLeaseInput: WorkflowLeaseRepositoryInput;
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

export type MissingRootCreateMikaPlugin =
  // @ts-expect-error Runtime plugin activation is intentionally exported from the server subpath.
  typeof import("@bnomei/emdash-mika").createMikaPlugin;

export type MissingRootMikaCreatePluginOptions =
  // @ts-expect-error Runtime plugin options are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaCreatePluginOptions;

export type MissingRootMikaMaintenanceRuntimeOptions =
  // @ts-expect-error Maintenance runtime dependencies are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaMaintenanceRuntimeOptions;

export type MissingRootMikaOperationDescriptor =
  // @ts-expect-error Operation descriptors are intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaOperationDescriptor;

export type MissingRootMikaOperationPolicy =
  // @ts-expect-error Operation policy is intentionally exported from the server subpath.
  import("@bnomei/emdash-mika").MikaOperationPolicy;

export type MissingApiSubpath =
  // @ts-expect-error The API internals are intentionally not a package subpath.
  typeof import("@bnomei/emdash-mika/api");

export type MissingModelSubpath =
  // @ts-expect-error Model internals are intentionally not a package subpath.
  typeof import("@bnomei/emdash-mika/model");

export type MissingStorageSubpath =
  // @ts-expect-error Storage internals are intentionally not a package subpath.
  typeof import("@bnomei/emdash-mika/storage");

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

export type MissingTypesAgentConstant =
  // @ts-expect-error Agent vocabulary is intentionally exported from the agent subpath.
  typeof import("@bnomei/emdash-mika/types").MIKA_AGENT_MANIFEST_VERSION;

export type MissingTypesAgentActor =
  // @ts-expect-error Agent actor contracts are intentionally exported from the agent subpath.
  import("@bnomei/emdash-mika/types").MikaActorContext;

export type MissingTypesAgentProof =
  // @ts-expect-error Agent proof contracts are intentionally exported from the agent subpath.
  import("@bnomei/emdash-mika/types").MikaPaymentAuthorizationRef;
