DEVANA-FINDING: v1
DEVANA-STATE: fixed | P2 | medium | security=no
DEVANA-KEY: src/stripe.ts:746 | provider-refund-chargeback-webhook-unmapped

# Provider-initiated refund / chargeback webhooks fall through to `unknown`, so the order stays `paid` and entitlements stay active

## Finding

`parseStripeWebhookEvent` (`src/stripe.ts:658-747`) has no branch for any `charge.*` event. A `charge.refunded`, `charge.dispute.created` (chargeback), or `invoice.marked_uncollectible` event:
- does not start with `customer.subscription.` (line 667),
- is not in `STRIPE_PAYMENT_FAILURE_TYPES` (lines 749-753),
- does not start with `invoice.` *paid* (lines 688-691 → `unknown` when not paid),
- is not `payment_intent.succeeded` (711) or a paid `checkout.session.completed` (727),

so it returns `unknownStripeWebhookEvent` (`src/stripe.ts:746`). `processStoredWebhook` then hits `case "unknown": return webhook;` (`src/api/backend.ts:4013-4014`) and `receiveWebhook` reports `{ ok: true, status: "received" }` (`src/api/backend.ts:3442-3452`). The order document is never touched: it stays `status: "paid"`, `paymentStatus: "paid"`, and any order/subscription entitlement stays `active`.

## Violated Invariant Or Contract

A provider-confirmed money reversal (a refund issued from the Stripe dashboard, an involuntary `charge.dispute.created` chargeback, or `invoice.marked_uncollectible`) must downgrade the order's `paymentStatus`/`status` away from `paid` and revoke the associated entitlement.

## Oracle

The order state model anticipates refunds: `OrderStatus`/`PaymentStatus` include `refunded`/`partially_refunded` (`src/types/primitives.ts`), and `orderIsPaymentTerminal` (`src/api/lifecycle.ts:15-24`) exists specifically to model post-refund terminal states. Yet no event mapping moves an order into those states from a provider-initiated reversal.

## Counterexample

A paid order is later refunded from the Stripe dashboard, or the buyer files a chargeback:
1. Stripe sends `charge.refunded` (or `charge.dispute.created`).
2. `parseStripeWebhookEvent` matches no branch → `unknownStripeWebhookEvent` (`src/stripe.ts:746`).
3. `processStoredWebhook` `case "unknown"` returns the webhook untouched (`src/api/backend.ts:4013-4014`); receive reports `received` (success).
4. The order stays `paid`; the customer keeps digital access (entitlement/license/download) while the merchant has lost the money.

## Why It Might Matter

Revenue loss with retained access: after a refund or chargeback the customer continues to hold active digital entitlements. Chargebacks especially are involuntary and provider-side only — there is no admin action that initiates them — so they are silently dropped.

## Proof

Static dispatch trace + contract mismatch: no `charge.*` branch exists in `parseStripeWebhookEvent` (658-747); the only downgrade path (`STRIPE_PAYMENT_FAILURE_TYPES`) covers payment *failures*, not post-capture reversals, and `case "unknown"` is a silent success ack.

## Counterevidence Checked

- This is arguably a missing-feature gap, but the state model (`refunded`/`partially_refunded`, `orderIsPaymentTerminal`) shows refunds are expected to move an order out of `paid` — the event mapping just never delivers that for provider-initiated reversals.
- Distinct from `refund-leaves-entitlements-active` (the admin `order.refund` API updating ledger status but leaving entitlements live): here the order never even leaves `paid`, and the trigger is a provider webhook (incl. involuntary chargebacks) that the admin path cannot cover.
- Distinct from `stripe-async-payment-succeeded-unmapped` (a different unmapped event on the success side).
- Strongest false-positive reason: a merchant who only ever refunds via Mika's admin API and never receives disputes would not hit the dashboard-refund case — but `charge.dispute.created` is involuntary and unavoidable, and dashboard refunds are common, so the path is reachable.

## Suggested Next Step

