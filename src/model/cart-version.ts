/**
 * Cart optimistic-concurrency version arithmetic. Domain logic shared by the storage adapters
 * (SessionRepository CAS writes) and the backend services (cart/quote/fulfillment mutations), so
 * it lives in the model layer instead of either one reaching into the other.
 */

/**
 * Increments a cart's optimistic-concurrency version, tolerating a missing `current` (a cart
 * persisted before this field existed) by treating it as version 0 rather than producing NaN —
 * which would otherwise permanently 409 every write to that cart from here on (NaN !== NaN).
 */
export function nextCartVersion(current: number | undefined): number {
  return (current ?? 0) + 1;
}
