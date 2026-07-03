/**
 * Customer identity resolution, anonymization/ownership checks, and the request-context
 * hydration wrapper that lets cart/wishlist/checkout handlers resolve the caller's customerId
 * once and reuse it, instead of every handler re-deriving it from session/context independently.
 */
import { formatSubjectRef } from "../subject-ref";
import type { MikaRequestContext } from "../context";
import type {
  AccountExportDocument,
  CheckoutDocument,
  CustomerDocument,
  OrderDocument,
} from "../../types/documents";
import type { MikaId } from "../../types/primitives";
import type { MikaApiOverrides } from "../server";
import type { MikaBackendDependencies, MikaBackendRepositories } from "./ports";

type MikaCustomerHydrationInput = {
  readonly repositories: Pick<MikaBackendRepositories, "account">;
};

/** True once the customer record has been anonymized by an account-delete completion. */
export function isAnonymizedCustomer(customer: CustomerDocument): boolean {
  return customer.aggregate.metadata?.["anonymizedAt"] != null;
}

function customerIsCompatibleWithContext(
  customer: CustomerDocument,
  ctx: MikaRequestContext,
): boolean {
  return (
    !isAnonymizedCustomer(customer) &&
    !(ctx.userId && customer.userId && customer.userId !== ctx.userId)
  );
}

export function customerEmailHash(customer: CustomerDocument): string | undefined {
  return customer.emailHash ?? customer.aggregate.emailHash;
}

export async function resolveAccountIdentity(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
): Promise<
  | {
      readonly customer: CustomerDocument;
      readonly entitlements: Awaited<
        ReturnType<MikaBackendRepositories["account"]["listEntitlementsByCustomer"]>
      >["items"];
      readonly userId?: string;
      readonly emailHash?: string;
    }
  | {
      readonly customer: null;
      readonly entitlements: Awaited<
        ReturnType<MikaBackendRepositories["account"]["listEntitlementsByUser"]>
      >["items"];
      readonly userId?: string;
      readonly emailHash?: string;
    }
  | null
> {
  const sessionCustomerId = await ctx.session?.get<MikaId>("mika.customerId");
  const sessionUserId = await ctx.session?.get<string>("mika.userId");
  const sessionEmailHash = await ctx.session?.get<string>("mika.emailHash");
  const customerId = ctx.customerId ?? sessionCustomerId;
  const userId = ctx.userId ?? sessionUserId;

  if (customerId) {
    const customer = await input.repositories.account.findCustomerById(customerId);
    if (!customer || !customerIsCompatibleWithContext(customer, { ...ctx, userId })) return null;

    return {
      customer,
      entitlements: (await input.repositories.account.listEntitlementsByCustomer(customerId)).items,
      userId: customer.userId,
      emailHash: customerEmailHash(customer),
    };
  }

  if (userId) {
    const customer = await input.repositories.account.findCustomerByUserId(userId);
    if (customer) {
      if (isAnonymizedCustomer(customer)) return null;
      return {
        customer,
        entitlements: (
          await input.repositories.account.listEntitlementsByCustomer(customer.customerId)
        ).items,
      };
    }

    const entitlements = await input.repositories.account.listEntitlementsByUser(userId);
    if (entitlements.items.length > 0) {
      return { customer: null, entitlements: entitlements.items, userId };
    }
  }

  if (sessionEmailHash) {
    const customer = await input.repositories.account.findCustomerByEmailHash(sessionEmailHash);
    if (customer) {
      if (isAnonymizedCustomer(customer)) return null;
      return {
        customer,
        entitlements: (
          await input.repositories.account.listEntitlementsByCustomer(customer.customerId)
        ).items,
      };
    }

    const entitlements =
      await input.repositories.account.listEntitlementsByEmailHash(sessionEmailHash);
    if (entitlements.items.length > 0) {
      return { customer: null, entitlements: entitlements.items, emailHash: sessionEmailHash };
    }

    const orders = await input.repositories.ledger.listOrdersByEmailHash(sessionEmailHash, 1);
    if (orders.items.length > 0) {
      return { customer: null, entitlements: entitlements.items, emailHash: sessionEmailHash };
    }
  }

  return null;
}

export function orderBelongsToIdentity(
  order: OrderDocument,
  identity: NonNullable<Awaited<ReturnType<typeof resolveAccountIdentity>>>,
): boolean {
  const customerId = order.customerId ?? order.aggregate.customer.customerId;
  return Boolean(identity.customer && customerId === identity.customer.customerId);
}

export function orderAccessRevokedForAccountDelete(order: OrderDocument): boolean {
  const orderEmailHash = order.emailHash ?? order.aggregate.customer.emailHash;
  return orderEmailHash?.startsWith("account-deleted") ?? false;
}

