# Mika Roadmap

## Shipping thesis

Mika should ship as a small, dependable commerce foundation for Astro and EmDash projects. It is not intended to be a turnkey storefront, a hosted commerce platform, or a universal adapter framework.

The package must provide:

- stable provider-neutral contracts;
- correct core behavior and explicit extension points;
- accurate protocol projections;
- documentation that explains ownership and integration boundaries;
- executable proof that the package, demo, and documented seams work.

The consuming project—often with AI assistance—can provide the application-specific glue: mapping content into products, selecting persistence, connecting tax and shipping services, issuing license material, resolving private downloads, and building UI.

This distinction is the release filter for every item below. We should add a feature only when it strengthens the shared foundation. We should not build generic infrastructure merely to eliminate a small amount of host glue.

## What already exists

Mika already has the shape of a shippable foundation:

- a semantic commerce API with a broad operation catalog;
- provider-neutral DTOs and lifecycle rules;
- host-owned authentication, policy, storage, and side effects;
- Stripe and Agentic Commerce Protocol (ACP) projections;
- package exports for runtime, backend, client, ACP, Stripe, schemas, and integration helpers;
- a substantial runtime and type-level test suite;
- `emdash-mika-template`, a complete seeded Astro + EmDash demonstration;
- `emdash-mika-docs`, the public documentation site.

The demo proves that a complete application can be built on Mika. It does not need to become a starter that works unchanged in every project. The docs should teach the contracts and decisions needed to build a project-specific integration.

## Product boundary

| Mika must own                                          | The host or AI-generated glue owns                 |
| ------------------------------------------------------ | -------------------------------------------------- |
| Semantic DTOs, operations, errors, and lifecycle rules | Content schema and product mapping                 |
| Correct concurrency and state-transition semantics     | Database and storage implementation                |
| Typed extension points                                 | Tax, shipping, inventory, and fraud vendors        |
| Faithful Stripe and ACP projections                    | Authentication, authorization, and business policy |
| Deterministic tests and conformance fixtures           | Private asset storage and signed download URLs     |
| Package, docs, and demo release proof                  | Raw license-key generation and delivery            |
| Clear ownership and security guidance                  | Storefront UI and project-specific workflows       |

## Ship criteria

The first public release is acceptable when all of the following are true:

1. The packed package installs, imports, type-checks, and passes a minimal runtime smoke test in a clean consumer.
2. Focused tests protect the risky invariants Mika owns: concurrent writes, terminal lifecycle states, replay, quote integrity, and truthful provider projection.
3. A host can supply catalog mapping, business quoting, persistence, payment, and fulfillment behavior through public exports; representative examples compile without internal imports.
4. Every protocol Mika advertises passes representative conformance tests against a pinned version.
5. The demo builds and tests against the release candidate, and the public documentation builds with Mika-owned and host-owned responsibilities stated accurately.

Anything beyond these criteria is post-ship unless it fixes a demonstrated correctness or security problem.

### Release decision rule

Each required checkpoint should end with the smallest combination of public contract, documentation, and executable proof that makes the boundary dependable. Add production code only when a representative host integration cannot express a required fact safely through the current public surface.

Existing proof counts. Before adding code or tests, identify which exit-condition claim is not already covered by the package suite, the demo, or the docs. A checkpoint may close with documentation and release wiring when the underlying contract is already proven.

The following are not release blockers by themselves:

- eliminating ordinary project-specific glue;
- publishing a generic adapter, ingestion, rules, or test framework;
- providing a second implementation of a host-owned concern;
- supporting every protocol flow or commerce model;
- adding broad browser, provider, database, or peer-version matrices.

AI can produce much of the application glue, but Mika must make the inputs, outputs, invariants, and security boundaries of that glue unambiguous.

---

## Required before the first public release

### S0 — Make wishlist and cross-scope moves concurrency-safe

**Why this is required**

Cart writes already have compare-and-swap semantics, while wishlist writes currently use blind read/modify/write behavior. Moving an item between cart and wishlist also updates two documents sequentially. Under concurrent requests this can lose data or leave an item duplicated or missing.

**Lean solution**

- Add a revision/version to wishlist state.
- Add wishlist compare-and-swap behavior to the session store contract.
- Make cart-to-wishlist and wishlist-to-cart moves retry-safe.
- If true cross-document atomicity is unavailable, define and test a recoverable operation contract rather than pretending the move is atomic.
- Preserve compatibility for simple in-memory hosts where practical.

**Proof**

- deterministic stale-write rejection tests;
- concurrent wishlist mutation tests;
- failure injection between the two sides of a move;
- retry tests proving that a repeated request converges without loss or duplication.

**Exit condition**

The public storage contract states its concurrency guarantees, and the reference in-memory implementation passes the failure and retry suite.

### S1 — Make the existing extension seams sufficient

**Why this is required**

