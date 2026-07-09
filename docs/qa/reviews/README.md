# Per-commit QA reviews

Each file is a read-only review of the commit that closed the listed ROADMAP / follow-up checkmarks.

## First hygiene campaign (P0–P3)

| Review | Commit | Checkmarks |
| ------ | ------ | ---------- |
| [U01-9928369.md](./U01-9928369.md) | `9928369` | P0.4 CI `templates:check` |
| [U02-31c00b3.md](./U02-31c00b3.md) | `31c00b3` | P0.1 `/types` barrel |
| [U03-4fba413.md](./U03-4fba413.md) | `4fba413` | P0.2 `MikaApi` pin |
| [U04-91633c5.md](./U04-91633c5.md) | `91633c5` | P0.2 facade pin |
| [U05-fd9fb8b.md](./U05-fd9fb8b.md) | `fd9fb8b` | P0.2 `MikaActions` pin |
| [U06-f5277e5.md](./U06-f5277e5.md) | `f5277e5` | P0.3 client purity |
| [U07-fd6305b.md](./U07-fd6305b.md) | `fd6305b` | P0.4 three host faces |
| [U08-76e2ef4.md](./U08-76e2ef4.md) | `76e2ef4` | P1.3 admin operationKey test |
| [U09-U15-5bf9010.md](./U09-U15-5bf9010.md) | `5bf9010` | P1 peer/docs/server subpaths |
| [U16-U26-c614399.md](./U16-U26-c614399.md) | `c614399` | P2 ops split / errors / brands / declarationMap |
| [U17-U27-c4e57b6.md](./U17-U27-c4e57b6.md) | `c4e57b6` | P2 megafile splits + P3 template notes |
| [U28-2c03dcb.md](./U28-2c03dcb.md) | `2c03dcb` | P3 `./types/primitives` |

Follow-up commit applying review findings: `qa(review-followup)` (pins, peer honesty, ACP map, README structure).

U29 (z.infer + EmDash storage converters) shipped as `77b06bb` after reviews launched; not re-reviewed here.

## Follow-up campaign (F0–F4)

Live card list: [../ROADMAP-followup.md](../ROADMAP-followup.md).  
QA index: [../README.md](../README.md).

| Review | Commit | Card |
| ------ | ------ | ---- |
| [F0.1-fef5462.md](./F0.1-fef5462.md) | `fef5462` | F0.1 prepublish `templates:check` |
| [F0.2-b4fc9ae.md](./F0.2-b4fc9ae.md) | `b4fc9ae` | F0.2 emit additive error codes |
| [F0.3-F0.5-F2.3-pins.md](./F0.3-F0.5-F2.3-pins.md) | `babb83b` / `d912a6a` / `11b59ae` | F0.3–F0.5 + F2.3 pins |
| [F1.1-F1.3-brands.md](./F1.1-F1.3-brands.md) | `55dcbb5`–`e6718fd` | F1 brands wave + autofix |
| [F2-F4-maintainability-docs.md](./F2-F4-maintainability-docs.md) | `021c19c`–`8cdb2e2` | F2–F4 maintainability/docs + autofix |

**Note:** `/docs` may be gitignored in some clones; force-add reviews when the team wants them in git. New agents should start at [ROADMAP-followup.md](../ROADMAP-followup.md).
