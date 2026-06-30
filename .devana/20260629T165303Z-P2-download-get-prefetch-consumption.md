DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/templates/astro/pages/download/[token].ts:15 | download-get-prefetch-consumption

# Download route consumes single-use token on GET

## Finding

The storefront download page issues `GET /download/[token]`, which calls `download.resolve`. `resolveDownload` consumes the ephemeral token on the first successful resolve before redirecting. Email scanners, link previews, and prefetching clients commonly issue GET requests to links in messages.

## Violated Invariant Or Contract

Single-use download tokens delivered via email should survive benign prefetch until the user explicitly initiates download.

## Oracle

`resolveDownload` calls `consumeToken` before returning `redirectUrl` (`backend.ts:3057-3070`). Route handler is GET-only (`download/[token].ts:10-22`). Tests expect single-use consumption.

## Counterexample

1. `download.ready` email contains `https://shop.example/download/tok_abc`.
2. Mail security scanner GETs the URL first.
3. Token status becomes `consumed`.
4. Customer clicks the link → `TOKEN_USED` / 410.

## Why It Might Matter

Legitimate buyers lose download access when automated link checkers consume the token first.

## Proof

Entrypoint-to-sink trace: GET route → resolve → consume → redirect; first GET wins.

## Counterevidence Checked

Checkout status tokens use `active` status and are not consumed. Magic-link verify is POST-only. No one-time POST-then-redirect pattern for downloads.

## Suggested Next Step

