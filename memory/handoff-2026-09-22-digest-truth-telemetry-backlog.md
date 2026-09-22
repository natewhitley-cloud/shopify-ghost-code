# Handoff — 2026-09-22 — Digest truth + activity telemetry + backlog (qrf/0ej/rch) + gc-47c

All work is on branch **`feat/digest-truth-telemetry-backlog-2026-09-22`** — **NOT pushed, NOT deployed** (per operator: no deploy this session). Full suite green: **tsc clean, 104 test files / 2836 tests pass**. One batched deploy remains for a future session.

## Commits (11, newest first)
| SHA | What |
|---|---|
| `fbec0a6` | docs: this handoff |
| `75c55f3` | exclude dahi5e-1d (internal, 0 real Professionals per operator) — gc-w7b resolved |
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
- **Reconciliation:** 15 rows − {nw-dev-store-2, teststore22022, 2×app-review-*, dahi5e-1d} = **10 real installs, Professional=0, MRR=$0** (operator confirmed 2026-09-22: zero real Professional subs; dahi5e-1d is internal, a Professional TEST charge). All 3 internal domains + `app-review-*` prefix are in the CODE defaults (commit `75c55f3`), so the digest is correct even if `OPERATOR_EXCLUDE_SHOPS` is never set.
- **`PLAN_AMOUNTS`/MRR math untouched.**

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

## ⚠️ DECISIONS
1. **gc-w7b — RESOLVED 2026-09-22 (CLOSED):** operator confirmed **0 paid subscribers, MRR=$0, nobody on any legacy price**. Both nw-dev-store-2 and dahi5e-1d are internal (Professional TEST charges) → excluded in code default (commit `75c55f3`). No revenue-accuracy risk; do not re-raise grandfathered pricing.
   - **Install COUNT — RECONCILED 2026-09-22:** DB had 15 `uninstalledAt=null` rows vs Shopify's 10 active (incl dev). Mapped ALL 15 to Partner Dashboard history: 10 genuinely active + **5 missed-uninstall phantoms** (teststore22022 8-27, dahi5e-1d/APPT4 8-31, www-mantrasupplements/Mantra Men's Club **real merchant** 9-12, 2× app-review 9-15). Backfilled `uninstalledAt` via `scripts/backfill-missed-uninstalls-2026-09-22.ts` (commit on branch) → **active=10, digest Total active=9 real merchants** (dev excluded). NOTE: my exclusion approach mis-diagnosed root cause (it's missed webhooks, not "internal stores"); exclusion list KEPT as-is (protective for your test stores vs reinstall — `upsertShop` clears `uninstalledAt`). Root cause = missed `app/uninstalled` (historical; MELTBUY 9-18 processed OK). Follow-ups: **gc-dyt** (P2 periodic install reconciler), **gc-qkd** (P3 GDPR redact churned shops — data lingering, needs go-ahead).
2. **gc-rch — STILL OPEN:** review the full RemovalSafety mapping + finalize the softened "safe-to-remove" label wording ("Likely safe — confirm app removed").

## DEPLOY STEPS (future session, when approved)
1. (Optional) `OPERATOR_EXCLUDE_SHOPS` env — NOT required: all 3 internal domains (nw-dev-store-2, teststore22022, dahi5e-1d) are in the code `DEFAULT_EXCLUDE_SHOPS` and `app-review-*` in `DEFAULT_EXCLUDE_PREFIXES`, so an unset env is fully correct. Set the env only to add MORE stores without a code change.
2. Merge branch → `main`, **`git push main`** (Railway auto-deploy; migration applies via preDeployCommand). ONE push (batch).
3. Post-deploy: confirm next 7am America/Denver digest shows Total active=10, Professional=0, MRR=$0 + new ACTIVITY section; run `smoke.mjs`.

## Install-count root cause (investigated + partially fixed 2026-09-22)
DB had 15 `uninstalledAt=null` rows vs Shopify's 10 active. Diagnosis (prod read-only): **the `app/uninstalled` webhook is effectively NOT executing** — only 1 `shop_uninstalled` OpsEvent EVER (vs ~20 dashboard uninstalls since the handler shipped 8-29), all 5 phantoms still have intact Session rows (handler deletes sessions → it never ran), 0 logged app/uninstalled webhook_failures (deliveries not reaching handler). MELTBUY's 9-18 uninstall isn't even in the DB.
- **Done:** backfilled `uninstalledAt` on the 5 phantoms (`scripts/backfill-missed-uninstalls-2026-09-22.ts`) → active=10.
- **Done (gc-dyt, commits `ee95016` + FIX `c65ac1e`):** daily install-status reconciler (`inngest/functions/reconcile-installs.ts`, cron 6am Denver, heartbeat-covered). Probes each active shop via `unauthenticated.admin` + a cheap Admin GraphQL call. ⚠️ FIX c65ac1e: the app uses `expiringOfflineAccessTokens` — for an uninstalled shop with an EXPIRED token, `unauthenticated.admin` throws during token REFRESH (before the graphql probe), so the original "mark only on graphql-401" missed those. Now TWO definitive signals mark uninstalled: (a) graphql 401 (token not yet expired), (b) rejected refresh — `isRefreshTokenRejected` = `InvalidJwtError` or `HttpResponseError 400 invalid_subject_token`. Transient (500 wrapper/SessionNotFoundError/network) → skip, never false-churn. Shared `markShopUninstalledWithEvent` helper (webhook + reconciler, DRY, `source` in metadata).
- **c9v ROOT CAUSE FOUND + webhook DEPLOYED (config only):** the `app/uninstalled` webhook wasn't firing because webhooks are DECLARATIVE-ONLY (no `afterAuth`/`registerWebhooks`), registered ONLY by `shopify app deploy` — a MANUAL step NOT in the git-push/Railway deploy path. GDPR compliance webhooks worked (registered separately). Handler code is fine. Operator ran `nvm use 24 && npm run deploy` → config `ghostcode-10` LIVE, registering the subscription. **VERIFY:** baseline = 1 `shop_uninstalled` event ever (6w0by1-11, 8-31); watch for a NEW event (`source=webhook`) on next uninstall / `shopify app webhook trigger` / Partner Dashboard delivery health. **RUNBOOK GAP:** "run `shopify app deploy` after any webhook/toml change" — git push never registers webhooks. LEARNING: offline tokens EXPIRE (all active shops' tokens currently expired); raw-token Admin API calls 401 without refresh — use `unauthenticated.admin` (auto-refreshes) not raw tokens.
- **DEFERRED (gc-qkd):** GDPR hard-delete of the 5 churned shops. BLOCKED until deploy — `deleteShopData` uses the new `lastSeenAt` column via the regenerated client, which prod won't have until the branch's migration applies. Run post-deploy.
- **gc-c9v (P2):** ROOT CAUSE = declarative webhooks not registered (needs `shopify app deploy`). Config deployed 2026-09-22 (`ghostcode-10`); registration verification pending (see above). Keep open until a new `source=webhook` uninstall event confirms.

