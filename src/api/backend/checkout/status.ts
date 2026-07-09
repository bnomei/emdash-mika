/**
 * Checkout status lookup and document expiry.
 */
import type { CheckoutDocument } from "../../../types/documents";
import { createMikaId, type ISODateTime, type MikaId } from "../../../types/primitives";
import type { MikaRequestContext } from "../../context";
import type { CheckoutSessionDTO, CheckoutStatusInput, MikaApiResult } from "../../types";
import { invalidCheckout } from "../errors";
import { checkoutIsSettled, checkoutStatusIsTerminal } from "../../lifecycle";
import type { MikaBackendDependencies } from "../ports";
import { expireCheckoutReservations } from "../stock-lifecycle";
import { checkoutStatusAccessError } from "../tokens";
import {
  checkoutBindingError,
  checkoutDocumentResult,
  checkoutDocumentSuccessResult,
  checkoutIsExpired,
  checkoutStatusExpired,
  putCheckoutIfNotSettled,
} from "./helpers";

export async function checkoutStatus(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  statusInput: CheckoutStatusInput,
): Promise<MikaApiResult<CheckoutSessionDTO>> {
  const checkoutId = createMikaId(statusInput.checkoutId);
  const document = await input.repositories.session.findCheckoutById(checkoutId);
  if (!document) return invalidCheckout("checkoutId", checkoutId);

  const accessError = await checkoutStatusAccessError(input, ctx, document, statusInput.token);
  if (accessError) return accessError;

  const bindingError = checkoutBindingError(document);
  if (bindingError) return bindingError;

  if (checkoutIsExpired(input, document)) {
    const expired = await expireCheckoutDocument(input, document, ctx.now);
    // expireCheckoutDocument's CAS returns the *settled* document (not an expired one) when a payment
    // webhook completed the checkout in the race window — surface that real status via
    // checkoutDocumentResult (which replays a concurrently-failed settle) instead of a hard 409.
    return expired.status === "expired"
      ? checkoutStatusExpired(expired)
      : checkoutDocumentResult(expired);
  }

  return checkoutDocumentSuccessResult(document);
}

export async function expireCheckoutDocument(
  input: MikaBackendDependencies,
  document: CheckoutDocument,
  now: ISODateTime,
): Promise<CheckoutDocument> {
  if (checkoutIsSettled(document) || checkoutStatusIsTerminal(document.status)) {
    return document;
  }

  const reservationIds = document.aggregate.lines
    .map((line) => line.reservationId)
    .filter((id): id is MikaId => Boolean(id));
  if (reservationIds.length > 0) {
    await expireCheckoutReservations(input, reservationIds, now);
  }

  // No snapshot-status guard here: an already-"expired" snapshot returns at the terminal-status check
  // above, and a concurrent double-expire is handled idempotently by putCheckoutIfNotSettled's CAS
  // (whose allowedFromStatuses includes "expired", checked against the current *stored* status).
  const expired: CheckoutDocument = {
    ...document,
    status: "expired",
    providerStatus: "expired",
    updatedAt: now,
  };
  const stored = await putCheckoutIfNotSettled(input, expired, [
    "created",
    "redirected",
    "expired",
  ]);
  if (stored) return stored;

  // Settled concurrently (a payment webhook completed it) — return the current stored state.
  const settled = await input.repositories.session.findCheckoutById(document.id);
  return settled ?? document;
}
