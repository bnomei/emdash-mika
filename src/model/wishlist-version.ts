/**
 * Increments a wishlist's optimistic-concurrency version. A missing version represents a
 * document persisted before wishlist CAS existed and is treated as version 0.
 */
export function nextWishlistVersion(current: number | undefined): number {
  return (current ?? 0) + 1;
}
