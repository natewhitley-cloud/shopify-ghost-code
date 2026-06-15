# Ghost Code — Top-10 Remediation Plan

**Date:** 2026-06-12
**Source:** [`code-review-2026-06-12.md`](./code-review-2026-06-12.md) — top-10 priorities
**Status:** approved approach, not yet implemented
**Branch:** `code-review-2026-06-12`

All ten decisions were made interactively (BIG CHANGE mode), each landing on the
"do it right" option over stopgaps. Common thread across the detector fixes: invert
from "flag anything I can't vouch for" to "flag only what we have positive evidence
is orphaned."

---

## Decisions (what we're doing)

| # | ID | Sev | Decision | Approach |
|---|----|-----|----------|----------|
| 1 | LOG-1 | critical | **1A** | Expand safe-variable allowlists to Shopify's free reference themes (Dawn/Sense/Refresh/Craft/Spotlight) + golden-file regression tests asserting zero findings |
| 2 | LOG-2 | high | **2A** | GHOST_PRICE flags only with orphan evidence (no active discount/price rule, or app-attributed leftover code) |
| 3 | LOG-3 | high | **3A** | Translations flagged only on positive orphan evidence (uninstalled-app signatures / disabled locales); drop dead installed-apps dependency |
| 4 | CMP-1 | high | **4A** | Contextual App Bridge `shopify.scopes.request()` per audit category + `scopes_update` tracking; keep all 5 features |
| 5 | LOG-4 | high | **5A** | Decouple status from persistence; mark COMPLETED only after all audits; add PARTIAL status; fix catch guard |
| 6 | TST-2 | high | **6A** | Mock at service boundaries so audits actually run; test persist/recount/idempotency/COMPLETED-guard; fix LOG-9 (separate ACCESS_DENIED from transient errors) |
| 7 | URL-1 | high | **7A** | Replace `client_id` with real app handle, source from config, verify in dev store (also kills duplicated literal URL-4) |
| 8 | SEC-1 | medium | **8A** | Remove dead `Shop.accessToken` + `getShopByDomain` + token-encryption module; rely on Railway at-rest encryption |
| 9 | OPS-1 | high | **9A** | Patch react-router chain (>7.14.1) + `npm audit fix`; gate on full test suite + typecheck + dev-store smoke test |
| 10 | OPS-2 | medium | **10A** | Enable + document Railway Postgres backups, write + practice restore runbook, remove dead `better-sqlite3` |

---

## Execution sequence

Ordered by urgency, dependency, and risk. Rationale per phase below.

### Phase 1 — Fast, high-value, low-risk wins
1. **OPS-1 / 9A** — patch dependencies first (urgent RCE; stabilizes the base everything else builds on). Test-gated.
2. **URL-1 / 7A** — fix the billing link (revenue path, tiny change). *Requires confirming the real app handle.*
3. **LOG-1 / 1A** — Dawn false-positive fix + golden tests (credibility; lives in the always-on core theme scan, independent of the pipeline work).
4. **OPS-2 / 10A (partial)** — remove dead `better-sqlite3` dep now (trivial). Backups/runbook tracked separately (infra action).

### Phase 2 — Test foundation + pipeline correctness
5. **TST-2 / 6A** — fix the test harness + LOG-9 scope error handling *first* in this phase, so subsequent pipeline changes are actually verifiable.
6. **LOG-4 / 5A** — decouple status, add PARTIAL, fix catch guard (now testable via 6A).

### Phase 3 — Detector correctness (before scopes go live)
7. **LOG-2 / 2A** — price orphan evidence.
8. **LOG-3 / 3A** — translation orphan evidence.
9. **SEC-1 / 8A** — remove dead encryption code + column-drop migration (independent cleanup; slots here).

### Phase 4 — Turn the features on
10. **CMP-1 / 4A** — contextual scope requests **last**, so enabling the optional scopes lights up a pipeline (5A) and detectors (2A/3A) that are already correct and tested.

> **Key dependency:** 4A (enable scopes) must come *after* 2A/3A (fix the detectors those scopes feed) and 5A/6A (fix + verify the pipeline). Turning scopes on first would light up known-buggy detectors in production.

---

## Actions that need you (not code)

- **7A:** confirm the real **app handle** from the Partner Dashboard (Partners → Apps → Ghost Code). The current literal is the `client_id`, which is wrong.
- **10A:** enable **Railway Postgres backups** in the Railway dashboard (I can guide via the Railway CLI and write the runbook, but can't click the console for you).
- **9A:** after the react-router bump, a **dev-store smoke test** is part of done — I'll prep it; you confirm it loads.

---

## Risk + test gates

- **9A (framework bump)** and **5A/6A (pipeline rewrite)** are the highest-regression-risk items. Each gates on `npx vitest run` + `npx tsc --noEmit` + dev-store verification before merge.
- **8A** and **5A** involve **Prisma migrations** (drop `Shop.accessToken`; add PARTIAL status). Both must be reversible or carry a documented manual rollback (per definition-of-done).
- Detector changes (1A/2A/3A) each ship with the regression test that would have caught the original false positive.

---

## Out of scope (deferred from top-10, noted for later)

- **9C** (Dependabot/Renovate) — recommended fast-follow after 9A to prevent vuln re-accumulation.
- **LOG-9** is folded into **6A**.
- **URL-4** (duplicated `client_id` literal) is folded into **7A**.
- The remaining 53 findings (mediums/lows) from the full review remain in `code-review-2026-06-12.md`.
