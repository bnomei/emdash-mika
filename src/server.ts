/**
 * Server-side entry for wiring Mika commerce: MikaApi, backend repositories, request context,
 * email outbox runners, maintenance jobs, notification hooks, and the typed server client.
 */
/** Per-request actor, session, and locale context for server-side operation dispatch. */
export {
  createMikaRequestContext,
  type CreateMikaRequestContextInput,
  type MikaRequestContext,
  type MikaSessionAccess,
} from "./api/context";
/** Typed commerce API facade bound to backend repositories and provider adapters. */
export {
  assertMikaApiWired,
  createMikaApi,
  mikaApiMethodNames,
  type AssertMikaApiWiredOptions,
  type MikaApi,
  type MikaApiOverrides,
} from "./api/server";
/**
 * Repository port contracts a host persistence layer implements to back
 * {@link createMikaBackendApi}. Their document/record parameter types live on the
 * `/types/documents`, `/types/aggregates`, and `/types/operational` subpaths.
 */
export type {
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
} from "./api/backend";
/** Input and result shapes named by the repository port method signatures. */
export type {
  AccountDeleteEmailRedactionRepositoryInput,
  AccountDeleteMaintenanceStepRepositoryInput,
  AccountDeleteRequestCompletionRepositoryInput,
  AccountDeleteRequestFailureRepositoryInput,
  AdjustStockRepositoryInput,
  AdjustStockRepositoryResult,
  AdminAuditIdempotencyClaimResult,
  CatalogProviderPriceMatch,
  ConsumeReservedStockRepositoryInput,
  ConsumeReservedStockRepositoryResult,
  EmailCompleteRepositoryInput,
  EmailDeliveredRepositoryInput,
  EmailFailureRepositoryInput,
  EmailLeaseRepositoryInput,
  EmailSkipRepositoryInput,
  ExpireReservedStockRepositoryResult,
  ExtendReservationsRepositoryInput,
  ReleaseActiveReservationsByCustomerRepositoryInput,
  ReleaseExpiredReservationsRepositoryInput,
  ReleaseExpiredReservationsRepositoryResult,
  ReleaseReservedStockRepositoryInput,
  ReleaseReservedStockRepositoryResult,
  ReserveStockRepositoryInput,
  ReserveStockRepositoryResult,
  WorkflowFailureRepositoryInput,
  WorkflowLeaseRepositoryInput,
  WorkflowStepRepositoryInput,
} from "./storage/repositories";
/** Paginated result envelope underlying {@link MikaDocumentList}. */
export type { PaginatedStorageResult } from "./storage/collections";
/** Repository-backed backend implementation injected into {@link createMikaApi}. */
export {
  createMikaBackendApi,
  createMikaFixedRateCouponResolver,
  type CreateMikaBackendApiInput,
  type MikaBackendConfig,
  type MikaBackendDefaults,
  type MikaBackendDependencies,
  type MikaBackendHashHelper,
  type MikaBackendHashInput,
  type MikaBackendISODateTime,
  type MikaBackendIdFactory,
  type MikaBackendErrorObserver,
  type MikaBackendNow,
  type MikaBackendRepositories,
  type MikaCouponResolution,
  type MikaCouponResolver,
  type MikaCouponResolverInput,
} from "./api/backend";
/** Notification hook context shapes for commerce lifecycle emails and host callbacks. */
export type {
  MikaAccountDeleteRequestedNotificationContext,
  MikaAccountExportReadyNotificationContext,
  MikaCheckoutPaymentFailedNotificationContext,
  MikaDownloadReadyNotificationContext,
  MikaGenericNotificationContext,
  MikaLicenseIssuedNotificationContext,
  MikaMagicLinkNotificationPurpose,
  MikaMagicLinkRequestedNotificationContext,
  MikaNotificationContextMap,
  MikaNotificationHook,
  MikaNotificationHookResult,
  MikaNotificationIntent,
  MikaNotificationKind,
  MikaNotificationRecipientContext,
  MikaOrderConfirmedNotificationContext,
  MikaOrderConfirmedNotificationLine,
  MikaOpsWebhookFailedNotificationContext,
  MikaSubscriptionNotificationContext,
} from "./api/notifications";
/** Typed HTTP client for calling Mika operations from server routes and jobs. */
export {
  createMikaServerClient,
  type MikaServerClient,
  type MikaServerClientOptions,
} from "./api/server-client";
/** Durable email outbox runner and EmDash pipeline sender for transactional mail. */
export {
  createEmDashMikaEmailSender,
  createMikaEmailOutboxRunner,
  type MikaEmDashEmailMessage,
  type MikaEmDashEmailPipeline,
  type MikaEmDashEmailSenderOptions,
  type MikaEmailDeliveryMessage,
  type MikaEmailDeliveryResult,
  type MikaEmailOutboxRetryInput,
  type MikaEmailOutboxRunItem,
  type MikaEmailOutboxRunOptions,
  type MikaEmailOutboxRunResult,
  type MikaEmailOutboxRunner,
  type MikaEmailOutboxRunnerInput,
  type MikaEmailSender,
} from "./api/email-outbox";
/** Scheduled maintenance runner for stock release, outbox drain, and account delete jobs. */
export {
  createMikaMaintenanceRunner,
  type MikaMaintenanceRunner,
  type MikaMaintenanceRunOptions,
  type MikaMaintenanceRunResult,
} from "./api/maintenance";
/** Host policy toggles applied when constructing plugin routes and operation runners. */
export type { MikaOperationPolicy } from "./api/operation-policy";
/** Published commerce operation descriptor surfaced to hosts and agent manifests. */
export type { MikaOperationDescriptor } from "./api/operations";
