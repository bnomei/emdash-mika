/**
 * Admin action handlers: provider health/sync, order refund/cancel, entitlement grant/revoke,
 * email resend, license revoke, and download issuance. Each wraps its provider call or repository
 * mutation in the audited, idempotency-keyed admin action runner from ./admin-audit.
 */
import type { AdjustStockRepositoryResult } from "../../storage/repositories";
import { omitUndefined } from "../../internal/object";
import type { EntitlementDocument, LicenseDocument } from "../../types/documents";
import { createMikaId } from "../../types/primitives";
import type { ISODateTime, JsonObject, ProviderName } from "../../types/primitives";
import type { MikaProviderOrderCancelInput, MikaProviderRefundInput } from "../../provider";
import type {
  AdminActionResultDTO,
  DownloadIssueInput,
  EmailResendInput,
  EntitlementGrantInput,
  EntitlementRevokeInput,
  LicenseRevokeInput,
  MikaApiResult,
  OrderCancelInput,
  OrderRefundInput,
  ProviderHealthDTO,
  ProviderHealthInput,
  ProviderSyncInput,
} from "../types";
import {
  assertCompletedProviderAction,
  missingTargetWithAudit,
  runAdminProviderAction,
  runAdminRepositoryAction,
  toIdempotencyJson,
} from "./admin-audit";
import { requireProviderFeature } from "./provider-dispatch";
import {
  emitBackendNotification,
  observeBackendError,
  orderNotFound,
  orderNotificationRecipient,
  providerFailed,
  providerUnsupportedForAction,
  validationFailed,
} from "./errors";
import {
  addDownloadRefToOrder,
  createManualEntitlementDocument,
  findEntitlementsForRevoke,
  resolveDownloadIssueTarget,
  revokeOrderFulfillmentAccess,
} from "./fulfillment";
import {
  applyOrderCancel,
  applyOrderRefund,
  orderIsPaymentTerminal,
  orderRefundedAmount,
} from "../lifecycle";
import type { MikaBackendDependencies } from "./ports";
import { addMilliseconds, currentBackendISODateTime, emailHashKey } from "./shared";
import { createMikaStockLifecycleService } from "./stock-lifecycle";
import { hashDownloadToken, orderDownloadSubjectHash } from "./tokens";

export async function providerHealth(
  input: MikaBackendDependencies,
  healthInput: ProviderHealthInput,
): Promise<MikaApiResult<ProviderHealthDTO>> {
  const providerName = healthInput.provider ?? input.defaults?.provider;
  if (!providerName) return providerUnsupportedForAction("No provider is configured.");

  const provider = input.providers.get(providerName);
  if (!provider)
    return providerUnsupportedForAction(`Provider '${providerName}' is not configured.`);

  try {
    const health =
      (await provider.health?.()) ??
      ({
        provider: providerName,
        ok: true,
        capabilities: await provider.capabilities(),
        checkedAt: currentBackendISODateTime(input),
      } satisfies ProviderHealthDTO);

    return { ok: true, status: 200, data: health };
  } catch (error) {
    // Admin-only diagnostic surface: the message stays, but the error object no longer vanishes.
    observeBackendError(input, "admin.providerHealth", error, { provider: providerName });
    return providerFailed(error instanceof Error ? error.message : "Provider health check failed.");
  }
}

