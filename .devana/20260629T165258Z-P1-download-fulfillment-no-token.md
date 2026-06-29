DEVANA-FINDING: v1
DEVANA-STATE: open | P1 | high | security=no
DEVANA-KEY: src/api/backend.ts:5096 | download-fulfillment-no-token

# Download fulfillment writes non-navigable refs and never mints tokens

## Finding

Paid `download` fulfillment appends a synthetic `downloadRef` (`download:<orderId>:<lineId>`) to order lines but does not create ephemeral download tokens. `orderDownloadDTOs` exposes that ref as `DownloadDTO.href`. The bundled `AccountDownloads.astro` template links `href` directly. `download.resolve` requires a consumable ephemeral token and redirects to `redirectUrl`, which `issueDownload` also sets to the synthetic ref.

## Violated Invariant Or Contract

After paid download fulfillment, customers should receive a navigable download URL or tokenized route (`/download/<token>`). `DownloadDTO.href` should resolve in the storefront template.

## Oracle

`fulfillPaidOrderLine` download case only mutates `downloadRefs` (`backend.ts:5096-5100`). `issueDownload` is the sole `purpose: "download"` token writer (`backend.ts:2257-2278`). Template uses `<Link href={download.href}>` (`AccountDownloads.astro:51`).

## Counterexample

1. Customer pays for a product with `fulfillmentKind: "download"`.
2. Webhook fulfillment adds `downloadRefs: ["download:ord_1:line_1"]`.
3. `account.get` returns `downloads[].href: "download:ord_1:line_1"`.
4. Template link is not a valid URL; `download.resolve` without admin-issued token returns `TOKEN_INVALID`.

## Why It Might Matter

Default storefront download flow is broken after auto-fulfillment; customers cannot download without separate host integration calling `admin.downloadIssue`.

## Proof

Dataflow trace: fulfillment → synthetic ref as href → template link → no token → resolve fails.

## Counterevidence Checked

`download.ready` notification is hook-only for hosts. Invoice flow auto-mints tokens elsewhere, showing the pattern exists but is omitted for product downloads.

## Suggested Next Step

Auto-mint download tokens in `fulfillPaidOrder` or map `href` to `/download/<token>` with a real asset `redirectUrl` from catalog metadata.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.

DEVANA-KEY: src/api/backend.ts:5096 | download-fulfillment-no-token
DEVANA-SUMMARY: open | P1 | high | Auto download fulfillment sets synthetic downloadRefs as href without minting consumable download tokens.