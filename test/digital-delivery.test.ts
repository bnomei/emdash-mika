import { describe, expect, it } from "vite-plus/test";

import {
  createMikaApi,
  type MikaApi,
  type MikaNotificationIntent,
} from "@bnomei/emdash-mika/server";
import { createISODateTime, createMikaId } from "@bnomei/emdash-mika/types";

import {
  createHostLicenseDeliveryHook,
  withHostPrivateDownloads,
  type HostLicenseDeliveryJob,
} from "./fixtures/digital-delivery";

describe("external digital delivery fixture", () => {
  it("resolves opaque evidence before consuming a one-time download token", async () => {
    let consumed = false;
    const base = createMikaApi({
      download: {
        resolve: async () => ({
          ok: true,
          status: 200,
          data: {
            downloadRef: "download:order_1:line_1",
            expiresAt: createISODateTime("2026-01-01T00:15:00.000Z"),
          },
        }),
        confirm: async () => {
          if (consumed) {
            return {
              ok: false,
              status: 410,
              error: { code: "TOKEN_USED", message: "Download token was already used." },
            };
          }
          consumed = true;

          return {
            ok: true,
            status: 200,
            data: { downloadRef: "download:order_1:line_1" },
          };
        },
      },
    }) satisfies MikaApi;
    const api = withHostPrivateDownloads(base, async (downloadRef) => ({
      redirectUrl: `https://assets.example.test/private/${encodeURIComponent(downloadRef)}`,
      expiresAt: createISODateTime("2026-01-01T00:05:00.000Z"),
    }));

    await expect(api.download.resolve({ token: "token_1" })).resolves.toMatchObject({
      ok: true,
      data: {
        downloadRef: "download:order_1:line_1",
        redirectUrl: expect.stringMatching(/^https:\/\/assets\.example\.test\/private\//),
        expiresAt: "2026-01-01T00:05:00.000Z",
      },
    });
    expect(consumed).toBe(false);

    await expect(api.download.confirm({ token: "token_1" })).resolves.toMatchObject({
      ok: true,
      data: {
        downloadRef: "download:order_1:line_1",
        redirectUrl: expect.stringMatching(/^https:\/\/assets\.example\.test\/private\//),
      },
    });
    expect(consumed).toBe(true);
    await expect(api.download.confirm({ token: "token_1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "TOKEN_USED" },
    });
  });

  it("queues license delivery using evidence only", async () => {
    const jobs: HostLicenseDeliveryJob[] = [];
    const hook = createHostLicenseDeliveryHook((job) => {
      jobs.push(job);
    });
    const intent: MikaNotificationIntent<"license.issued"> = {
      kind: "license.issued",
      occurredAt: createISODateTime("2026-01-01T00:00:00.000Z"),
      context: {
        licenseId: createMikaId("license_order_1_line_1"),
        orderId: createMikaId("order_1"),
        orderLineId: createMikaId("line_1"),
        customerId: createMikaId("customer_1"),
        toEmail: "buyer@example.test",
        displayKeySuffix: "ABC123",
      },
    };

    await expect(hook(intent)).resolves.toEqual({ handled: true });
    expect(jobs).toEqual([
      {
        idempotencyKey: "license-delivery:license_order_1_line_1",
        licenseId: "license_order_1_line_1",
        orderId: "order_1",
        orderLineId: "line_1",
        customerId: "customer_1",
        toEmail: "buyer@example.test",
        displayKeySuffix: "ABC123",
      },
    ]);
    expect(JSON.stringify({ intent, jobs })).not.toContain("licenseKeyHash");
  });
});
