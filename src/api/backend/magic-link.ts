/**
 * Passwordless sign-in via magic link: requesting a link (minting a token, queuing the default
 * email), and verifying it (consuming the token, hydrating or creating the session identity).
 */
import { renderMikaEmail } from "../../email";
import type { MikaRequestContext } from "../context";
import { emitMikaNotification, type MikaNotificationIntent } from "../notifications";
import type { AccountDTO, MikaApiResult } from "../types";
import { accountDTOForCustomer } from "./account";
import { authRequired, observeBackendError, tokenResult } from "./errors";
import type { MikaBackendDependencies } from "./ports";
import { addMilliseconds, emailHashKey, safeRequestReturnPath, stringChild } from "./shared";
import { hashMagicLinkToken, magicLinkTokenError } from "./tokens";

/** Reports a swallowed best-effort failure to the host observer; never throws. */
export async function requestMagicLink(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  requestInput: { readonly email: string; readonly returnTo?: string },
): Promise<MikaApiResult<{ sent: boolean }>> {
  const email = requestInput.email.trim();
  const emailHash = await input.hash(emailHashKey(email));
  const token = input.createId("magic_link_token");
  const tokenHash = await hashMagicLinkToken(input, token);
  const tokenId = token;
  const now = ctx.now;
  const expiresAt = addMilliseconds(now, input.config?.magicLink?.ttlMs ?? 15 * 60_000);
  const customer = await input.repositories.account.findCustomerByEmailHash(emailHash);
  const safeReturnTo =
    requestInput.returnTo === undefined
      ? undefined
      : safeRequestReturnPath(ctx, requestInput.returnTo);

  await input.repositories.ephemeral.put({
    key: tokenHash,
    kind: "token",
    subjectHash: emailHash,
    status: "pending",
    count: 0,
    expiresAt,
    version: 1,
    createdAt: now,
    updatedAt: now,
    data: {
      purpose: "magic_link",
      tokenId,
      email,
      emailHash,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
    },
  });

  const link = magicLinkUrl(input, ctx, token, safeReturnTo);
  const intent: MikaNotificationIntent<"magic_link.requested"> = {
    kind: "magic_link.requested",
    occurredAt: now,
    context: {
      toEmail: email,
      emailHash,
      ...(customer?.customerId ? { customerId: customer.customerId } : {}),
      ...(customer?.userId ? { userId: customer.userId } : {}),
      link,
      purpose: "sign_in",
      expiresAt,
      ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
      tokenId,
    },
  };

  await emitMikaNotification(
    input.notifications?.handle,
    intent,
    () => queueDefaultMagicLinkRequestedEmail(input, intent, tokenHash),
    (error) => observeBackendError(input, "notification.hook.magic_link.requested", error),
  );

  return { ok: true, status: 200, data: { sent: true } };
}

export async function queueDefaultMagicLinkRequestedEmail(
  input: MikaBackendDependencies,
  intent: MikaNotificationIntent<"magic_link.requested">,
  tokenHash: string,
): Promise<void> {
  const { context } = intent;
  const now = intent.occurredAt;
  const rendered = renderMikaEmail("magic_link", {
    toEmail: context.toEmail,
    url: context.link,
    purpose: context.purpose,
    expiresAt: context.expiresAt,
  });
  const emailId = input.createId("email");
  const emailRecord = {
    id: emailId,
    customerId: context.customerId,
    tokenId: context.tokenId,
    kind: "magic_link" as const,
    toEmail: context.toEmail,
    subject: rendered.subject,
    status: "queued" as const,
    idempotencyKey: `magic-link:${tokenHash}`,
    templateKey: rendered.template,
    templateVersion: "1",
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: now,
    createdAt: now,
    metadata: {
      purpose: context.purpose,
      expiresAt: context.expiresAt,
      link: context.link,
      ...(context.emailHash ? { emailHash: context.emailHash } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.returnTo ? { returnTo: context.returnTo } : {}),
    },
  };

  await input.repositories.ops.put({
    id: emailId,
    type: "email",
    schemaVersion: 1,
    status: emailRecord.status,
    nextAttemptAt: emailRecord.nextAttemptAt,
    tokenId: emailRecord.tokenId,
    kind: emailRecord.kind,
    record: emailRecord,
    createdAt: now,
    updatedAt: now,
  });
}

export async function verifyMagicLink(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  verifyInput: { readonly token: string; readonly returnTo?: string },
): Promise<MikaApiResult<AccountDTO>> {
  if (!ctx.session) {
    return authRequired("Magic link verification requires a writable session.");
  }

  const tokenHash = await hashMagicLinkToken(input, verifyInput.token.trim());
  const record = await input.repositories.ephemeral.get(tokenHash);
  const tokenError = magicLinkTokenError(record, ctx.now);
  if (tokenError) return tokenError;

  const consumed = await input.repositories.ephemeral.consumeToken(tokenHash, ctx.now);
  if (!consumed) {
    const current = await input.repositories.ephemeral.get(tokenHash);
    return (
      magicLinkTokenError(current, ctx.now) ??
      tokenResult("TOKEN_INVALID", "Magic link token is invalid.")
    );
  }

  try {
    const customer = record?.subjectHash
      ? await input.repositories.account.findCustomerByEmailHash(record.subjectHash)
      : null;
    if (customer) {
      const data = await accountDTOForCustomer(input, ctx, customer);
      await ctx.session.regenerate?.();
      await clearSessionKeys(ctx.session, ["mika.emailHash", "mika.userId"]);
      await ctx.session.set("mika.customerId", customer.customerId);
      if (customer.userId) await ctx.session.set("mika.userId", customer.userId);

      return { ok: true, status: 200, data };
    }

    const email = record?.data ? stringChild(record.data, "email") : undefined;
    if (record?.subjectHash) {
      await ctx.session.regenerate?.();
      await clearSessionKeys(ctx.session, ["mika.customerId", "mika.userId"]);
      await ctx.session.set("mika.emailHash", record.subjectHash);
    }

    return {
      ok: true,
      status: 200,
      data: {
        customer: email ? { email } : undefined,
        orders: [],
        subscriptions: [],
        entitlements: [],
        downloads: [],
      },
    };
  } catch (error) {
    await input.repositories.ephemeral
      .restoreToken(tokenHash, ctx.now)
      .catch((restoreError: unknown) =>
        observeBackendError(input, "magicLink.restoreToken", restoreError),
      );
    throw error;
  }
}

async function clearSessionKeys(
  session: NonNullable<MikaRequestContext["session"]>,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    if (session.delete) {
      await session.delete(key);
    } else {
      await session.set<undefined>(key, undefined);
    }
  }
}

const DEFAULT_MAGIC_LINK_VERIFY_PATH = "/account/magic-link";

export function magicLinkUrl(
  input: MikaBackendDependencies,
  ctx: MikaRequestContext,
  token: string,
  returnTo?: string,
): string {
  const verifyPath = input.config?.magicLink?.verifyPath ?? DEFAULT_MAGIC_LINK_VERIFY_PATH;
  const search = new URLSearchParams({ token });
  if (returnTo) search.set("returnTo", returnTo);
  const target = `${verifyPath}?${search.toString()}`;

  return ctx.url?.origin ? new URL(target, ctx.url.origin).toString() : target;
}
