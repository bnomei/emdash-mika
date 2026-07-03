/** Wires the per-cluster backend modules into the full {@link MikaApi} implementation. */
import { catalogSellablesToDTO, stockAvailabilityToDTO } from "../../model/builders";
import { createMikaId } from "../../types/primitives";
import { createMikaAdminBackend } from "../backend-admin";
import { createMikaApi, type MikaApi } from "../server";
import {
  accountExportStatus,
  createAccountPortalSession,
  downloadAccountExport,
  getAccount,
  getOrderInvoice,
  requestAccountDelete,
  requestAccountExport,
} from "./account";
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
} from "./admin";
import { createCartBackend } from "./cart";
import { cancelCheckout, checkoutStatus, createCheckoutPreview, startCheckout } from "./checkout";
import { sellableNotFound, validationFailed } from "./errors";
import { resolveDownload } from "./fulfillment";
import { hydratedCheckoutOverrides, withHydratedCustomerHandler } from "./identity";
import { requestMagicLink, verifyMagicLink } from "./magic-link";
import type { CreateMikaBackendApiInput } from "./ports";
import { currentBackendISODateTime } from "./shared";
import { createMikaStockLifecycleService } from "./stock-lifecycle";
import { runSubscriptionAction } from "./subscriptions";
import { createWishlistBackend } from "./wishlist";
import { receiveWebhook, replayWebhook } from "./webhooks/ingest";

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
        if (!sellable?.active) return sellableNotFound(id);

        const stock = await input.repositories.stock.findBySellableId(id);
        if (!stock) return sellableNotFound(id);

        const availability = stockAvailabilityToDTO(sellable, stock);
        if (!availability) return sellableNotFound(id);

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
