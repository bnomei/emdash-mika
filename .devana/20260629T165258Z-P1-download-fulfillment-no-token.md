DEVANA-FINDING: v1
DEVANA-STATE: fixed | P1 | high | security=no
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
- 2026-06-30: fixed (chosen approach: mirror the invoice DTO, which is the in-codebase precedent for this exact problem). Confirmed the bug: `orderDownloadDTOs` (`src/api/backend.ts`) set `href` to the BARE internal `downloadRef` (`download:<orderId>:<lineId>`) with no token and no `expiresAt`, while the bundled storefront links it directly (`AccountDownloads.astro:51` `<Link href={download.href}>`) and reads `download.expiresAt` — so the default account download link was non-navigable and a customer could not download without the host separately calling `admin.downloadIssue` to mint a token. Crucially the SIBLING invoice link, built in the SAME account DTO assembly, does it correctly: `orderSummaryDTO` (`:3124`) auto-mints an `order_invoice` token (`createOrderInvoiceToken`) and returns `invoiceHref: mikaPluginRoute("orderInvoice", { token })` — a navigable plugin route. Downloads simply omitted that step. Fix: `orderDownloadDTOs` is now async and, per download ref, (a) mints a short-lived consumable download capability token via a new `createOrderLineDownloadToken` helper — the SAME token shape `issueDownload` writes (purpose `download`, `downloadRef`/`orderId`/`orderLineId`, `redirectUrl`), minus the admin audit, so `download.resolve` validates and CONSUMES it identically — and (b) sets `href: mikaPluginRoute("download", { origin: ctx.url, search: { token } })` plus `expiresAt`, exactly mirroring the invoice DTO. Both callers (`accountDTOForCustomer` `:3120` and the emailHash account path `:1300`) now `await Promise.all(...)`. So the account download link is a navigable plugin route the customer can use directly, with NO host `admin.downloadIssue` step. Token semantics match the existing model: `resolveDownload` consumes the token (`consumeToken`, `:3282`), so it is single-use; each account view mints a fresh token (a fresh navigable link per render), like the per-view invoice token. Evidence: the account-overview test now asserts the download `href` is the navigable plugin route (`/_emdash/api/plugins/mika/download?token=download_token_1`) with `expiresAt`; a new test ("mints a resolvable capability token for each account download link") drives `account.get` and then `download.resolve` on the token extracted from the link, asserting it succeeds end-to-end (`redirectUrl` = the ref). Mutation-verified: reverting `href` to the bare ref (cp-backup + restore, no git) fails the new test; restored and re-confirmed. Full suite (392) and both tsc configs pass. SCOPE (host-wired by design, NOT fixed here): the resolved `redirectUrl` is still the `downloadRef` PLACEHOLDER — both `issueDownload` (`:2416`) and `resolveDownload` (`:3295`) use it, the library exposes NO asset-URL config (`config.download` is only `{ tokenTtlMs }`, `:530`), and the template README states the host wires actual file streaming / the `download/[token]` endpoint maps the ref to the real asset. So terminal asset delivery remains the host's documented responsibility; this fix removes the broken-href / mandatory-`admin.downloadIssue` defect and aligns downloads with invoices, but does not (and by design cannot) resolve the ref to a real file. The internal `downloadRef` itself (used by `download.resolve`, `findOrderByDownloadRef`, and the `download.ready` notification) is unchanged.
- 2026-06-30: reopened and fixed for cleanup semantics. The auto-minted token shape mirrored `issueDownload`, but both paths only wrote a raw customer id `subjectHash` and wrote no subject for guest/emailHash orders. A shared `orderDownloadSubjectHash` now binds download tokens to `customer:<id>`, `user:<id>`, or `email:<hash>` based on the order identity. Regressions assert customer account download tokens carry `customer:<id>` and guest account download tokens carry `email:<hash>`, so account-delete token cleanup can target future tokens directly.

DEVANA-KEY: src/api/backend.ts:5096 | download-fulfillment-no-token
DEVANA-SUMMARY: fixed | P1 | high | orderDownloadDTOs auto-mints short-lived consumable download capability tokens instead of bare internal refs, and those tokens now carry customer/user/email subject hashes so cleanup can target customer and guest tokens. The resolved redirectUrl remains the host-mapped ref placeholder by design.