Mika should not implement every tax, shipping, inventory, or fulfillment service. It does need to make host-supplied results representable and safely projectable.

**Lean solution**

- First build an external-style fixture using only the current public surface and record any fact it cannot express.
- Treat `MikaApiOverrides` and the existing lifecycle/notification hooks as the primary integration surface.
- Document how a host overrides quote and checkout operations to provide tax, shipping, fees, availability, and policy decisions.
- Add a provider-neutral DTO field only when the fixture proves a required fact cannot otherwise be represented honestly.
- Ensure quote proofs bind every value that can affect the charged total.
- Prefer a typed callback or operation override over a new service abstraction.

**Explicit non-goal**

Do not build a generic catalog ingestion pipeline, tax engine, shipping engine, or rules framework. The demo and docs should show how content is mapped into Mika DTOs; the host owns that mapping.

First-release physical fulfillment support is limited to classifying and projecting facts already supplied by the host. Mika will not calculate rates, collect new address shapes, manage carriers, or track shipments in this checkpoint. Unsupported fulfillment options are omitted.

**Proof**

- one fixture that supplies tax, shipping, and fees through the public override surface;
- one mixed or non-digital fulfillment fixture;
- type tests showing that the required extension can be implemented without importing Mika internals;
- tampering tests for every quote input covered by the proof hash.

**Exit condition**

A small external-style test fixture can implement business-specific quoting and fulfillment facts using only public exports.

### S2 — Make ACP output faithful and conformant

**Why this is required**

ACP is a public projection of Mika's semantic state. It must not advertise digital fulfillment for every non-empty quote or flatten useful domain errors into generic failures.

**Lean solution**

- Derive ACP fulfillment options from actual quote and line facts.
- Omit unsupported options instead of inventing them.
- Map semantic error codes and field paths into the richest ACP representation supported by the pinned protocol version.
- Pin the supported ACP schema/version in code and docs.
- Keep Mika's semantic API independent from ACP-specific types.

**Proof**

- validate `CheckoutSessionCreateRequest`, `CheckoutSessionUpdateRequest`, `CheckoutSessionCompleteRequest`, `CheckoutSession`, `CheckoutSessionWithOrder`, and `Error` against the official pinned schemas;
- add physical, digital, mixed, empty, unavailable, and invalid-input fixtures;
- retain snapshot tests only where they add readable protocol review value.

**Exit condition**

The named first-release schema set passes validation, and no fixture contains a fulfillment claim that was not present in semantic state. Additional ACP flows are post-ship work until Mika advertises them.

### S3 — Define the digital-delivery boundary precisely

**Why this is required**

The built-in fulfillment path can produce synthetic download references and deterministic license evidence, but a production host must still resolve private assets and deliver raw license material securely. That division is valid if it is explicit and usable.

**Lean solution**

- Keep Mika storage-neutral and secret-neutral.
- Document synthetic download references as opaque fulfillment records, not usable URLs.
- Document license hashes/suffixes as evidence, not raw credentials.
- Show one minimal host-owned extension example for resolving a download or issuing/delivering a raw key.
- Add a typed hook only if that example proves the current public override or notification surface cannot express the integration cleanly.
- Document replay, expiry, authorization, logging, and secret-redaction expectations.

**Explicit non-goal**

Do not bundle object storage, URL signing, a license server, or an email delivery provider.

**Proof**

- synthetic download references remain opaque and are not HTTP(S) URL-shaped;
- raw license material never appears in Mika DTOs, receipts, or logs;
- the minimal host-extension example compiles using public exports only;
- existing Mika-owned token authorization, expiry, and replay behavior remains covered by focused tests.

**Exit condition**

Observable tests prove that Mika exposes only fulfillment evidence, while the docs identify the exact host extension point for production asset or secret delivery.

### S4 — Add focused contract and lifecycle proof

**Why this is required**

The foundation is valuable only if alternative host implementations can preserve its invariants. We need strong proof around the highest-risk seams, not an exhaustive framework for every possible adapter.

**Lean solution**

- Keep contract helpers internal to the test suite unless a real third-party adapter needs a published harness.
- Use table-driven sequences for the highest-risk lifecycle invariants: completed checkouts stay terminal, stale writes fail, replay is idempotent, and invalid transitions never mutate state.
- Exercise one representative provider adapter and one reference session store through public contracts.
- Test representative read, mutation, checkout, fulfillment, and replay overrides through the normal dispatcher rather than exhaustively testing every operation.

**Explicit non-goal**

Do not publish an adapter test SDK, certify multiple databases, introduce a model-testing framework, or pursue blanket mutation/property testing before release.

**Exit condition**

Focused tests protect the public invariants a third-party implementation must preserve without adding a new package surface.

### S5 — Prove the release artifact, docs, and demo together

**Why this is required**

Source-tree tests do not prove that exports, declaration files, peer dependencies, or package metadata work for consumers.

**Lean solution**

