# Handoff — 2026-09-22 — Digest truth + activity telemetry + backlog (qrf/0ej/rch) + gc-47c

All work is on branch **`feat/digest-truth-telemetry-backlog-2026-09-22`** — **NOT pushed, NOT deployed** (per operator: no deploy this session). Full suite green: **tsc clean, 104 test files / 2836 tests pass**. One batched deploy remains for a future session.

## Commits (9, newest first)
| SHA | What |
|---|---|
| `8a27847` | adversarial-audit fixes (uninstall-prefix, activity denominator, hot-path, safe-label) |
| `a8fd2e1` | gc-8mi: JSON_LD_PRICE_CONFLICT live-path integration test + operator runbook |
| `932898b` | gc-0ej: copy-paste removal instructions per finding |
| `d01d752` | gc-rch: per-finding removal-safety labels |
| `60847a6` | telemetry: surface last-seen + page-visit activity in digest |
| `8ec5b23` | telemetry: capture last-seen + page_visit (backend: schema+migration+instrument+prune+redact) |
| `997b115` | digest-truth: exclude internal/test/app-review stores from digest metrics |
| `175ed34` | gc-qrf: ignore-filter scan-history finding count |
| `12be27e` | chore: read-only shop enumeration spike script |

## What shipped (by workstream)

### 1. Digest truth (install count 14→ real, dev-store MRR)
- **Root cause (enumerated against prod, read-only):** 15 Shop rows, ALL `uninstalledAt=null` (NOT a stale-uninstall problem). Inflation = internal/test/Shopify-review stores never excluded. `OPERATOR_EXCLUDE_SHOPS` env is UNSET in prod, so only the hardcoded default (`nw-dev-store-2`) was excluded.
- **Fix:** added prefix-pattern exclusion (`DEFAULT_EXCLUDE_PREFIXES="app-review-"`) alongside exact-domain, via a shared `isExcluded()` predicate used by `partitionShops`, `aggregateActivity`, and (after audit) `countUninstallEventsExcluding`. Widened `DEFAULT_EXCLUDE_SHOPS="nw-dev-store-2.myshopify.com,teststore22022.myshopify.com"`.
- **Reconciliation:** 15 rows − {nw-dev-store-2, teststore22022, 2×app-review-*} = 11. Minus `dahi5e-1d` (if internal) = **10 real installs**, matching operator's count.
- **`PLAN_AMOUNTS`/MRR math untouched.** `dahi5e-1d` deliberately NOT excluded — see decisions.

### 2. Activity telemetry (NEW — last login + pages visited, in digest)
- **`Shop.lastSeenAt DateTime?`** (durable "last login") — migration `20260922120000_add_shop_last_seen_at` (hand-authored; auto-applies on deploy via `railway.toml` preDeployCommand). Stamped in the `app/routes/app.tsx` loader (single auth choke point), freshness-gated 5 min, skips `/app/admin`, try/caught.
- **`page_visit` OpsEvent** (domain-keyed → existing redact reaches it; fire-and-forget after audit) with `metadata.path`. Windowed 24h/7d counts + per-page breakdown (`normalizeActivityPath` collapses `/app/scans/:id`).
- **Prune widened** (`pruneOpsEvents`): page_visit >14d (was heartbeat-only). Redact verified covered (domain key). Both GDPR obligations met.
- **Digest ACTIVITY section**: "Seen in 24h/7d: X of N", per-shop last-seen + visit counts, Top pages (7d). Honors the same exclusions.

### 3. Backlog
- **gc-qrf** — scan-history findingCount now ignore-filtered (`displayFindingCount`, zero-cost guard).
- **gc-rch** — RemovalSafety labels (4 safe-to-remove, 6 leave-alone, 23 verify-first; exhaustive over FindingType). Badge next to confidence badge.
- **gc-0ej** — `buildRemovalInstructions` (full snippet + file/line + howTo) + "Copy removal instructions" button. Clipboard-only.
- **gc-8mi** (was mislabeled GHOST_PRICE → is JSON_LD_PRICE_CONFLICT; title corrected) — live-path integration test added; **true dev-store proof remains manual** → `docs/runbooks/gc-8mi-verify-jsonld-price-conflict.md`.

