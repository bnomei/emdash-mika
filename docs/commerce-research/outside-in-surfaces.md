# Outside-In Surfaces

Mika should feel like a small commerce kit, not a store builder. The plugin
should provide backend primitives, typed client helpers, unstyled UI primitives,
copyable Astro examples, and small Kumo admin surfaces. Site owners keep control
of routes, templates, styling, product pages, and content models.

## Product Principle

Provide the boring commerce machinery once:

- persistence
- checkout sessions
- provider adapters
- webhooks
- customer identity
- magic-link email
- carts and wishlists
- sellables, variants, and stock reservations
- orders, subscriptions, entitlements, licenses, downloads
- admin actions and diagnostics

Do not provide the site:

- storefront theme
- product page layout
- tax engine
- shipping engine
- warehouse inventory suite
- full CRM
- analytics suite

This is the Astro equivalent of a Kirby plugin with snippets: Mika ships the
primitives and examples, but the project owns the final markup.

## Setup Experience

Mika should support three setup layers.

### 1. Backend Installed, No UI

The user registers `mikaPlugin()` in the EmDash/Astro config. That gives them:

- migrations and plugin-owned tables
- plugin route contracts for cart, wishlist, checkout, account, magic links,
  downloads, sellable availability, and webhooks, with only catalog and stock
  JSON routes public until mutation routes have explicit guards
- provider registry
- mail service
- rate limiter
- EmDash dashboard action provider
- typed server/client helpers

This layer should be usable from custom Astro pages without copying any Mika UI.

### 2. Copyable Astro Examples

The package should ship examples under a path like:

```txt
examples/astro/
  actions/mika.ts
  pages/cart.astro
  pages/checkout/success.astro
  pages/checkout/cancel.astro
  pages/account.astro
  pages/account/magic-link.astro
  pages/download/[token].ts
  components/AddToCartForm.astro
  components/BuyNowForm.astro
  components/VariantSelector.astro
  components/VariantOptionGroups.astro
  components/StockBadge.astro
  components/LowStockNotice.astro
  components/UnavailableNotice.astro
  components/CartSummary.astro
  components/CartLines.astro
  components/WishlistForm.astro
  components/WishlistList.astro
  components/CheckoutForm.astro
  components/MagicLinkForm.astro
  components/AccountOrders.astro
  components/AccountSubscriptions.astro
  components/AccountDownloads.astro
```

These files should be plain, readable, and lightly styled or unstyled. They are
examples to copy, not a framework that locks the project into Mika layouts.

### 3. React/Headless Primitives

For projects that use React islands, Mika can export headless helpers:

- `MikaProvider`
- `useMikaSellables(contentRef)`
- `useMikaStock(sellableId)`
- `VariantSelector`
- `StockBadge`
- `AddToCartButton`
- `BuyNowForm`
- `WishlistToggle`
- `CartLineList`
- `CheckoutButton`
- `MagicLinkForm`

Components should support render props or slot-style composition where useful.
They should not impose Kumo, Tailwind, or a storefront visual style.

## Plugin Routes Mika Should Own

These should exist automatically once the plugin is registered. They are
EmDash plugin operation/API routes, not storefront pages; copied Astro examples
can wrap them in project-owned pages.

Plugin routes use:

```txt
/_emdash/api/plugins/mika/<route>
```

IDs are passed in query strings or JSON bodies instead of dynamic route
segments.

Only catalog sellables and sellable availability are public JSON routes by
default. Cart, wishlist, checkout, account, subscription, download, invoice,
webhook, and admin JSON routes are server/plugin integration contracts until
they have explicit auth, CSRF, rate-limit, and method validation.

- `GET /_emdash/api/plugins/mika/catalog/sellables?collection=products&id=ring`
- `GET /_emdash/api/plugins/mika/sellables/availability?sellableId=sellable_1`
- `GET /_emdash/api/plugins/mika/cart`
- `POST /_emdash/api/plugins/mika/cart/items`
- `PATCH /_emdash/api/plugins/mika/cart/item`
- `DELETE /_emdash/api/plugins/mika/cart/item`
- `POST /_emdash/api/plugins/mika/cart/merge`
- `POST /_emdash/api/plugins/mika/cart/coupon`
- `DELETE /_emdash/api/plugins/mika/cart/coupon`
- `GET /_emdash/api/plugins/mika/wishlist`
- `POST /_emdash/api/plugins/mika/wishlist/items`
- `DELETE /_emdash/api/plugins/mika/wishlist/item`
- `POST /_emdash/api/plugins/mika/wishlist/move-to-cart`
- `POST /_emdash/api/plugins/mika/wishlist/save-for-later`
- `POST /_emdash/api/plugins/mika/wishlist/merge`
- `POST /_emdash/api/plugins/mika/checkout`
- `GET /_emdash/api/plugins/mika/checkout/status?checkoutId=checkout_1&token=...`
- `POST /_emdash/api/plugins/mika/magic-link`
- `POST /_emdash/api/plugins/mika/magic-link/verify`
- `GET /_emdash/api/plugins/mika/account`
- `POST /_emdash/api/plugins/mika/account/export`
- `GET /_emdash/api/plugins/mika/account/export/status?exportId=export_1`
- `GET /_emdash/api/plugins/mika/account/export/download?exportId=export_1&token=...`
- `POST /_emdash/api/plugins/mika/account/delete`
- `POST /_emdash/api/plugins/mika/account/portal`
- `POST /_emdash/api/plugins/mika/subscriptions/cancel`
- `POST /_emdash/api/plugins/mika/subscriptions/change`
- `POST /_emdash/api/plugins/mika/subscriptions/renew`
- `GET /_emdash/api/plugins/mika/orders/invoice?orderId=order_1&token=...`
- `GET /_emdash/api/plugins/mika/download?token=...`
- `POST /_emdash/api/plugins/mika/webhooks`

