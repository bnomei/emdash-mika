/**
 * Default Mika backend: repository ports, stock lifecycle, and full {@link MikaApi} wiring.
 * Implements cart, checkout, order, subscription, wishlist, webhook fulfillment, and admin flows.
 */
import { catalogSellablesToDTO, stockAvailabilityToDTO } from "../model/builders";
import { createMikaAdminBackend } from "./backend-admin";
import { createMikaId } from "../types/primitives";
import { createMikaApi, type MikaApi } from "./server";
// Repository ports and shared backend config/dependency types now live in ./backend/ports.
import type {
  MikaDocumentList,
  MikaCatalogRepositoryPort,
  MikaSessionRepositoryPort,
  MikaAccountRepositoryPort,
  MikaLedgerRepositoryPort,
  MikaWebhookRepositoryPort,
  MikaAccountDeleteJobRepositoryPort,
  MikaWorkflowRepositoryPort,
  MikaAdminAuditRepositoryPort,
  MikaEmailOutboxRepositoryPort,
  MikaOpsRepositoryPort,
  MikaStockRepositoryPort,
  MikaEphemeralRepositoryPort,
  MikaBackendRepositories,
  MikaBackendNow,
  MikaBackendISODateTime,
  MikaBackendIdFactory,
  MikaBackendHashInput,
  MikaBackendHashHelper,
  MikaBackendDefaults,
  MikaCouponResolution,
  MikaCouponResolverInput,
  MikaCouponResolver,
  MikaBackendConfig,
  MikaBackendErrorObserver,
  MikaBackendDependencies,
  CreateMikaBackendApiInput,
} from "./backend/ports";
import { currentBackendISODateTime } from "./backend/shared";
import { validationFailed } from "./backend/errors";
import { createMikaStockLifecycleService } from "./backend/stock-lifecycle";
import { hydratedCheckoutOverrides, withHydratedCustomerHandler } from "./backend/identity";
export { createMikaFixedRateCouponResolver } from "./backend/quote";
import { resolveDownload } from "./backend/fulfillment";
import { createCartBackend } from "./backend/cart";
import { createWishlistBackend } from "./backend/wishlist";
import {
  adminStockAdjustmentResult,
  cancelOrder,
  grantEntitlement,
  issueDownload,
  providerHealth,
  providerSync,
  refundOrder,
  releaseExpiredReservations,
  resendEmail,
  revokeEntitlement,
  revokeLicense,
} from "./backend/admin";
import {
  accountExportStatus,
  createAccountPortalSession,
  downloadAccountExport,
  getAccount,
  getOrderInvoice,
  requestAccountDelete,
  requestAccountExport,
} from "./backend/account";
import { requestMagicLink, verifyMagicLink } from "./backend/magic-link";
import { runSubscriptionAction } from "./backend/subscriptions";
import {
  cancelCheckout,
  checkoutStatus,
  createCheckoutPreview,
  startCheckout,
} from "./backend/checkout";
import { receiveWebhook, replayWebhook } from "./backend/webhooks/ingest";
export { createMikaStockLifecycleService } from "./backend/stock-lifecycle";
export type {
  ReserveStockInput,
  ReserveStockResult,
  ReleaseReservedStockInput,
  ReleaseReservedStockResult,
  ExpireReservedStockResult,
  ConsumeReservedStockInput,
  ConsumeReservedStockResult,
  ReleaseExpiredReservationsInput,
  ReleaseExpiredReservationsResult,
  ExtendReservationsInput,
  AdjustStockInput,
  AdjustStockResult,
  MikaStockLifecycleService,
} from "./backend/stock-lifecycle";
export type {
  MikaDocumentList,
  MikaCatalogRepositoryPort,
  MikaSessionRepositoryPort,
  MikaAccountRepositoryPort,
  MikaLedgerRepositoryPort,
  MikaWebhookRepositoryPort,
  MikaAccountDeleteJobRepositoryPort,
  MikaWorkflowRepositoryPort,
  MikaAdminAuditRepositoryPort,
  MikaEmailOutboxRepositoryPort,
  MikaOpsRepositoryPort,
  MikaStockRepositoryPort,
  MikaEphemeralRepositoryPort,
  MikaBackendRepositories,
  MikaBackendNow,
  MikaBackendISODateTime,
  MikaBackendIdFactory,
  MikaBackendHashInput,
  MikaBackendHashHelper,
  MikaBackendDefaults,
  MikaCouponResolution,
  MikaCouponResolverInput,
  MikaCouponResolver,
  MikaBackendConfig,
  MikaBackendErrorObserver,
  MikaBackendDependencies,
  CreateMikaBackendApiInput,
};