Use POST confirmation for consumption, or multi-use tokens with separate view vs download scopes.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE: ...` and the final `DEVANA-SUMMARY:` status/priority/confidence prefix. Use one of: `open`, `fixed`, `invalid`, `stale`, `duplicate`, `wontfix`. Keep `DEVANA-KEY:` stable unless the same finding moved. Add dated notes below with evidence checked.

## Status Notes

- 2026-06-29: open by Devana. Initial report written from static source inspection.
- 2026-06-30: wontfix — the finding is FACTUALLY correct (a GET to the bundled `download/[token].ts` calls `download.resolve` → `resolveDownload` consumes the single-use token via `ephemeral.consumeToken` (`pending`→`consumed`, `src/storage/repositories.ts`) before redirecting, so an email scanner / prefetcher GET can burn the link), but single-use is a DELIBERATE security property and the prefetch tradeoff is correctly mitigated at the DELIVERY layer (the host's domain), so the library declines to weaken it globally. Rationale: (1) The codebase intentionally splits tokens into a SINGLE-USE class (download + magic-link: minted `status:"pending"`, validated-and-burned by `consumeToken`) and a REUSABLE capability class (checkout-status + order-invoice: minted `status:"active"`, validated by `reusableCapabilityTokenError` without consuming). Download is in the single-use class ON PURPOSE: a one-time download link is useless once leaked/intercepted — exactly the email-delivery threat model the report itself describes (mail security scanners, message forwarding, `Referer` headers, shared browser history). There is no per-token download-count limit; consumption IS the single-use guarantee. (2) The report's two Suggested Next Steps map to the two mitigation layers and BOTH are the host's: the DEVANA-KEY is `src/templates/astro/pages/download/[token].ts` — a host-COPYABLE reference template, not library code. A host that delivers download links by email and worries about scanners should make that GET an interstitial that does NOT consume and have a user-initiated POST perform the consume+redirect (the report's first suggestion, a pure template change requiring no library change). (3) Switching download tokens to "multi-use" (the report's second suggestion) would resolve prefetch but DOWNGRADE the single-use property for ALL download links — a leaked/forwarded link would then grant repeated downloads for the whole TTL window (default 15 min, `config.download.tokenTtlMs`); the library leaves that tradeoff to the host's delivery choice rather than imposing it. (4) For the bundled ACCOUNT page (`/account/downloads`), the related fix `165258Z download-fulfillment-no-token` mints a FRESH single-use token per `account.get` render, so a prefetch there burns only that render's token and a reload yields a fresh working link — no permanent loss of access for the account-page surface. Net: the only place a single GET permanently burns a link is a consumable link embedded in an EMAIL, which is a host delivery decision the host can solve at the template/delivery layer while keeping the secure single-use default. No library code change; state → wontfix. (Adversarial review requested to challenge whether single-use's leaked-link value justifies declining the multi-use fix, given the entitlement is re-checked on every resolve.)
- 2026-06-30 (CORRECTED to fixed — the adversarial review REFUTED the wontfix above with the library's OWN internal evidence): the wontfix conflated two SEPARABLE properties — single-use (legitimate, kept) and GET-CONSUMPTION (the actual bug). Decisive evidence it missed: (a) the library's own `docs/commerce-research/security-and-abuse.md` documents GET-as-the-consuming-step as the UNSAFE default and warns of "link scanner risk", prescribing email-link → GET page that validates WITHOUT consuming → user POST consumes; (b) the SIBLING single-use token already follows that safe default — `account/magic-link.astro` is a non-consuming GET interstitial; consumption happens only in the `magicLink.verify` POST form action — while download VIOLATED it; (c) the library ITSELF ships consumable download links (the account page, and admin `download.issue` → the `download.ready` notification emits the raw `tokenId` for the host to email), so it is the library's problem, not purely host delivery. Critically the report's FIRST suggestion (POST-confirm) KEEPS single-use (a leaked link is still useless after one use) AND fixes prefetch — there is no abuse GET-consume blocks that POST-confirm misses — so the wontfix's security premise does NOT justify GET-consumption. Fix (mirrors magic-link exactly, single-use preserved): (1) a new `download.confirm` POST form-action operation (`downloadConfirm`, `httpMethod:"POST"`, `action: formAction()`) whose handler is the UNCHANGED `resolveDownload` (still consumes) — exposed as `api.download.confirm` + the astro action `actions.mika.download.confirm` (+ the facade/contract-table entries the JSON-client-alignment invariant requires); (2) the bundled `download/[token].ts` GET-consume API route is REPLACED by `download/[token].astro`, a GET interstitial that issues NO `download.*` call on GET (so prefetch/scanners cannot burn the token) and consumes only on the user-initiated POST to `download.confirm`, then redirects to `redirectUrl`; (3) `orderDownloadDTOs` (the account-page DTO from the `165258Z` fix) now sets `href` to the interstitial path `/download/${token}` instead of the consuming `download.resolve` GET plugin route, so a browser prefetch of the ACCOUNT-page link can't burn it either. `download.resolve` (GET) is UNCHANGED for agents/programmatic one-shot callers (no prefetch concern there). Evidence: a new test asserts `download.confirm` consumes + returns the `redirectUrl` and that a SECOND confirm/resolve is `410 TOKEN_USED` (single-use intact); the account-page tests pin `href === "/download/<token>"` and confirm the token resolves via `download.confirm`; the pinned operation/action/facade contract tables were updated. Full suite (400) + both tsc pass. The single-use security property the wontfix rightly valued is fully preserved — only the benign-GET consumption is eliminated by moving the consume to a user-initiated POST.
- 2026-06-30 (confirmation review: APPROVE_WITH_NITS, no blocking — PREFETCH_CLOSED for product downloads + SINGLE_USE_PRESERVED both verified, interstitial confirmed to issue no `download.*` call on GET, wiring/contract-tables pinned, 400 tests). Two non-blocking notes: (i) `orderDownloadDTOs.href` is now origin-relative `/download/${token}` (it must target a storefront route to be prefetch-safe, since the only always-mounted self-contained surface — the `download.resolve` GET plugin route — is the consuming one); this couples the bundled-storefront-facing DTO to the bundled route layout (`download/[token].astro` served at `/download/<token>`), so a NON-bundled host rendering `downloads[].href` verbatim must also serve that interstitial path (worth a host doc note; agents are unaffected — they keep `download.resolve` GET). (ii) SIBLING SURFACE worth its OWN finding (NOT fixed here — different token/surface, outside this product-download report's scope): `accountExportDownload` (`operations.ts`, `httpMethod:"GET"`) likewise CONSUMES its single-use export-download token on a benign GET and the library ships that consuming absolute href into the `account.export_ready` EMAIL notification — the exact class fixed here, for account EXPORT downloads. Pre-existing, not a regression, untracked by any `.devana` finding; the same POST-confirm-interstitial remedy applies. Recommend opening a sibling finding for `account-export-download-get-consumption`.

DEVANA-KEY: src/templates/astro/pages/download/[token].ts:15 | download-get-prefetch-consumption
DEVANA-SUMMARY: fixed | P2 | medium | The GET download route consumed the single-use token on a benign prefetch (email scanners/preview/prefetch burned the link). Fixed by mirroring the library's own magic-link pattern and its documented safe default: a new download.confirm POST form-action operation (handler = the unchanged, still-consuming resolveDownload) + the bundled download/[token].astro GET interstitial that issues NO download.* call on GET (consume happens only on the user-initiated POST), plus the account-page DTO href now targets that interstitial (/download/<token>) instead of the consuming download.resolve GET plugin route. Single-use is PRESERVED (a leaked link is still one-shot; download.resolve GET stays unchanged for agents) — only benign-GET consumption is removed. Reverses an initial wontfix after the adversarial review showed the fix is in-scope, cheap, and consistent with the library's own docs (security-and-abuse.md "link scanner risk") and the magic-link interstitial precedent.