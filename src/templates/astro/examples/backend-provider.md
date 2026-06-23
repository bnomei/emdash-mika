# Backend And Provider Wiring Example

Mika does not ship payment credentials or storage. A host project wires those
pieces and passes the resulting API to `mikaPlugin()`.

The first real provider path is Stripe because it covers hosted checkout,
subscriptions, portal sessions, invoices, refunds, signed webhooks, product and
price sync hooks, and the likely ACP delegated payment path. Keep fake/local
providers for tests and demos. Keep provider-specific SDK objects and secrets
outside Mika's core commerce types.

## Backend API

Create a host module such as `src/lib/mika-api.ts`:

```ts
import { createMikaBackendApi } from "@bnomei/emdash-mika/server";
import { createMikaProviderRegistry } from "@bnomei/emdash-mika/provider";
import { createCurrencyCode, createMikaId, createProviderName } from "@bnomei/emdash-mika/types";
import { repositories } from "./mika-repositories";
import { stripeProvider } from "./providers/stripe";

export const api = createMikaBackendApi({
  repositories,
  providers: createMikaProviderRegistry([stripeProvider]),
  defaults: {
    currency: createCurrencyCode("EUR"),
    provider: createProviderName("stripe"),
  },
  config: {
    checkout: {
      successUrl: "/checkout/success",
      cancelUrl: "/checkout/cancel",
    },
  },
  createId: (namespace) => createMikaId(`${namespace}_${crypto.randomUUID()}`),
  now: () => new Date(),
  hash: async (input) => {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  },
});
```

`repositories` is the host persistence adapter set. It implements Mika's
catalog, session, account, ledger, ops, stock, and ephemeral repository ports.
That keeps database choice and deployment ownership outside the package.

Register that API with the plugin:

```ts
import { defineConfig } from "astro/config";
import { emdash } from "emdash/astro";
import { mikaPlugin } from "@bnomei/emdash-mika";
import { api } from "./src/lib/mika-api";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [mikaPlugin({ api })],
    }),
  ],
});
```

`createMikaActions()` and `createMika(Astro)` use the same plugin API by
default after plugin registration.

## Fulfillment

When a provider webhook marks a payment order as paid, Mika fulfills each order
line according to the purchased price's `fulfillmentKind`:

- `entitlement` creates an active entitlement document.
- `download` adds a download ref to the order line.
- `license` creates an active license document with a hashed license key and a
  display suffix on the order line.

License fulfillment is automatic backend behavior, not a separate public
`license.generate` action. If the storefront must reveal full license keys to
customers, the host should own that delivery policy and storage boundary.

## Provider Adapter

Provider adapters translate Mika's provider contract into a real service such
as Stripe, Paddle, Lemon Squeezy, or a custom checkout backend. Mika ships an
optional Stripe adapter surface; other adapters should follow that shape after
Stripe proves the contract.

```ts
import Stripe from "stripe";
import { createMikaStripeProvider } from "@bnomei/emdash-mika/stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const stripeProvider = createMikaStripeProvider({
  stripe,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
});
```

The adapter accepts a Stripe-shaped client without making Stripe a required
dependency for every Mika install. Hosts that use the adapter should install
`stripe`, supply product/price provider refs on sellables/prices, and keep SDK
clients, secrets, webhook signing keys, retries, tax/shipping configuration,
and compliance rules in the host application.

## Maintenance

Mika registers the `mika_maintenance` cron task by default. The task drains the
email outbox, releases expired stock reservations, purges expired ephemeral
rows, and processes queued account-delete requests.

Configure it only when the default minute schedule is not right:

```ts
mikaPlugin({
  api,
  maintenance: {
    enabled: true,
    schedule: "*/5 * * * *",
  },
});
```

On Cloudflare, the host Worker's `scheduled()` handler should call EmDash
`runScheduledTasks()` so EmDash can run both scheduled publishing and Mika
maintenance.

## Production Checklist

- Repository methods are backed by durable storage and transactions where stock,
  checkout, orders, and webhooks require atomicity.
- Provider webhook verification uses the raw request body.
- Provider payment events are emitted only for settled paid states and carry
  `paymentStatus: "paid"`.
- Account order projections expose Mika `invoiceHref` links, not raw provider
  invoice URLs.
- Checkout success/cancel URLs are trusted deployment config or sanitized local
  return paths.
- Action guards or middleware enforce rate limits and account policy.
- Admin and trusted agent runner paths require idempotency keys where Mika marks
  them as required.
- Email delivery is connected to the host EmDash email provider or an explicit
  sender.