export function orderAllowsDownload(order: OrderDocument): boolean {
  return (
    (order.status === "paid" || order.status === "partially_refunded") &&
    (order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded")
  );
}

export function accountExportBelongsToIdentity(
  document: AccountExportDocument,
  identity: NonNullable<Awaited<ReturnType<typeof resolveAccountIdentity>>>,
): boolean {
  if (identity.customer && document.customerId === identity.customer.customerId) return true;
  if (identity.userId && document.userId === identity.userId) return true;
  const identityEmailHash = identity.customer?.emailHash ?? identity.emailHash;
  return Boolean(identityEmailHash && document.record.emailHash === identityEmailHash);
}

export function accountExportSubjectHash(
  identity: NonNullable<Awaited<ReturnType<typeof resolveAccountIdentity>>>,
): string | undefined {
  if (identity.customer?.customerId) {
    return formatSubjectRef({ kind: "customer", id: identity.customer.customerId });
  }
  if (identity.userId) return formatSubjectRef({ kind: "user", id: identity.userId });
  return identity.emailHash
    ? formatSubjectRef({ kind: "email", id: identity.emailHash })
    : undefined;
}

export async function checkoutBelongsToContext(
  input: MikaCustomerHydrationInput,
  document: CheckoutDocument,
  ctx: MikaRequestContext,
): Promise<boolean> {
  const customerId = await effectiveCustomerId(input, ctx);
  if (document.customerId) return document.customerId === customerId;

  return Boolean(document.sessionId && ctx.sessionId && document.sessionId === ctx.sessionId);
}

async function effectiveCustomerId(
  input: MikaCustomerHydrationInput,
  ctx: MikaRequestContext,
): Promise<MikaId | undefined> {
  if (ctx.customerId) return ctx.customerId;

  const sessionCustomerId = await ctx.session?.get<MikaId>("mika.customerId");
  if (!sessionCustomerId) return undefined;

  const customer = await input.repositories.account.findCustomerById(sessionCustomerId);
  return customer && customerIsCompatibleWithContext(customer, ctx) ? sessionCustomerId : undefined;
}

async function withEffectiveCustomer(
  input: MikaCustomerHydrationInput,
  ctx: MikaRequestContext,
): Promise<MikaRequestContext> {
  if (ctx.customerId) return ctx;
  const sessionCustomerId = await ctx.session?.get<MikaId>("mika.customerId");
  if (!sessionCustomerId) return ctx;

  const customer = await input.repositories.account.findCustomerById(sessionCustomerId);
  return customer && customerIsCompatibleWithContext(customer, ctx)
    ? { ...ctx, customerId: sessionCustomerId }
    : ctx;
}

export function withHydratedCustomerHandler<TArgs extends readonly unknown[], TResult>(
  input: MikaCustomerHydrationInput,
  handler: (ctx: MikaRequestContext, ...args: TArgs) => Promise<TResult>,
): (ctx: MikaRequestContext, ...args: TArgs) => Promise<TResult> {
  return async (ctx, ...args) => handler(await withEffectiveCustomer(input, ctx), ...args);
}

export function hydratedCheckoutOverrides(
  input: MikaCustomerHydrationInput,
  overrides: MikaApiOverrides["checkout"] | undefined,
): MikaApiOverrides["checkout"] | undefined {
  if (!overrides) return undefined;

  return {
    ...(overrides.start ? { start: withHydratedCustomerHandler(input, overrides.start) } : {}),
    ...(overrides.preview
      ? { preview: withHydratedCustomerHandler(input, overrides.preview) }
      : {}),
    ...(overrides.status ? { status: withHydratedCustomerHandler(input, overrides.status) } : {}),
    ...(overrides.cancel ? { cancel: withHydratedCustomerHandler(input, overrides.cancel) } : {}),
  };
}

export function hydratedCartOverrides(
  input: MikaCustomerHydrationInput,
  overrides: MikaApiOverrides["cart"] | undefined,
): MikaApiOverrides["cart"] | undefined {
  if (!overrides) return undefined;

  return {
    ...(overrides.get ? { get: withHydratedCustomerHandler(input, overrides.get) } : {}),
    ...(overrides.quote ? { quote: withHydratedCustomerHandler(input, overrides.quote) } : {}),
    ...(overrides.add ? { add: withHydratedCustomerHandler(input, overrides.add) } : {}),
    ...(overrides.update ? { update: withHydratedCustomerHandler(input, overrides.update) } : {}),
    ...(overrides.remove ? { remove: withHydratedCustomerHandler(input, overrides.remove) } : {}),
    ...(overrides.merge ? { merge: withHydratedCustomerHandler(input, overrides.merge) } : {}),
    ...(overrides.applyCoupon
      ? { applyCoupon: withHydratedCustomerHandler(input, overrides.applyCoupon) }
      : {}),
    ...(overrides.removeCoupon
      ? { removeCoupon: withHydratedCustomerHandler(input, overrides.removeCoupon) }
      : {}),
  };
}

export function hydratedWishlistOverrides(
  input: MikaCustomerHydrationInput,
  overrides: MikaApiOverrides["wishlist"] | undefined,
): MikaApiOverrides["wishlist"] | undefined {
  if (!overrides) return undefined;

  return {
    ...(overrides.get ? { get: withHydratedCustomerHandler(input, overrides.get) } : {}),
    ...(overrides.add ? { add: withHydratedCustomerHandler(input, overrides.add) } : {}),
    ...(overrides.remove ? { remove: withHydratedCustomerHandler(input, overrides.remove) } : {}),
    ...(overrides.moveToCart
      ? { moveToCart: withHydratedCustomerHandler(input, overrides.moveToCart) }
      : {}),
    ...(overrides.saveForLater
      ? { saveForLater: withHydratedCustomerHandler(input, overrides.saveForLater) }
      : {}),
    ...(overrides.merge ? { merge: withHydratedCustomerHandler(input, overrides.merge) } : {}),
  };
}
