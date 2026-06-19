import { sql, type RawBuilder } from "kysely";

export interface ReserveStockStatementInput {
  readonly stockItemId: string;
  readonly quantity: number;
  readonly now: string;
}

export interface ReleaseStockStatementInput {
  readonly stockItemId: string;
  readonly quantity: number;
  readonly now: string;
}

export interface AdjustStockStatementInput {
  readonly stockItemId: string;
  readonly quantityDelta: number;
  readonly now: string;
}

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

export function releaseStockStatement(input: ReleaseStockStatementInput): RawBuilder<unknown> {
  return sql`
    UPDATE mika_stock_items
    SET
      quantity_reserved = MAX(0, quantity_reserved - ${input.quantity}),
      updated_at = ${input.now}
    WHERE id = ${input.stockItemId}
  `;
}

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
