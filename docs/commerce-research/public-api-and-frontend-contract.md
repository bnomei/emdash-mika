# Public API And Frontend Contract

Mika should expose stable backend contracts and copyable frontend examples. The
host project owns pages, markup, layout, and styling.

## Route Ownership

Mika-owned public routes are API/operation endpoints, not storefront pages.

- JSON endpoints return DTOs and `MikaError` codes.
- Redirect endpoints perform narrow provider/account redirects.
- Copyable Astro examples own HTML pages such as cart, account, checkout
  success, checkout cancel, and download pages.
- React/headless helpers and Astro Actions call the same service methods as the
  public endpoints.

This keeps Mika Kirby-like in setup without making it a theme or page system.

## Route And Action Matrix

Plugin routes use `/_emdash/api/plugins/mika/<route>`. Query strings and JSON
bodies carry IDs; copied Astro pages own friendly browser paths.

| Surface                 | Plugin route                                            | Astro Action                            | Service                                    |
| ----------------------- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| Sellables               | `GET catalog/sellables?collection=products&id=ring`     | `mika.catalog.sellables`                | `SellableService.listForContent`           |
| Availability            | `GET sellables/availability?sellableId=sellable_1`      | `mika.stock.availability`               | `StockService.checkAvailability`           |
| Cart read               | `GET cart`                                              | n/a                                     | `CartService.get`                          |
| Cart add                | `POST cart/items`                                       | `mika.cart.add`                         | `CartService.addItem`                      |
| Cart update             | `PATCH cart/item`                                       | `mika.cart.update`                      | `CartService.updateItem`                   |
| Cart remove             | `DELETE cart/item`                                      | `mika.cart.remove`                      | `CartService.removeItem`                   |
| Cart merge              | `POST cart/merge`                                       | `mika.cart.merge`                       | `CartService.merge`                        |
| Coupon apply/remove     | `POST/DELETE cart/coupon`                               | `mika.cart.applyCoupon/removeCoupon`    | `CouponService.apply/remove`               |
| Wishlist read           | `GET wishlist`                                          | n/a                                     | `WishlistService.get`                      |
| Wishlist add            | `POST wishlist/items`                                   | `mika.wishlist.add`                     | `WishlistService.addItem`                  |
| Wishlist remove         | `DELETE wishlist/item`                                  | `mika.wishlist.remove`                  | `WishlistService.removeItem`               |
| Wishlist move/save      | `POST wishlist/move-to-cart`, `wishlist/save-for-later` | `mika.wishlist.moveToCart/saveForLater` | `WishlistService.move/save`                |
| Checkout start          | `POST checkout`                                         | `mika.checkout.start`                   | `CheckoutService.start`                    |
| Checkout status         | `GET checkout/status?checkoutId=...&token=...`          | `mika.checkout.status`                  | `CheckoutService.status`                   |
| Checkout success page   | copied `/checkout/success` page                         | n/a                                     | `CheckoutService.status`                   |
| Checkout cancel page    | copied `/checkout/cancel` page                          | n/a                                     | `CheckoutService.cancel/release`           |
| Magic link request      | `POST magic-link`                                       | `mika.magicLink.request`                | `MagicLinkService.request`                 |
| Magic link consume      | `POST magic-link/verify`                                | `mika.magicLink.verify`                 | `MagicLinkService.verify`                  |
| Account read            | `GET account`                                           | n/a                                     | `AccountService.get`                       |
| Account export request  | `POST account/export`                                   | `mika.account.export`                   | `AccountService.requestExport`             |
| Account export status   | `GET account/export/status?exportId=export_1`           | `mika.account.exportStatus`             | `AccountService.exportStatus`              |
| Account export download | `GET account/export/download?exportId=export_1`         | n/a                                     | `AccountService.downloadExport`            |
| Account delete request  | `POST account/delete`                                   | `mika.account.delete`                   | `AccountService.requestDelete`             |
| Portal redirect         | `POST account/portal`                                   | `mika.account.portal`                   | `SubscriptionService.createPortalRedirect` |
| Subscription cancel     | `POST subscriptions/cancel`                             | `mika.subscription.cancel`              | `SubscriptionService.cancel`               |
| Subscription change     | `POST subscriptions/change`                             | `mika.subscription.change`              | `SubscriptionService.change`               |
| Subscription renew      | `POST subscriptions/renew`                              | `mika.subscription.renew`               | `SubscriptionService.renew`                |
| Invoice redirect        | `GET orders/invoice?orderId=...&token=...`              | n/a                                     | `OrderService.invoiceRedirect`             |
| Download                | `GET download?token=...`                                | n/a                                     | `DownloadService.resolveToken`             |
| Webhook                 | `POST webhooks`                                         | n/a                                     | `WebhookService.accept`                    |

