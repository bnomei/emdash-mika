/**
 * Built-in transactional email templates rendered for the Mika email outbox (magic link,
 * order confirmation) with shared branding and plain-text plus HTML output.
 */
import type { ISODateTime, Money } from "./types/primitives";

/** Optional branding fields applied across built-in transactional email templates. */
export interface MikaEmailBrand {
  readonly siteName?: string;
  readonly fromName?: string;
  readonly supportEmail?: string;
}

/** Rendered email payload (subject, plain text, HTML) ready for the email outbox or sender. */
export interface MikaRenderedEmail {
  readonly template: MikaEmailTemplateKey;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Input for the magic-link template (sign-in, checkout resume, or account deletion confirm). */
export interface MikaMagicLinkEmailInput {
  readonly toEmail: string;
  readonly url: string;
  readonly purpose?: "sign_in" | "checkout" | "account_delete" | (string & {});
  readonly expiresAt?: ISODateTime;
  readonly brand?: MikaEmailBrand;
}

/** Single line item rendered in the order confirmation email template. */
export interface MikaOrderConfirmationLine {
  readonly title: string;
  readonly quantity: number;
  readonly total?: Money;
}

/** Input for the post-checkout order confirmation template. */
export interface MikaOrderConfirmationEmailInput {
  readonly toEmail: string;
  readonly orderNumber: string;
  readonly total?: Money;
  readonly lines?: readonly MikaOrderConfirmationLine[];
  readonly accountUrl?: string;
  readonly brand?: MikaEmailBrand;
}

interface MikaEmailTemplateDefinition<TInput> {
  readonly outboxKind: string;
  readonly render: (input: TInput) => MikaRenderedEmail;
}

/** Registry of built-in templates keyed by outbox kind with render functions. */
export const mikaEmailTemplates = {
  magic_link: {
    outboxKind: "magic_link",
    render: renderMikaMagicLinkEmail,
  },
  order_confirmation: {
    outboxKind: "order_confirmation",
    render: renderMikaOrderConfirmationEmail,
  },
} as const satisfies {
  readonly magic_link: MikaEmailTemplateDefinition<MikaMagicLinkEmailInput>;
  readonly order_confirmation: MikaEmailTemplateDefinition<MikaOrderConfirmationEmailInput>;
};

/** Union of built-in email template keys. */
export type MikaEmailTemplateKey = keyof typeof mikaEmailTemplates;

/** Input type inferred for a given email template key. */
export type MikaEmailInput<TTemplate extends MikaEmailTemplateKey> = Parameters<
  (typeof mikaEmailTemplates)[TTemplate]["render"]
>[0];

/** Renders the magic-link transactional email in plain text and HTML. */
export function renderMikaMagicLinkEmail(input: MikaMagicLinkEmailInput): MikaRenderedEmail {
  const siteName = input.brand?.siteName ?? "Mika";
  const purpose = input.purpose ?? "sign_in";
  const subject =
    purpose === "checkout"
      ? `Continue checkout on ${siteName}`
      : purpose === "account_delete"
        ? `Confirm account deletion on ${siteName}`
        : `Sign in to ${siteName}`;
  const expiry = input.expiresAt ? ` This link expires at ${input.expiresAt}.` : "";
  const intro =
    purpose === "checkout"
      ? `Use this link to continue your checkout on ${siteName}.`
      : purpose === "account_delete"
        ? `Use this link to confirm the account deletion request for ${siteName}.`
        : `Use this link to sign in to ${siteName}.`;
  const support = supportLine(input.brand);
  const text = `${intro}${expiry}\n\n${input.url}${support ? `\n\n${support}` : ""}`;
  const html = htmlDocument(
    subject,
    `<p>${escapeHtml(intro)}${expiry ? escapeHtml(expiry) : ""}</p>${button(input.url, "Continue")}${support ? `<p>${escapeHtml(support)}</p>` : ""}`,
  );

  return {
    template: "magic_link",
    subject,
    text,
    html,
  };
}

/** Renders the order-confirmation transactional email in plain text and HTML. */
export function renderMikaOrderConfirmationEmail(
  input: MikaOrderConfirmationEmailInput,
): MikaRenderedEmail {
  const siteName = input.brand?.siteName ?? "Mika";
  const subject = `Order ${input.orderNumber} confirmed`;
  const lines = input.lines ?? [];
  const lineText =
    lines.length > 0
      ? `\n\nItems:\n${lines
          .map(
            (line) =>
              `- ${line.quantity} x ${line.title}${line.total ? ` (${formatMoney(line.total)})` : ""}`,
          )
          .join("\n")}`
      : "";
  const total = input.total ? `\n\nTotal: ${formatMoney(input.total)}` : "";
  const account = input.accountUrl ? `\n\nView your account: ${input.accountUrl}` : "";
  const support = supportLine(input.brand);
  const text = `Thanks for your order from ${siteName}.\n\nOrder: ${input.orderNumber}${lineText}${total}${account}${support ? `\n\n${support}` : ""}`;
  const htmlLines =
    lines.length > 0
      ? `<ul>${lines
          .map(
            (line) =>
              `<li>${line.quantity} x ${escapeHtml(line.title)}${line.total ? ` (${escapeHtml(formatMoney(line.total))})` : ""}</li>`,
          )
          .join("")}</ul>`
      : "";
  const html = htmlDocument(
    subject,
    `<p>Thanks for your order from ${escapeHtml(siteName)}.</p><p><strong>Order:</strong> ${escapeHtml(input.orderNumber)}</p>${htmlLines}${input.total ? `<p><strong>Total:</strong> ${escapeHtml(formatMoney(input.total))}</p>` : ""}${input.accountUrl ? button(input.accountUrl, "View account") : ""}${support ? `<p>${escapeHtml(support)}</p>` : ""}`,
  );

  return {
    template: "order_confirmation",
    subject,
    text,
    html,
  };
}

/** Dispatches to the registered template renderer for a given template key. */
export function renderMikaEmail<TTemplate extends MikaEmailTemplateKey>(
  template: TTemplate,
  input: MikaEmailInput<TTemplate>,
): MikaRenderedEmail {
  const renderer = mikaEmailTemplates[template].render as (
    input: MikaEmailInput<TTemplate>,
  ) => MikaRenderedEmail;

  return renderer(input);
}

function supportLine(brand?: MikaEmailBrand): string {
  return brand?.supportEmail ? `Need help? Contact ${brand.supportEmail}.` : "";
}

function button(url: string, label: string): string {
  const escapedUrl = escapeHtml(url);
  return `<p><a href="${escapedUrl}">${escapeHtml(label)}</a></p><p><small>${escapedUrl}</small></p>`;
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function formatMoney(value: Money): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: value.currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return formatter.format(value.amount / 10 ** fractionDigits);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
