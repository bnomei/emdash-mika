/**
 * Parameterized raw SQL statements for atomic stock quantity mutations.
 * Used inside repository transactions to reserve, release, consume, and adjust inventory.
 */
import { sql, type RawBuilder } from "kysely";

/** Input for atomically incrementing reserved quantity on a stock item. */
export interface ReserveStockStatementInput {
  readonly stockItemId: string;
  readonly quantity: number;
  readonly now: string;
}

/** Input for atomically decrementing reserved quantity on a stock item. */
export interface ReleaseStockStatementInput {
  readonly stockItemId: string;
  readonly quantity: number;
  readonly now: string;
}

/** Input for atomically adjusting on-hand quantity with non-negative guard. */
export interface AdjustStockStatementInput {
  readonly stockItemId: string;
  readonly quantityDelta: number;
  readonly now: string;
}

/** SQL update that reserves stock when policy and availability allow. */
export function reserveStockStatement(input: ReserveStockStatementInput): RawBuilder<unknown> {
  return sql`
    UPDATE mika_stock_items
    SET
      quantity_reserved = quantity_reserved + ${input.quantity},
      updated_at = ${input.now}
    WHERE id = ${input.stockItemId}
      AND (
        policy != 'finite'
        OR allow_backorder = 1
        OR quantity_on_hand - quantity_reserved >= ${input.quantity}
      )
  `;
}

/** SQL update that releases reserved quantity back to availability. */
export function releaseStockStatement(input: ReleaseStockStatementInput): RawBuilder<unknown> {
  return sql`
    UPDATE mika_stock_items
    SET
      quantity_reserved = MAX(0, quantity_reserved - ${input.quantity}),
      updated_at = ${input.now}
    WHERE id = ${input.stockItemId}
  `;
}

/** SQL update that fulfills a reservation by decrementing on-hand and reserved quantities. */
export function consumeReservedStockStatement(
  input: ReleaseStockStatementInput,
): RawBuilder<unknown> {
  return sql`
    UPDATE mika_stock_items
    SET
      quantity_on_hand = CASE
        WHEN policy = 'finite' THEN MAX(0, quantity_on_hand - ${input.quantity})
        ELSE quantity_on_hand
      END,
      quantity_reserved = MAX(0, quantity_reserved - ${input.quantity}),
      updated_at = ${input.now}
    WHERE id = ${input.stockItemId}
  `;
}

/** SQL update that consumes on-hand quantity for expired reservation fulfillment. */
export function consumeOnHandStatement(input: ReleaseStockStatementInput): RawBuilder<unknown> {
  return sql`
    UPDATE mika_stock_items
    SET
      quantity_on_hand = CASE
        WHEN policy = 'finite' THEN MAX(0, quantity_on_hand - ${input.quantity})
        ELSE quantity_on_hand
      END,
      updated_at = ${input.now}
    WHERE id = ${input.stockItemId}
  `;
}

/** SQL update that applies a signed on-hand adjustment when result stays non-negative. */
export function adjustStockStatement(input: AdjustStockStatementInput): RawBuilder<unknown> {
  return sql`
    UPDATE mika_stock_items
    SET
      quantity_on_hand = quantity_on_hand + ${input.quantityDelta},
      updated_at = ${input.now}
    WHERE id = ${input.stockItemId}
      AND quantity_on_hand + ${input.quantityDelta} >= 0
  `;
}