- Pack the package exactly as it will be published.
- Install that tarball into a clean temporary consumer.
- Import each documented public entry point and run type-check plus a minimal runtime smoke test.
- Commit one locked release-consumer lane using Node 22.13.0, npm 11.16.0, Astro 7.0.0, and EmDash 0.22.0. Install the exact optional peers required by the imported subpaths: Kumo 2.5.2, Phosphor Icons React 2.1.10, React 19.2.7, and React DOM 19.2.7. Expand this lane only when compatibility problems justify it.
- Install the release candidate tarball into a disposable copy of `emdash-mika-template`, set `EMDASH_MIKA_TEMPLATE_SKIP_LOCAL_BUILD=1`, assert that Node resolves Mika from the installed candidate, then run the template's existing type-check, test, and build scripts. The template may keep its local-path dependency for day-to-day development.
- Build a disposable copy of `emdash-mika-docs`. Keep compile-checked integration examples in this package's test fixtures instead of building a new documentation snippet runner for the first release.
- Ensure no release-facing proof succeeds only because it resolves Mika source through a local path.

**Proof gate**

The release candidate must pass:

```text
core checks + tests
        |
        v
npm pack -> clean consumer type/runtime smoke
        |
        +-> demo build + integration tests
        |
        +-> public docs build
        |
        +-> ACP schema conformance
```

**Exit condition**

CI can prove that the exact artifact intended for publication supports the documented integration path.

---

## Documentation required for ship

The public docs should optimize for a developer—or an AI working with that developer—who needs to assemble a project-specific integration. This is a minimum content set, not a required one-page-per-topic structure.

### Foundation guide

Explain, in one short path:

1. create or obtain application product data;
2. map it to Mika catalog DTOs;
3. choose or implement a session store;
4. override quote/checkout behavior where business facts are external;
5. connect a payment provider;
6. handle fulfillment side effects;
7. expose the semantic API or an ACP projection;
8. verify the integration with Mika's contract tests.

### Boundary reference

Cover these boundaries in dedicated pages or clearly named sections:

- authentication and authorization;
- persistence and concurrency;
- catalog mapping;
- pricing, tax, shipping, and fees;
- payment-provider responsibilities;
- download and license delivery;
- webhook idempotency and replay;
- ACP support and versioning;
- data retention, logging, and secret handling.

For each boundary, state:

- what Mika guarantees;
- what the host must implement;
- the relevant public types and hooks;
- the smallest useful example or a link to the relevant demo implementation;
- a link to executable proof when the boundary is shared or high risk.

### AI-friendly reference material

Favor small, compilable examples and stable type names over long framework-specific tutorials. The demo is the end-to-end reference; the docs should not duplicate it as a second starter. An `llms.txt` or equivalent index is useful but not a first-release blocker. Generated glue remains the consumer's responsibility; Mika's docs make that glue easier to generate correctly.

---

## Post-ship backlog

These are valuable only after real integrations show demand. They are not first-release blockers.

### Protocol expansion

- ACP post-purchase flows such as returns, refunds, and richer physical fulfillment facts;
- a UCP projection built from the same semantic core;
- additional protocol adapters.

### Broader implementation kits

- catalog builders or CMS-specific mapping helpers;
- public storage-adapter certification suites;
- additional payment-provider adapters;
- prebuilt tax, shipping, inventory, download, or license integrations.

### Broader verification

- full browser automation across the demo;
- a wide Astro/Node/TypeScript peer matrix;
- mutation testing across all packages;
- performance baselines and load testing;
- cross-repository release automation beyond the single release-candidate gate.

### Operational enhancements

- standardized tracing and metrics adapters;
- richer audit exports;
- production runbooks for specific infrastructure stacks.

Promote an item from this backlog only when it is required by a supported protocol, repeated across multiple real consumers, or impossible to implement safely with the existing public surface.

---

## Recommended execution order

1. **S0:** close wishlist and move correctness gaps.
2. **S1:** prove the public override surface can carry host-owned quote and fulfillment facts.
3. **S2:** make ACP faithfully project those facts and pass pinned schema checks.
4. **S3:** lock down and document the digital-delivery boundary.
5. **S4:** add only the focused table-driven contract tests needed to protect those guarantees.
6. **S5:** run the package → consumer → demo/docs/protocol release gate.

S1 and the documentation work can proceed alongside S0. S2 depends on the final semantic facts from S1. S5 becomes the final release gate after the preceding contracts stabilize.

## Definition of done

Mika is ready to ship when a consumer can use public types and documented extension points to assemble a store-specific integration, and the repository proves that:

- the semantic core remains correct under concurrency and replay;
- provider projections are truthful;
- host-owned behavior can be supplied without internal imports or forks;
- production-sensitive boundaries are explicit;
- the published artifact, demo, and docs agree.

The goal is not zero glue. The goal is a small amount of obvious, type-safe, testable glue on top of a trustworthy foundation.
