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

- a semantic commerce API with 47 registered operations;
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

1. Core state transitions do not silently lose wishlist or cart data under concurrent writes.
2. Provider projections never invent fulfillment facts or hide actionable semantic errors.
3. Existing override and hook surfaces are sufficient for a host to supply business-specific behavior without forking Mika.
4. Shared extension mechanisms and the highest-risk integration boundaries have documented examples and executable tests.
5. A packed package installs and type-checks in a clean consumer project.
6. The demo builds and its integration tests pass against the release candidate package.
7. The public documentation builds and accurately distinguishes Mika-owned behavior from host-owned glue.

Anything beyond these criteria is post-ship unless it fixes a demonstrated correctness or security problem.

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

- validate representative cart, checkout, completion, and error payloads against the official pinned schemas;
- add physical, digital, mixed, empty, unavailable, and invalid-input fixtures;
- retain snapshot tests only where they add readable protocol review value.

**Exit condition**

All advertised ACP flows pass schema validation and no fixture contains a fulfillment claim that was not present in semantic state.

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

- synthetic download references remain opaque and are not URL-shaped;
- raw license material never appears in Mika DTOs, receipts, or logs;
- the minimal host-extension example compiles using public exports only;
- existing Mika-owned token authorization, expiry, and replay behavior remains covered by focused tests.

**Exit condition**

Observable tests prove that Mika exposes only fulfillment evidence, while the docs identify the exact host extension point for production asset or secret delivery.

### S4 — Add focused contract and lifecycle proof

**Why this is required**

The foundation is valuable only if alternative host implementations can preserve its invariants. We need strong proof around the highest-risk seams, not an exhaustive framework for every possible adapter.

**Lean solution**

- Keep a small reusable provider-adapter contract helper covering capability declarations, unsupported operations, result normalization, and error mapping.
- Add a small session-store contract helper covering compare-and-swap and retry behavior.
- Add model-based or generated sequence tests for the highest-risk lifecycle invariants: completed checkouts stay terminal, stale writes fail, replay is idempotent, and invalid transitions never mutate state.
- Test representative read, mutation, checkout, fulfillment, and replay overrides through the normal dispatcher rather than exhaustively testing every operation.

**Explicit non-goal**

Do not publish a large adapter SDK, certify multiple databases, or pursue blanket mutation/property testing before release.

**Exit condition**

The reference implementations pass the same public contracts that a third-party implementation would need to satisfy.

### S5 — Prove the release artifact, docs, and demo together

**Why this is required**

Source-tree tests do not prove that exports, declaration files, peer dependencies, or package metadata work for consumers.

**Lean solution**

- Pack the package exactly as it will be published.
- Install that tarball into a clean temporary consumer.
- Import each documented public entry point and run type-check plus a minimal runtime smoke test.
- Test one supported peer-dependency combination before release; expand the matrix only when compatibility problems justify it.
- Run the existing `emdash-mika-template` build and integration tests against the release candidate tarball or published version.
- Build `emdash-mika-docs` and validate its code snippets or source anchors.
- Remove local-path package dependencies from release-facing proof.

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
        +-> public docs build + link/snippet checks
        |
        +-> ACP schema conformance
```

**Exit condition**

CI can prove that the exact artifact intended for publication supports the documented integration path.

---

## Documentation required for ship

The public docs should optimize for a developer—or an AI working with that developer—who needs to assemble a project-specific integration.

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

### Boundary pages

Maintain explicit pages for:

- authentication and authorization;
- persistence and concurrency;
- catalog mapping;
- pricing, tax, shipping, and fees;
- payment-provider responsibilities;
- download and license delivery;
- webhook idempotency and replay;
- ACP support and versioning;
- data retention, logging, and secret handling.

Each page should contain:

- what Mika guarantees;
- what the host must implement;
- the relevant public types and hooks;
- a minimal example;
- a link to executable proof when the page describes a shared mechanism or high-risk contract.

### AI-friendly reference material

Favor small, compilable examples and stable type names over long framework-specific tutorials. If useful, publish an `llms.txt` or equivalent index pointing to canonical concepts, API references, and examples. Generated glue remains the consumer's responsibility; Mika's docs make that glue easier to generate correctly.

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
5. **S4:** extract only the focused contract/model tests needed to protect those guarantees.
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