export async function providerSync(
  input: MikaBackendDependencies,
  syncInput: ProviderSyncInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  if (syncInput.scope === "entry" && !syncInput.contentRef) {
    return validationFailed("contentRef", "Entry-scoped provider sync requires contentRef.");
  }

  const providerFeature = await requireProviderFeature(
    input,
    omitUndefined({
      providerName: syncInput.provider,
      method: "syncCatalog",
      unsupportedMessage: (providerName: ProviderName) =>
        `Provider '${providerName}' does not support catalog sync.`,
    }),
  );
  if (!providerFeature.ok) return providerFeature;

  const providerInput = {
    mode: syncInput.mode ?? "dry_run",
    ...(syncInput.scope ? { scope: syncInput.scope } : {}),
    ...(syncInput.contentRef ? { contentRef: syncInput.contentRef } : {}),
  };
  const syncMetadata: JsonObject = {
    provider: providerFeature.providerName,
    mode: providerInput.mode,
    ...(providerInput.scope ? { scope: providerInput.scope } : {}),
    ...(providerInput.contentRef
      ? {
          contentRef: {
            collection: providerInput.contentRef.collection,
            id: providerInput.contentRef.id,
            ...(providerInput.contentRef.locale ? { locale: providerInput.contentRef.locale } : {}),
          },
        }
      : {}),
  };

  return runAdminProviderAction(
    input,
    omitUndefined({
      action: "provider.syncCatalog",
      idempotencyKey: syncInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(syncInput),
      metadata: syncMetadata,
    }),
    () => providerFeature.method.call(providerFeature.provider, providerInput),
    "Provider catalog sync failed.",
  );
}

export async function releaseExpiredReservations(
  input: MikaBackendDependencies,
  releaseInput: { readonly now?: ISODateTime; readonly idempotencyKey?: string } = {},
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const release = async (): Promise<AdminActionResultDTO> => {
    const result = await createMikaStockLifecycleService(input).releaseExpiredReservations({
      now: releaseInput.now ?? currentBackendISODateTime(input),
    });

    return {
      status: "completed",
      affected: {
        reservationsScanned: result.scannedCount,
        reservationsReleased: result.releasedCount,
        stockItems: result.stockItemsAffected,
      },
    };
  };

  if (!releaseInput.idempotencyKey) {
    return {
      ok: true,
      status: 200,
      data: await release(),
    };
  }

  return runAdminRepositoryAction(
    input,
    omitUndefined({
      action: "stock.releaseExpiredReservations",
      idempotencyKey: releaseInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(releaseInput),
      metadata: releaseInput.now ? { now: releaseInput.now } : {},
    }),
    release,
    "Expired reservation release failed.",
  );
}

