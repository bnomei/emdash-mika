# QA reports

Architecture and external-API validation notes. Research/audit memos justify work.

| Doc | Role |
| --- | ---- |
| **[ROADMAP-followup.md](./ROADMAP-followup.md)** | **Next cleanup cards** (open work after P0–P3 hygiene) |
| **[ROADMAP.md](./ROADMAP.md)** | Parent checklist (historical + done marks) |
| **[EXECUTION.md](./EXECUTION.md)** | First-campaign unit log + review loop |
| [reviews/](./reviews/) | Per-commit reviews that fed several follow-up cards |
| [architecture-overhaul-verdict.md](./architecture-overhaul-verdict.md) | Go/no-go: full overhaul vs surface hygiene |
| [external-api-surface.md](./external-api-surface.md) | Package exports, types, MikaApi, drift |
| [astro-v7-emdash-fitness.md](./astro-v7-emdash-fitness.md) | Astro Actions + EmDash native plugin fitness |
| [tavily-validation-ts-astro-emdash.md](./tavily-validation-ts-astro-emdash.md) | External validation of TS, Astro 7, EmDash assumptions |
| [architecture-internal-vs-external-api.md](./architecture-internal-vs-external-api.md) | Domain vs adapters, agent projections, migration phases 0–6 |
| [typescript-internals-improvements.md](./typescript-internals-improvements.md) | TS config, brands, registry derivation, library polish |

**Headline (2026-07-09):** No full architectural overhaul. P0–P3 hygiene largely shipped on `review-fixes`.

**Start here for next cleanup:** open [ROADMAP-followup.md](./ROADMAP-followup.md) → Wave F0 cards first.  
**Excluded from follow-up by request:** `emdash()` template fixture; Later.1–2 agentic/protocol work.