## Adversarial audit (3 parallel reviewers) — found + FIXED (commit 8a27847)
- **CRITICAL:** `countUninstallEventsExcluding` ignored the `app-review-*` prefix → review-store uninstalls leaked into the uninstalls line. Fixed (now uses `isExcluded`).
- **WARNING:** ACTIVITY section re-queried active shops independently → same-email "10 vs 11 active" risk. Fixed (pinned to `get-shops`' `activeShopIds`).
- **WARNING:** `recordOpsEvent` was `await`ed on every page load's critical path. Fixed → `void` (fire-and-forget).
- **NIT:** `/app/admin` prefix→segment match. Fixed.
- **TEST:** vacuous page_visit redact test strengthened to bind the write contract.
- **TRUST:** `safe-to-remove` badge out-promised a signature-only detector (no installed-app cross-check). Label softened → **"Likely safe — confirm app removed"** (pending operator wording review).
- Clean: migration safety, prune correctness, MRR/PLAN_AMOUNTS untouched, regex anchoring, UTC window math, gc-qrf guard, gc-rch exhaustiveness, gc-0ej composition, gc-8mi non-vacuousness.

## ⚠️ DECISIONS NEEDED FROM OPERATOR (before/at deploy)
1. **gc-w7b (P1):** Is `dahi5e-1d.myshopify.com` a real customer or internal? If internal → add to `OPERATOR_EXCLUDE_SHOPS` (real=10, MRR=$0). If real → note it reconciled 2026-08-28, BEFORE the 2026-09-18 price change (Standard 29→9, Pro 49→29), so it may be a **legacy Pro $49 sub the digest under-reports as $29** (grandfathered subs are mis-valued; `PLAN_AMOUNTS` uses current prices only). Verify vs Partner Dashboard.
2. **gc-rch:** Review the full RemovalSafety mapping + finalize the softened "safe-to-remove" label wording.

## DEPLOY STEPS (future session, when approved)
1. Resolve gc-w7b; set Railway env `OPERATOR_EXCLUDE_SHOPS` to confirmed internal domains (nw-dev-store-2, teststore22022, +dahi5e-1d if internal). `app-review-*` auto-excluded by default prefix; the two known domains are also in the code default, so even an unset env is correct-ish — but set it explicitly.
2. Merge branch → `main`, **`git push main`** (Railway auto-deploy; migration applies via preDeployCommand). ONE push (batch).
3. Post-deploy: confirm next 7am America/Denver digest shows corrected install/plan/MRR + new ACTIVITY section; run `smoke.mjs`.

## Follow-up beads filed
- **gc-w7b** (P1 decision) — dahi5e-1d real-vs-internal (+ grandfathered pricing MRR gap).
- **gc-9ms** (P3 bug) — digest Billing-events line has NO store exclusion (same class as the uninstalls bug; pre-existing).
- **gc-4cv** (P3 feature) — durable `Shop.isInternal` flag to replace the env-var domain list.
- gc-qrf/rch/0ej annotated with commit SHAs; leave OPEN, close on deploy.

## Deferred / not fixed (low pri)
- `normalizeActivityPath` trailing-slash bucket (`/app/scans/` vs `/app/scans`) — cosmetic; `pathname` won't produce it in practice.
- gc-qrf: up to PAGE_SIZE `getFilteredFindingSummary` calls/load when a shop has ignores (matches existing `app._index` precedent).

## Read-only spike tool left in repo
`scripts/enumerate-shops.ts` — `npx tsx --env-file=.env scripts/enumerate-shops.ts` (NOTE: `.env` `DATABASE_URL` points at PROD; script is SELECT-only).
