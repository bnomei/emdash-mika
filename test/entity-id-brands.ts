/**
 * Compile-time contracts for nominal entity id brands.
 *
 * Soft `MikaId & { __mikaEntity? }` brands allowed `MikaId` → every entity and
 * weakened cross-entity rejection. Required unique-symbol brands close both gaps.
 *
 * Never executed; typechecked by `tsc -p test/tsconfig.json` as part of `npm run test`.
 */
import type {
  CartId,
  CheckoutSessionId,
  MikaId,
  OrderId,
  PriceId,
  SellableId,
} from "../src/types/primitives";

/** True when `Source` is assignable to `Target`. */
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
/** Compile-time assert: fails typecheck when `Condition` is not `true`. */
type AssertTrue<Condition extends true> = Condition;

// Entity brands are pairwise incompatible.
type _SellableNotCart = AssertTrue<IsAssignable<SellableId, CartId> extends true ? false : true>;
type _CartNotSellable = AssertTrue<IsAssignable<CartId, SellableId> extends true ? false : true>;
type _PriceNotOrder = AssertTrue<IsAssignable<PriceId, OrderId> extends true ? false : true>;
type _OrderNotPrice = AssertTrue<IsAssignable<OrderId, PriceId> extends true ? false : true>;
type _CheckoutNotCart = AssertTrue<
  IsAssignable<CheckoutSessionId, CartId> extends true ? false : true
>;
type _CartNotCheckout = AssertTrue<
  IsAssignable<CartId, CheckoutSessionId> extends true ? false : true
>;

// Bare MikaId must not silently satisfy entity brands (mint via create* / Zod).
type _MikaNotSellable = AssertTrue<IsAssignable<MikaId, SellableId> extends true ? false : true>;
type _MikaNotCart = AssertTrue<IsAssignable<MikaId, CartId> extends true ? false : true>;
type _MikaNotPrice = AssertTrue<IsAssignable<MikaId, PriceId> extends true ? false : true>;
type _MikaNotCheckout = AssertTrue<
  IsAssignable<MikaId, CheckoutSessionId> extends true ? false : true
>;
type _MikaNotOrder = AssertTrue<IsAssignable<MikaId, OrderId> extends true ? false : true>;

// Entity brands remain usable where a generic MikaId is accepted.
type _SellableIsMika = AssertTrue<IsAssignable<SellableId, MikaId>>;
type _CartIsMika = AssertTrue<IsAssignable<CartId, MikaId>>;
type _PriceIsMika = AssertTrue<IsAssignable<PriceId, MikaId>>;
type _CheckoutIsMika = AssertTrue<IsAssignable<CheckoutSessionId, MikaId>>;
type _OrderIsMika = AssertTrue<IsAssignable<OrderId, MikaId>>;

// Keep referenced so unused-alias lint / isolated tooling does not drop them.
export type EntityIdBrandContracts = [
  _SellableNotCart,
  _CartNotSellable,
  _PriceNotOrder,
  _OrderNotPrice,
  _CheckoutNotCart,
  _CartNotCheckout,
  _MikaNotSellable,
  _MikaNotCart,
  _MikaNotPrice,
  _MikaNotCheckout,
  _MikaNotOrder,
  _SellableIsMika,
  _CartIsMika,
  _PriceIsMika,
  _CheckoutIsMika,
  _OrderIsMika,
];
