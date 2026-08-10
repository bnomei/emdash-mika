/**
 * External-style compile fixture: only published Mika package surfaces are imported.
 * The host keeps private asset storage and raw license material outside Mika.
 */
import type { MikaApi, MikaNotificationHook } from "@bnomei/emdash-mika/server";
import type {
  DownloadResolutionDTO,
  ISODateTime,
  MikaApiResult,
  MikaId,
} from "@bnomei/emdash-mika/types";

export interface HostPrivateAsset {
  readonly redirectUrl: string;
  readonly expiresAt?: ISODateTime;
}

export type HostPrivateAssetResolver = (
  downloadRef: string,
) => HostPrivateAsset | Promise<HostPrivateAsset>;

async function resolveHostPrivateAsset(
  result: MikaApiResult<DownloadResolutionDTO>,
  resolveAsset: HostPrivateAssetResolver,
): Promise<MikaApiResult<DownloadResolutionDTO>> {
  if (!result.ok) return result;
  if (result.data.redirectUrl) {
    assertHttpsRedirect(result.data.redirectUrl);
    return result;
  }
  if (!result.data.downloadRef) return result;

  const asset = await resolveAsset(result.data.downloadRef);
  assertHttpsRedirect(asset.redirectUrl);
  const expiresAt = boundedAssetExpiry(result.data.expiresAt, asset.expiresAt);
  return {
    ...result,
    data: {
      ...result.data,
      redirectUrl: asset.redirectUrl,
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

function assertHttpsRedirect(redirectUrl: string): void {
  if (new URL(redirectUrl).protocol !== "https:") {
    throw new Error("Private download redirects must use HTTPS.");
  }
}

function boundedAssetExpiry(
  tokenExpiry: ISODateTime | undefined,
  assetExpiry: ISODateTime | undefined,
): ISODateTime | undefined {
  if (!tokenExpiry) return assetExpiry;
  if (!assetExpiry) return tokenExpiry;
  if (Date.parse(assetExpiry) > Date.parse(tokenExpiry)) {
    throw new Error("Private download redirects must not outlive the Mika token.");
  }

  return assetExpiry;
}

/**
 * Wraps Mika's token checks with host-owned private asset resolution. Confirmation resolves the
 * asset first, then delegates to Mika's atomic token consumption, so signing failure cannot burn
 * the buyer's one-time token.
 */
export function withHostPrivateDownloads(
  api: MikaApi,
  resolveAsset: HostPrivateAssetResolver,
): MikaApi {
  return {
    ...api,
    download: {
      resolve: async (input) =>
        resolveHostPrivateAsset(await api.download.resolve(input), resolveAsset),
      confirm: async (input) => {
        const preview = await resolveHostPrivateAsset(
          await api.download.resolve(input),
          resolveAsset,
        );
        if (!preview.ok || !preview.data.redirectUrl) return preview;

        const confirmed = await api.download.confirm(input);
        if (!confirmed.ok) return confirmed;

        return {
          ...confirmed,
          data: {
            ...confirmed.data,
            redirectUrl: preview.data.redirectUrl,
            ...(preview.data.expiresAt ? { expiresAt: preview.data.expiresAt } : {}),
          },
        };
      },
    },
  };
}

export interface HostLicenseDeliveryJob {
  readonly idempotencyKey: string;
  readonly licenseId: MikaId;
  readonly displayKeySuffix: string;
  readonly orderId?: MikaId;
  readonly orderLineId?: MikaId;
  readonly customerId?: MikaId;
  readonly toEmail?: string;
}

export type QueueHostLicenseDelivery = (job: HostLicenseDeliveryJob) => void | Promise<void>;

/**
 * Queues host work keyed by Mika's license id. The durable worker—not this hook—generates, stores,
 * and delivers the raw key; Mika receives only the id and display suffix as fulfillment evidence.
 */
export function createHostLicenseDeliveryHook(
  queueDelivery: QueueHostLicenseDelivery,
): MikaNotificationHook {
  return async (intent) => {
    if (intent.kind !== "license.issued") return undefined;

    await queueDelivery({
      idempotencyKey: `license-delivery:${intent.context.licenseId}`,
      licenseId: intent.context.licenseId,
      displayKeySuffix: intent.context.displayKeySuffix,
      ...(intent.context.orderId ? { orderId: intent.context.orderId } : {}),
      ...(intent.context.orderLineId ? { orderLineId: intent.context.orderLineId } : {}),
      ...(intent.context.customerId ? { customerId: intent.context.customerId } : {}),
      ...(intent.context.toEmail ? { toEmail: intent.context.toEmail } : {}),
    });

    return { handled: true };
  };
}