Copied Astro pages own the browser-facing paths such as `/cart`, `/wishlist`,
`/account`, `/checkout/success`, `/checkout/cancel`, and `/download/[token]`.
Checkout success and invoice links should use Mika-issued tokens or
customer-scoped request context, not raw object IDs as bearer URLs.
Raw provider webhooks should use copied Astro endpoints or explicitly
raw-body-capable EmDash routes, not the generic JSON route.

## Astro Actions Mika Should Provide

Mika should export action factories for projects that want Astro Actions:

```ts
import { createMikaActions } from "@bnomei/emdash-mika/astro-actions";

export const server = {
  mika: createMikaActions(),
};
```

Candidate actions:

- `mika.catalog.sellables`
- `mika.stock.availability`
- `mika.cart.add`
- `mika.cart.update`
- `mika.cart.remove`
- `mika.wishlist.add`
- `mika.wishlist.remove`
- `mika.checkout.start`
- `mika.checkout.status`
- `mika.magicLink.request`
- `mika.magicLink.verify`
- `mika.account.export`
- `mika.account.exportStatus`
- `mika.account.delete`
- `mika.account.portal`
- `mika.subscription.cancel`
- `mika.subscription.change`
- `mika.subscription.renew`

These actions should call the same backend services as the public endpoints.
That keeps form examples, custom endpoints, and React islands aligned.
Shared DTOs and error codes are defined in
[Public API And Frontend Contract](public-api-and-frontend-contract.md).

## Content Integration

EmDash content should remain the product catalog. Mika should provide schema
helpers and examples, not own every product field.

Recommended copyable schema snippets:

- product content fields: title, slug, images, body, downloads
- Mika catalog binding field: content entry to a `catalog` collection aggregate
- Mika sellable/variant field: default sellable or option rows
- Mika price reference field: nested prices under a sellable
- optional field action: create/sync sellables and prices for the current product
- optional field action: preview active sellables, variants, stock, and price IDs

The actual commerce records belong in the Mika `catalog` collection as typed
aggregate JSON, with sellables and prices nested under the content-linked
catalog document. Finite/manual stock counters live in `mika_stock_items`.

## Admin UI

Keep admin small and operational. Use Kumo components for dense, utilitarian
dashboards:

- `Table` for recent orders, stock, webhook failures, subscriptions,
  entitlements
- `Badge` for status
- `Button` for actions
- `Dialog` for destructive confirmations
- `Banner` for provider/config warnings
- `Tabs` for order detail sections
- `Field`, `Input`, `Select`, `Switch` for settings and manual grants
- `Empty` for no-data states
- `Toasty` through `emdash-actions` responses

Avoid a custom shop admin. Prefer raw resource views over complex workflows.

## Admin Resources

Mika should expose resource-like views backed by plugin tables:

- Prices
- Sellables
- Stock
- Stock Reservations
- Stock Movements
- Orders
- Customers
- Subscriptions
- Entitlements
- Webhook Events
- Email Messages
- Provider Sync Runs
- Audit Events

These are not storefront content collections. They are operational records.
Most should be read-only, with narrow actions for the few safe mutations.

## Dashboard Actions

Register a Mika provider for `@bnomei/emdash-actions`. Every dashboard action
should call the same backend service method that automatic flows use.

Actions:

- `mika.provider.health`
- `mika.provider.sync`
- `mika.stock.adjust`
- `mika.stock.releaseExpiredReservations`
- `mika.webhook.replay`
- `mika.order.refund`
- `mika.order.cancel`
- `mika.entitlement.grant`
- `mika.entitlement.revoke`
- `mika.email.resend`
- `mika.license.revoke`
- `mika.download.issue`

Destructive actions need confirmations. Unsupported provider actions should be
hidden or disabled based on provider capabilities.

## What Mika Provides Vs Examples

Mika package owns:

- database schema and migrations
- backend services
- provider adapter contract
- routes/endpoints
- Astro Action factories
- typed fetch client
- React hooks/headless primitives
- Kumo admin widgets/resources
- EmDash actions manifest and routes

Examples own:

- pages
- forms
- markup
- styling
- project page routes
- project-specific schema snippets
- project-specific email templates

This gives users a Kirby-like light setup without forcing a Kirby-like template
registration system into Astro.