/** Creates the production {@link MikaApi} implementation from storage and provider adapters. */
export function createMikaBackendApi(input: CreateMikaBackendApiInput): MikaApi {
  return createMikaApi({
    ...input.overrides,
    catalog: {
      sellables: async ({ contentRef }) => {
        const catalogItem = await input.repositories.catalog.findItemByContent(contentRef);
        if (!catalogItem) {
          return { ok: true, status: 200, data: [] };
        }

        const activeSellables = catalogItem.aggregate.sellables.filter(
          (sellable) => sellable.active,
        );
        const stockRecords = await Promise.all(
          activeSellables.map(async (sellable) => ({
            sellableId: sellable.id,
            stock: await input.repositories.stock.findBySellableId(sellable.id),
          })),
        );
        const stockBySellableId = new Map(
          stockRecords.flatMap((record) =>
            record.stock ? [[record.sellableId, record.stock] as const] : [],
          ),
        );

        return {
          ok: true,
          status: 200,
          data: catalogSellablesToDTO({
            catalog: catalogItem.aggregate,
            stockBySellableId,
          }),
        };
      },
      ...input.overrides?.catalog,
    },
    stock: {
      availability: async ({ sellableId }) => {
        const id = createMikaId(sellableId);
        const catalog = await input.repositories.catalog.findItemBySellableId(id);
        const sellable = catalog?.aggregate.sellables.find((item) => item.id === id);
        if (!sellable?.active) {
          return {
            ok: false,
            status: 404,
            error: {
              code: "SELLABLE_NOT_FOUND",
              message: `Sellable '${sellableId}' was not found.`,
            },
          };
        }

        const stock = await input.repositories.stock.findBySellableId(id);
        if (!stock) {
          return {
            ok: false,
            status: 404,
            error: {
              code: "SELLABLE_NOT_FOUND",
              message: `Sellable '${sellableId}' was not found.`,
            },
          };
        }

        const availability = stockAvailabilityToDTO(sellable, stock);

        if (!availability) {
          return {
            ok: false,
            status: 404,
            error: {
              code: "SELLABLE_NOT_FOUND",
              message: `Sellable '${sellableId}' was not found.`,
            },
          };
        }

        return { ok: true, status: 200, data: availability };
      },
      ...input.overrides?.stock,
    },
    admin: createMikaAdminBackend({
      handlers: {
        providerHealth: async (healthInput) => providerHealth(input, healthInput),
        providerSync: async (syncInput) => providerSync(input, syncInput),
        stockAdjust: async (adjustment) => {
          if (!Number.isInteger(adjustment.quantityDelta) || adjustment.quantityDelta === 0) {
            return validationFailed(
              "quantityDelta",
              "Quantity delta must be a non-zero whole number.",
            );
          }

          const result = await createMikaStockLifecycleService(input).adjust({
            stockItemId: adjustment.stockItemId,
            quantityDelta: adjustment.quantityDelta,
            ...(adjustment.reason !== undefined ? { reason: adjustment.reason } : {}),
            ...(adjustment.adminAuditId !== undefined
              ? { adminAuditId: adjustment.adminAuditId }
              : {}),
            ...(adjustment.idempotencyKey !== undefined
              ? { idempotencyKey: adjustment.idempotencyKey }
              : {}),
            ...(adjustment.metadata !== undefined ? { metadata: adjustment.metadata } : {}),
            now: currentBackendISODateTime(input),
          });

          if (result.status === "not_found") {
            return {
              ok: false,
              status: 404,
              error: {
                code: "NOT_FOUND",
                message: `Stock item '${adjustment.stockItemId}' was not found.`,
                fieldErrors: { stockItemId: "Stock item was not found." },
              },
            };
          }

          if (result.status === "would_go_negative") {
            return {
              ok: false,
              status: 409,
              error: {
                code: "CONFLICT",
                message: `Stock adjustment for '${adjustment.stockItemId}' would make on-hand quantity negative.`,
              },
            };
          }

          if (result.status === "would_undercut_reserved") {
            return {
              ok: false,
              status: 409,
              error: {
                code: "CONFLICT",
                message: `Stock adjustment for '${adjustment.stockItemId}' would undercut active reservations.`,
              },
            };
          }

          if (result.status === "idempotency_conflict") {
            return {
              ok: false,
              status: 409,
              error: {
                code: "CONFLICT",
                message: `Stock adjustment idempotency key was reused for a different stock item.`,
              },
            };
          }

          return {
            ok: true,
            status: 200,
            data: adminStockAdjustmentResult(result),
          };
        },
        releaseExpiredReservations: async (releaseInput = {}) =>
          releaseExpiredReservations(input, releaseInput),
        webhookReplay: async (replayInput) => replayWebhook(input, replayInput),
        orderRefund: async (refundInput) => refundOrder(input, refundInput),
        orderCancel: async (cancelInput) => cancelOrder(input, cancelInput),
        entitlementGrant: async (grantInput) => grantEntitlement(input, grantInput),
        entitlementRevoke: async (revokeInput) => revokeEntitlement(input, revokeInput),
        emailResend: async (resendInput) => resendEmail(input, resendInput),
        licenseRevoke: async (revokeInput) => revokeLicense(input, revokeInput),
        downloadIssue: async (issueInput) => issueDownload(input, issueInput),
      },
      overrides: input.overrides?.admin,
    }),
    cart: createCartBackend(input),
    wishlist: createWishlistBackend(input),
    checkout: {
      start: withHydratedCustomerHandler(input, (ctx, checkoutInput) =>
        startCheckout(input, ctx, checkoutInput),
      ),
      status: withHydratedCustomerHandler(input, (ctx, statusInput) =>
        checkoutStatus(input, ctx, statusInput),
      ),
      cancel: withHydratedCustomerHandler(input, (ctx, cancelInput) =>
        cancelCheckout(input, ctx, cancelInput),
      ),
      preview: withHydratedCustomerHandler(input, async (ctx, previewInput) => {
        const preview = await createCheckoutPreview(input, ctx, previewInput);

        return { ok: true, status: 200, data: preview };
      }),
      ...hydratedCheckoutOverrides(input, input.overrides?.checkout),
    },
    magicLink: {
      request: async (ctx, requestInput) => requestMagicLink(input, ctx, requestInput),
      verify: async (ctx, verifyInput) => verifyMagicLink(input, ctx, verifyInput),
      ...input.overrides?.magicLink,
    },
    account: {
      get: async (ctx) => getAccount(input, ctx),
      export: async (ctx) => requestAccountExport(input, ctx),
      exportStatus: async (ctx, exportInput) => accountExportStatus(input, ctx, exportInput),
      exportDownload: async (ctx, downloadInput) =>
        downloadAccountExport(input, ctx, downloadInput),
      delete: async (ctx) => requestAccountDelete(input, ctx),
      portal: async (ctx, portalInput) => createAccountPortalSession(input, ctx, portalInput),
      ...input.overrides?.account,
    },
    subscription: {
      cancel: async (ctx, actionInput) => runSubscriptionAction(input, ctx, actionInput, "cancel"),
      change: async (ctx, actionInput) => runSubscriptionAction(input, ctx, actionInput, "change"),
      renew: async (ctx, actionInput) => runSubscriptionAction(input, ctx, actionInput, "renew"),
      ...input.overrides?.subscription,
    },
    download: {
      resolve: async (downloadInput) => resolveDownload(input, downloadInput, false),
      confirm: async (downloadInput) => resolveDownload(input, downloadInput, true),
      ...input.overrides?.download,
    },
    order: {
      invoice: async (ctx, invoiceInput) => getOrderInvoice(input, ctx, invoiceInput),
      ...input.overrides?.order,
    },
    webhook: {
      receive: async (ctx, webhookInput) => receiveWebhook(input, ctx, webhookInput),
      ...input.overrides?.webhook,
    },
  });
}