Map `charge.refunded` / `charge.dispute.created` / `invoice.marked_uncollectible` to a refund/chargeback payment event that downgrades `order.paymentStatus`/`status` to `refunded`/`partially_refunded` (or a dispute state) and revokes the order/subscription entitlement, reusing the existing terminal-state model.

## Agent Handoff

After working this report, preserve the original finding body. Update line 2 `DEVANA-STATE:` and the final `DEVANA-SUMMARY:` prefix. Keep `DEVANA-KEY:` stable unless the same finding moved.

## Status Notes

- 2026-06-29: open by Devana. Verified no `charge.*` branch in `parseStripeWebhookEvent` (src/stripe.ts:658-747) and the silent `unknown` ack at `src/api/backend.ts:4013-4014` / `3442-3452`; state model refund states at `lifecycle.ts:15-24`.
- 2026-06-30: fixed (chosen approach exactly as the Suggested Next Step — map the reversal events, then downgrade + revoke through the existing terminal-state model). Two layers: (1) PARSER (`src/stripe.ts`): added `STRIPE_PAYMENT_REVERSAL_TYPES` (`charge.refunded`, `charge.dispute.created`, `invoice.marked_uncollectible`) and `stripePaymentReversalEvent`, checked BEFORE the `invoice.` branch (so `invoice.marked_uncollectible` is not swallowed as a non-paid invoice). It normalizes to `kind: "payment"` with `paymentStatus: "refunded"` for a full reversal (a dispute/chargeback, an uncollectible invoice, or a `charge.refunded` with `refunded: true`/`amount_refunded >= amount`) or `"partially_refunded"` for a partial `charge.refunded`, links to the order via `payment_intent` (fallback `charge`, then object id) as `providerPaymentId`/`providerOrderId`, and carries the cumulative reversed amount in `totals.total`. (2) DISPATCHER (`src/api/backend.ts`): `processStoredWebhook`'s `case "payment"` now intercepts `refunded`/`partially_refunded` BEFORE the generic `!= "paid"` failure branch (which only marked the WEBHOOK failed and never touched the order) and routes to a new `processPaymentReversalWebhook`. That finds the order (`findExistingPaymentOrder`), and — reusing the admin-refund machinery — applies `updateOrderAfterRefund`/`applyOrderRefund` (downgrading `status`/`paymentStatus` to `refunded`/`partially_refunded`) and, on a full reversal, `revokeOrderFulfillmentAccess` (revokes order-line entitlements/licenses with `revokeReason: "order_refunded"`). For a partial event it converts Stripe's cumulative refunded amount to this event's delta via `orderRefundedAmount(order)` so repeated partial webhooks don't double-count; full reversals pass no amount. Idempotent: a re-delivered reversal for an already-`refunded` order is a no-op, and a reversal with no matching Mika order is acknowledged (processed) rather than failed/retried forever. Evidence: a parser test asserts all four reversal shapes (full/partial refund, dispute, uncollectible) normalize correctly; two dispatcher tests assert a full `charge.refunded` webhook downgrades a paid order to `refunded` and revokes its entitlement+license, while a partial one moves it to `partially_refunded` (refundAmount 500/1200) and retains access. Mutation-verified at both layers: neutering the parser reversal branch (charge.refunded -> unknown) fails the parser test, and neutering the dispatcher reversal branch (order stays paid) fails the dispatcher test (cp-backup + restore, no git). Full suite (408) and both tsc configs pass.

DEVANA-KEY: src/stripe.ts:746 | provider-refund-chargeback-webhook-unmapped
DEVANA-SUMMARY: fixed | P2 | medium | Stripe `charge.refunded`/`charge.dispute.created`/`invoice.marked_uncollectible` now parse to a reversal payment event (`paymentStatus: refunded`/`partially_refunded`), and `processStoredWebhook` routes those to a new `processPaymentReversalWebhook` that downgrades the order off `paid` and (on a full reversal) revokes its entitlements/licenses via the existing admin-refund machinery — partial refunds retain access, idempotent on redelivery, and an unmatched reversal is acked not failed. Parser + 2 dispatcher tests, mutation-verified at both layers.