Unsupported provider capabilities should return stable errors instead of being
silently hidden at the API layer.

## Shared DTOs

Define these schemas once and reuse them for endpoints, Astro Actions, typed
client helpers, React hooks, examples, and admin action responses:

- `ContentRef`: `{ collection, id }`
- `SellableDTO`: `{ id, contentRef, sku, title, active, variantKey,
variantOptions, variantGroups, imageRef, prices, availability }`
- `PriceDTO`: `{ id, sellableId, amount, currency, mode, fulfillmentKind,
active }`
- `AvailabilityDTO`: `{ sellableId, status, availableQuantity, maxPerOrder,
lowStock, reservedByCurrentCheckout }`
- `CartDTO`: `{ id, status, currency, items, subtotal, discounts, total,
checkoutSessionId, errors }`
- `WishlistDTO`: `{ id, items }`
- `CheckoutSessionDTO`: `{ id, status, mode, provider, redirectUrl, expiresAt,
paymentPending, orderId, errors }`
- `AccountDTO`: `{ customer, orders, subscriptions, entitlements, downloads }`
- `SubscriptionDTO`: `{ id, status, currentPeriodEnd, cancelAtPeriodEnd,
providerActions }`
- `EntitlementDTO`: `{ key, status, source, expiresAt }`
- `ActionResultDTO`: `{ ok, data, error, warnings, effects }`
- `MikaError`: `{ code, message, fieldErrors, retryAfter, correlationId }`

Public examples may display friendly messages, but code should branch on error
codes.

## Error Codes

Initial error taxonomy:

- `VALIDATION_FAILED`
- `CSRF_INVALID`
- `RATE_LIMITED`
- `AUTH_REQUIRED`
- `FORBIDDEN`
- `SELLABLE_NOT_FOUND`
- `SELLABLE_INACTIVE`
- `PRICE_INACTIVE`
- `VARIANT_INVALID`
- `OUT_OF_STOCK`
- `MAX_PER_ORDER_EXCEEDED`
- `CHECKOUT_EMPTY`
- `CHECKOUT_EXPIRED`
- `CHECKOUT_BINDING_MISMATCH`
- `PAYMENT_PENDING`
- `PROVIDER_UNSUPPORTED`
- `PROVIDER_FAILED`
- `TOKEN_INVALID`
- `TOKEN_EXPIRED`
- `TOKEN_USED`
- `DOWNLOAD_REVOKED`
- `WEBHOOK_INVALID`
- `CONFLICT`

Admin actions can wrap these in Kumo toasts/inline feedback, but the underlying
code should remain stable.

## Variant Request Shape

Preferred input is always `sellableId`.

For copyable product pages, Mika may also accept:

- `contentRef + variantKey`
- `contentRef + variantOptions`

Variant options should use stable option/value IDs, not display labels:

```json
{ "size": "17", "finish": "brushed" }
```

`variantKey` is generated by sorting option IDs, lowercasing ASCII IDs, removing
whitespace, and joining `option:value` pairs with commas:

```txt
finish:brushed,size:17
```

`variantKey` is an addressing convenience only. The resolved `sellableId` is the
identity stored in carts, wishlists, orders, provider line items, entitlements,
and stock.

## Checkout Frontend States

Success and cancel routes must support more than binary success/failure:

- `pending`: user returned before webhook/provider confirmation.
- `completed`: order exists and entitlements/stock were applied.
- `cancelled`: provider cancel or user cancel.
- `expired`: checkout or stock reservation expired.
- `failed`: provider or local error.
- `binding_mismatch`: return data does not match local checkout binding.

Copyable examples should show a pending/reconciling state and poll
`GET /_emdash/api/plugins/mika/checkout/status?checkoutId=...&token=...` rather
than promising immediate fulfillment. The token comes from checkout start and
raw checkout IDs are not bearer access.

## Accessibility And No-JS Baseline

Copyable Astro components and React/headless primitives should require:

- visible labels for form fields
- keyboard-operable variant selectors
- field-level validation messages
- focus management after submission errors
- `aria-live` updates for cart, stock, and checkout status changes
- real disabled/loading states for unavailable actions
- no-JS form behavior for add-to-cart, wishlist, magic link, and checkout start
  where the host project uses server-rendered pages