export async function refundOrder(
  input: MikaBackendDependencies,
  refundInput: OrderRefundInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const order = await input.repositories.ledger.findOrderById(refundInput.orderId);
  if (!order) {
    return orderNotFound(refundInput.orderId);
  }
  if (order.status === "cancelled") {
    return validationFailed("orderId", `Order '${order.id}' is cancelled and cannot be refunded.`);
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: order.provider,
    method: "refundPayment",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support order refunds.`,
  });
  if (!providerFeature.ok) return providerFeature;
  const refundableAmount = Math.max(0, order.totalAmount - orderRefundedAmount(order));
  if (refundableAmount <= 0) {
    return validationFailed("amount", `Order '${order.id}' has no remaining refundable amount.`);
  }
  if (refundInput.amount !== undefined && refundInput.amount > refundableAmount) {
    return validationFailed(
      "amount",
      `Refund amount exceeds the remaining refundable amount for order '${order.id}'.`,
    );
  }

  const providerInput: MikaProviderRefundInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(refundInput.amount !== undefined ? { amount: refundInput.amount } : {}),
    ...(refundInput.reason ? { reason: refundInput.reason } : {}),
    ...(refundInput.idempotencyKey ? { idempotencyKey: refundInput.idempotencyKey } : {}),
  };

  return runAdminProviderAction(
    input,
    omitUndefined({
      action: "order.refund",
      targetType: "order",
      targetId: order.id,
      idempotencyKey: refundInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(refundInput),
      metadata: {
        provider: order.provider,
        orderId: order.id,
        ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
        ...(refundInput.amount !== undefined ? { amount: refundInput.amount } : {}),
        ...(refundInput.reason ? { reason: refundInput.reason } : {}),
      },
    }),
    async () => {
      const result = await providerFeature.method.call(providerFeature.provider, providerInput);
      assertCompletedProviderAction(result, "Provider order refund did not complete.");

      const now = currentBackendISODateTime(input);
      const updated = applyOrderRefund(order, refundInput, now);
      await input.repositories.ledger.put(updated);
      if (updated.status === "refunded") {
        await revokeOrderFulfillmentAccess(input, updated, now, "order_refunded");
      }

      return {
        ...result,
        id: result.id ?? order.id,
        status: "completed",
      };
    },
    "Provider order refund failed.",
  );
}

export async function cancelOrder(
  input: MikaBackendDependencies,
  cancelInput: OrderCancelInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const order = await input.repositories.ledger.findOrderById(cancelInput.orderId);
  if (!order) {
    return orderNotFound(cancelInput.orderId);
  }
  if (orderIsPaymentTerminal(order)) {
    return validationFailed(
      "orderId",
      `Order '${order.id}' is in a terminal payment state and cannot be cancelled.`,
    );
  }

  const providerFeature = await requireProviderFeature(input, {
    providerName: order.provider,
    method: "cancelOrder",
    unsupportedMessage: (providerName) =>
      `Provider '${providerName}' does not support order cancellation.`,
  });
  if (!providerFeature.ok) return providerFeature;

  const providerInput: MikaProviderOrderCancelInput = {
    orderId: order.id,
    ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
    ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
    ...(cancelInput.reason ? { reason: cancelInput.reason } : {}),
  };

  return runAdminProviderAction(
    input,
    omitUndefined({
      action: "order.cancel",
      targetType: "order",
      targetId: order.id,
      idempotencyKey: cancelInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(cancelInput),
      metadata: {
        provider: order.provider,
        orderId: order.id,
        ...(order.providerPaymentId ? { providerPaymentId: order.providerPaymentId } : {}),
        ...(order.providerOrderId ? { providerOrderId: order.providerOrderId } : {}),
        ...(cancelInput.reason ? { reason: cancelInput.reason } : {}),
      },
    }),
    async () => {
      const result = await providerFeature.method.call(providerFeature.provider, providerInput);
      assertCompletedProviderAction(result, "Provider order cancellation did not complete.");

      const now = currentBackendISODateTime(input);
      const updated = applyOrderCancel(order, cancelInput, now);
      await input.repositories.ledger.put(updated);
      await revokeOrderFulfillmentAccess(input, updated, now, "order_cancelled");

      return {
        ...result,
        id: result.id ?? order.id,
        status: "completed",
      };
    },
    "Provider order cancellation failed.",
  );
}

export async function grantEntitlement(
  input: MikaBackendDependencies,
  grantInput: EntitlementGrantInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const email = grantInput.email?.trim();
  const emailHash = email ? await input.hash(emailHashKey(email)) : undefined;
  const entitlementId = input.createId("entitlement");

  return runAdminRepositoryAction(
    input,
    omitUndefined({
      action: "entitlement.grant",
      targetType: "entitlement",
      targetId: entitlementId,
      idempotencyKey: grantInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(grantInput),
      metadata: {
        entitlementKey: grantInput.entitlementKey,
        ...(grantInput.customerId ? { customerId: grantInput.customerId } : {}),
        ...(grantInput.userId ? { userId: grantInput.userId } : {}),
        ...(emailHash ? { emailHash } : {}),
        ...(grantInput.expiresAt ? { expiresAt: grantInput.expiresAt } : {}),
      },
    }),
    async (audit) => {
      const entitlement = createManualEntitlementDocument(
        entitlementId,
        grantInput,
        audit.createdAt,
        emailHash,
      );
      await input.repositories.account.put(entitlement);

      return {
        id: entitlement.id,
        status: "completed",
        affected: {
          entitlements: 1,
        },
      };
    },
    "Entitlement grant failed.",
  );
}

export async function revokeEntitlement(
  input: MikaBackendDependencies,
  revokeInput: EntitlementRevokeInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const entitlements = await findEntitlementsForRevoke(input, revokeInput);
  const primaryEntitlement = entitlements[0];
  if (!primaryEntitlement) {
    return missingTargetWithAudit(
      input,
      omitUndefined({
        action: "entitlement.revoke",
        targetType: "entitlement",
        field: "entitlementId",
        value: revokeInput.entitlementId ?? revokeInput.entitlementKey ?? "unknown",
        targetId: revokeInput.entitlementId,
        metadata: {
          ...(revokeInput.entitlementKey ? { entitlementKey: revokeInput.entitlementKey } : {}),
          ...(revokeInput.customerId ? { customerId: revokeInput.customerId } : {}),
        },
      }),
    );
  }

  return runAdminRepositoryAction(
    input,
    omitUndefined({
      action: "entitlement.revoke",
      targetType: "entitlement",
      targetId: primaryEntitlement.id,
      idempotencyKey: revokeInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(revokeInput),
      metadata: {
        entitlementId: primaryEntitlement.id,
        entitlementIds: entitlements.map((entitlement) => entitlement.id),
        entitlementKey: primaryEntitlement.entitlementKey,
        ...(primaryEntitlement.customerId ? { customerId: primaryEntitlement.customerId } : {}),
        ...(revokeInput.reason ? { reason: revokeInput.reason } : {}),
      },
    }),
    async (audit) => {
      const now = audit.createdAt;
      const updated: EntitlementDocument[] = entitlements.map((entitlement) => ({
        ...entitlement,
        status: "revoked",
        updatedAt: now,
        record: {
          ...entitlement.record,
          status: "revoked",
          revokedAt: now,
          metadata: {
            ...entitlement.record.metadata,
            ...(revokeInput.reason ? { revokeReason: revokeInput.reason } : {}),
          },
        },
      }));
      for (const entitlement of updated) {
        await input.repositories.account.put(entitlement);
      }

      return {
        id: primaryEntitlement.id,
        status: "completed",
        affected: {
          entitlements: updated.length,
        },
      };
    },
    "Entitlement revoke failed.",
  );
}

export async function resendEmail(
  input: MikaBackendDependencies,
  resendInput: EmailResendInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const email = await input.repositories.ops.findEmail(resendInput.emailId);
  if (!email) {
    return missingTargetWithAudit(input, {
      action: "email.resend",
      targetType: "email",
      field: "emailId",
      value: resendInput.emailId,
      targetId: resendInput.emailId,
    });
  }

  return runAdminRepositoryAction(
    input,
    omitUndefined({
      action: "email.resend",
      targetType: "email",
      targetId: email.id,
      idempotencyKey: resendInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(resendInput),
      metadata: {
        emailId: email.id,
        kind: email.kind,
      },
    }),
    async (audit) => {
      const now = audit.createdAt;
      const {
        lastError: _lastError,
        leasedAt: _leasedAt,
        leaseExpiresAt: _leaseExpiresAt,
        leaseKey: _leaseKey,
        ...requeuedRecord
      } = email.record;
      await input.repositories.ops.put({
        ...email,
        status: "queued",
        nextAttemptAt: now,
        updatedAt: now,
        record: {
          ...requeuedRecord,
          status: "queued",
          nextAttemptAt: now,
          attemptCount: 0,
          metadata: {
            ...email.record.metadata,
            resentAt: now,
            adminAuditId: audit.id,
          },
        },
      });

      return {
        id: email.id,
        status: "completed",
        affected: {
          emails: 1,
        },
      };
    },
    "Email resend failed.",
  );
}

export async function revokeLicense(
  input: MikaBackendDependencies,
  revokeInput: LicenseRevokeInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const license = await input.repositories.account.findLicenseById(revokeInput.licenseId);
  if (!license) {
    return missingTargetWithAudit(input, {
      action: "license.revoke",
      targetType: "license",
      field: "licenseId",
      value: revokeInput.licenseId,
      targetId: revokeInput.licenseId,
    });
  }

  return runAdminRepositoryAction(
    input,
    omitUndefined({
      action: "license.revoke",
      targetType: "license",
      targetId: license.id,
      idempotencyKey: revokeInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(revokeInput),
      metadata: {
        licenseId: license.id,
        ...(license.customerId ? { customerId: license.customerId } : {}),
        ...(license.orderId ? { orderId: license.orderId } : {}),
        ...(license.orderLineId ? { orderLineId: license.orderLineId } : {}),
        ...(revokeInput.reason ? { reason: revokeInput.reason } : {}),
      },
    }),
    async (audit) => {
      const now = audit.createdAt;
      const updated: LicenseDocument = {
        ...license,
        status: "revoked",
        updatedAt: now,
        record: {
          ...license.record,
          status: "revoked",
          revokedAt: now,
          metadata: {
            ...license.record.metadata,
            ...(revokeInput.reason ? { revokeReason: revokeInput.reason } : {}),
          },
        },
      };
      await input.repositories.account.put(updated);

      return {
        id: updated.id,
        status: "completed",
        affected: {
          licenses: 1,
        },
      };
    },
    "License revoke failed.",
  );
}

export async function issueDownload(
  input: MikaBackendDependencies,
  issueInput: DownloadIssueInput,
): Promise<MikaApiResult<AdminActionResultDTO>> {
  const target = await resolveDownloadIssueTarget(input, issueInput);
  if (!target) {
    return missingTargetWithAudit(
      input,
      omitUndefined({
        action: "download.issue",
        targetType: "download",
        field: "orderId",
        value: issueInput.orderId ?? issueInput.entitlementId ?? "unknown",
        targetId: issueInput.orderId,
        metadata: {
          ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
          ...(issueInput.orderLineId ? { orderLineId: issueInput.orderLineId } : {}),
        },
      }),
    );
  }

  const now = currentBackendISODateTime(input);
  const expiresAt =
    issueInput.expiresAt ?? addMilliseconds(now, input.config?.download?.tokenTtlMs ?? 15 * 60_000);
  const downloadToken = input.createId("download_token");
  const downloadTokenHash = await hashDownloadToken(input, downloadToken);
  return runAdminRepositoryAction(
    input,
    omitUndefined({
      action: "download.issue",
      targetType: "download",
      targetId: createMikaId(target.downloadRef),
      createdAt: now,
      idempotencyKey: issueInput.idempotencyKey,
      idempotencyInput: toIdempotencyJson(issueInput),
      metadata: {
        orderId: target.order.id,
        orderLineId: target.line.id,
        downloadRef: target.downloadRef,
        ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
        ...(target.license?.id ? { licenseId: target.license.id } : {}),
        expiresAt,
      },
    }),
    async (audit) => {
      if (!target.line.downloadRefs?.includes(target.downloadRef)) {
        await input.repositories.ledger.put(
          addDownloadRefToOrder(target.order, target.line.id, target.downloadRef, now),
        );
      }

      const subjectHash = orderDownloadSubjectHash(target.order);
      await input.repositories.ephemeral.put({
        key: downloadTokenHash,
        kind: "token",
        ...(subjectHash ? { subjectHash } : {}),
        status: "pending",
        count: 0,
        expiresAt,
        version: 1,
        createdAt: now,
        updatedAt: now,
        data: {
          purpose: "download",
          tokenId: downloadToken,
          downloadRef: target.downloadRef,
          orderId: target.order.id,
          orderLineId: target.line.id,
          ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
          ...(target.license?.id ? { licenseId: target.license.id } : {}),
          title: target.line.item.titleSnapshot,
          redirectUrl: target.downloadRef,
          adminAuditId: audit.id,
        },
      });

      await emitBackendNotification(input, "download.ready", now, {
        ...orderNotificationRecipient(target.order),
        downloadRef: target.downloadRef,
        orderId: target.order.id,
        orderLineId: target.line.id,
        title: target.line.item.titleSnapshot,
        tokenId: downloadToken,
        expiresAt,
        ...(issueInput.entitlementId ? { entitlementId: issueInput.entitlementId } : {}),
        ...(target.license?.id ? { licenseId: target.license.id } : {}),
      });

      return {
        id: createMikaId(target.downloadRef),
        status: "completed",
        affected: {
          downloads: 1,
          tokens: 1,
        },
      };
    },
    "Download issue failed.",
  );
}

export function adminStockAdjustmentResult(
  result: Extract<AdjustStockRepositoryResult, { readonly status: "adjusted" | "replayed" }>,
): AdminActionResultDTO {
  const applied = result.status === "adjusted";

  return {
    id: result.event.id,
    status: "completed",
    ...(applied ? {} : { message: "Stock adjustment idempotency key was replayed." }),
    affected: {
      stockItems: applied ? 1 : 0,
      movements: applied ? 1 : 0,
    },
  };
}
