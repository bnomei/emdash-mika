# Unstyled kit slice (no Kumo)

Copyable path for hosts that do **not** want Cloudflare Kumo / Phosphor peers.

## Intent

Mika templates under `components/` default to Kumo for a polished demo shell.
This note documents the minimal **unstyled** wiring so the product remains a
**kit**, not a locked theme.

## Minimal host files

1. **Backend** — `lib/mika-api.ts` with `createMikaBackendApi` (see `backend-provider.md`).
2. **Plugin** — `lib/mika-plugin.ts` exporting `createPlugin` for EmDash.
3. **Actions** — `actions/index.ts` with `createMikaActions({ api })`.
4. **Pages** — plain Astro forms posting to actions (no `MikaKumo*` imports).

Example product block without Kumo:

```astro
---
import { actions } from "astro:actions";
import { createMika } from "@bnomei/emdash-mika/astro";
import { api } from "../lib/mika-api";
const Mika = createMika(Astro, { api });
const sellables = await Mika.catalog.sellables("products", Astro.params.id ?? "");
---
{sellables.ok &&
  sellables.data.map((s) => (
    <form method="POST" action={actions.mika.cart.add}>
      <input type="hidden" name="sellableId" value={s.id} />
      <button type="submit">Add to cart</button>
    </form>
  ))}
```

## Peers

- **Required:** `astro` ^7, `emdash`
- **Not required** for this slice: `@cloudflare/kumo`, `@phosphor-icons/react`, `react`

## Related

- [astro-storefront.md](./astro-storefront.md) — full Kumo-oriented copy path
- [backend-provider.md](./backend-provider.md) — repositories and providers
