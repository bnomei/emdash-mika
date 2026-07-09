/**
 * Checkout cancellation.
 */
import type { CheckoutDocument } from "../../../types/documents";
import { createMikaId, type MikaId } from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import type { CheckoutCancelInput, CheckoutSessionDTO, MikaApiResult } from "../../types";
import { invalidCheckout } from "../errors";
import { checkoutIsSettled, checkoutStatusIsTerminal } from "../../lifecycle";
import type { MikaBackendDependencies } from "../ports";
import { reopenCartDocument } from "../quote";
import { expireCheckoutReservations } from "../stock-lifecycle";
import { checkoutCancelAccessError } from "../tokens";
import { checkoutDocumentSuccessResult, putCheckoutIfNotSettled } from "./helpers";

export async function cancelCheckout(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  cancelInput: CheckoutCancelInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const checkoutId = createMikaId(cancelInput.checkoutId);
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const accessError = await checkoutCancelAccessError(input, ctx, document, cancelInput.token);
  if (accessError) return accessError;

  if (checkoutIsSettled(document) || checkoutStatusIsTerminal(document.status)) {
    return checkoutDocumentSuccessResult(document);
  }

  const reservationIds = document.aggregate.lines
    .map((line) => line.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, ctx.now);
  }

  const current = await input.repositories.session.findCheckoutById(checkoutId);
  if (!current) return invalidCheckout("checkoutId", checkoutId);
  if (checkoutIsSettled(current) || checkoutStatusIsTerminal(current.status)) {
    return checkoutDocumentSuccessResult(current);
  }

  const cancelled: CheckoutDocument = {
    ...current,
    status: "cancelled",
    providerStatus: "cancelled",
    updatedAt: ctx.now,
  };
  const stored = await putCheckoutIfNotSettled(input, cancelled, ["created", "redirected"]);
  if (!stored) {
    // Settled concurrently (a payment webhook completed it) — return the settled checkout instead
    // of clobbering it with the cancel.
    const settled = await input.repositories.session.findCheckoutById(checkoutId);
    return settled
      ? checkoutDocumentSuccessResult(settled)
      : invalidCheckout("checkoutId", checkoutId);
  }

  const cartDocument = stored.cartId
    ? await input.repositories.session.findById(stored.cartId)
    : null;
  if (cartDocument && cartDocument.type === "cart" && cartDocument.status === "checkout_pending") {
    await input.repositories.session.put(reopenCartDocument(cartDocument, ctx.now));
  }

  return checkoutDocumentSuccessResult(stored);
}