## ⚠️ Deploy-ordering note (schema skew)
The local Prisma client is now ahead of prod (`lastSeenAt` generated but not applied). Read-only scripts with explicit `select`s are fine; anything using the full Shop model (e.g. `deleteShopData`) FAILS against un-migrated prod. On real deploy this is a non-issue (migration runs first via preDeployCommand). Don't run local full-model writes against prod before deploy.

## Follow-up beads filed
- **gc-w7b** (P1 decision) — CLOSED 2026-09-22 (dahi5e-1d excluded; 0 real Professionals; 0 paid, MRR $0).
- **gc-dyt** (P2 feature) — install-status reconciler. DONE (commit `ee95016`), pending deploy.
- **gc-c9v** (P2 bug) — investigate app/uninstalled webhook not executing.
- **gc-qkd** (P3 bug) — GDPR redact the 5 churned shops. DEFERRED to post-deploy (schema skew).
- **gc-9ms** (P3 bug) — digest Billing-events line has NO store exclusion (same class as the uninstalls bug; pre-existing).
- **gc-4cv** (P3 feature) — durable `Shop.isInternal` flag to replace the env-var domain list.
- gc-qrf/rch/0ej annotated with commit SHAs; leave OPEN, close on deploy.

## Deferred / not fixed (low pri)
- `normalizeActivityPath` trailing-slash bucket (`/app/scans/` vs `/app/scans`) — cosmetic; `pathname` won't produce it in practice.
- gc-qrf: up to PAGE_SIZE `getFilteredFindingSummary` calls/load when a shop has ignores (matches existing `app._index` precedent).

## Read-only spike tool left in repo
`scripts/enumerate-shops.ts` — `npx tsx --env-file=.env scripts/enumerate-shops.ts` (NOTE: `.env` `DATABASE_URL` points at PROD; script is SELECT-only).
