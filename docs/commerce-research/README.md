# Mika Commerce Research

> **Status (2026-07-09): mostly HISTORICAL pre-implementation research.**  
> The product now ships a registry-backed API, branded money-path ids, native
> EmDash plugin, and copyable templates. Treat these docs as design provenance,
> not a live backlog.  
> **Live engineering work:** [docs/qa/ROADMAP-followup.md](../qa/ROADMAP-followup.md)  
> **Parent checklist:** [docs/qa/ROADMAP.md](../qa/ROADMAP.md)  
> **Surface audit (annotated):** [use-case-surface-audit.md](./use-case-surface-audit.md)

This folder captures the working research for a small commerce plugin for
EmDash/M-Dash, based on the useful parts of Kirby Kart and Kirby Klub.

The target is intentionally not a full e-commerce platform. Mika should make it
easy to sell a small set of products or access rights from an EmDash site using
hosted checkout, webhooks, local order snapshots, and lightweight entitlements.
Product pages, layouts, templates, tax, shipping, inventory operations, and
business-specific fulfillment should stay in the host site or in the payment
provider.

## Documents

- [Kirby Kart Summary](kirby-cart-summary.md): what Kart does and which pieces
  are worth reusing conceptually.
- [Kirby Klub Summary](kirby-klub-summary.md): what Klub does and which
  membership/gating ideas fit Mika.
- [Mika Scope](mika-scope.md): proposed product surface, must-support features,
  possible future features, and explicit non-goals.
- [Data Model](data-model.md): table candidates and which records should be
  first-class in Mika.
- [Database Layer And Indexes](database-layer-and-indexes.md): D1/SQLite
  constraints, catalog taxonomy boundary, hot query paths, indexes, FK delete
  semantics, and query-plan checks.
- [Sandbox Vs Native](sandbox-vs-native.md): implementation shape options for
  EmDash plugins.
- [MVP Feature Boundary](mvp-feature-boundary.md): the selected MVP scope after
  reviewing the original defer/maybe list.
- [Astro Security And Email](astro-security-and-email.md): Astro Actions,
  endpoints, sessions, CSRF/origin checks, rate limiting, and local mail
  precedent.
- [Provider And Purchase Contracts](provider-and-purchase-contracts.md):
  provider abstraction and purchase-mode shape that must exist from day one.
- [Outside-In Surfaces](outside-in-surfaces.md): what Mika provides, what users
  copy into Astro/React, and how the setup stays Kirby-like without owning the
  storefront.
- [Backend Flows And Relations](backend-flows-and-relations.md): table
  relationships, state machines, backend flows, and admin action reuse.
- [Variants And Stock](variants-and-stock.md): first-class sellables, variant
  modeling, stock reservations, stock ledger, and what remains out of scope.
- [Security And Abuse Controls](security-and-abuse.md): token policy, rate
  limits, webhook hardening, account export/delete, and admin action controls.
- [Data Lifecycle And Retention](data-lifecycle-and-retention.md): migration,
  cleanup, retention, account deletion, checkout saga, outbox, and unique index
  requirements.
- [Public API And Frontend Contract](public-api-and-frontend-contract.md):
  route/action parity, shared DTOs, error codes, variant input shape, checkout
  states, and accessibility baseline.
- [Admin Actions And Email Shell](admin-actions-and-email-shell.md): EmDash
  collection admin shape, `emdash-actions` provider wiring, dashboard/field
  actions, and minimal email templates.
- [Type Surface Simplification](type-surface-simplification.md): Tavily and
  subagent review of how to reduce TypeScript boilerplate with endpoint maps,
  const registries, derived storage types, and small frontend helpers.

## Local Evidence

The structured Orchid research packet lives at
`../../.orchid/spec-research/mika-commerce-baseline/`. Its `raw/` folder contains
Tavily crawls/searches/research for the public Kart, Klub, and Astro docs so
these notes can be discussed without repeatedly going online.

Useful source projects inspected locally:

- `../../../kirby-kart`
- `../../../kart.bnomei.com`
- `../../../kirby-klub`
- `../../../klub.bnomei.com`
- `../../../emdash-actions`
- `../../../emdash-fields`
- `../../../emdash-blocks`
- `../../../emdash-leoconomy`
