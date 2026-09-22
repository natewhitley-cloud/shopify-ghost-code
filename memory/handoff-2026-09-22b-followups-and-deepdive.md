# Handoff — 2026-09-22 (session B) — Follow-ups branch + NEXT: deep-dive review

Continues `handoff-2026-09-22-digest-truth-telemetry-backlog.md` (the DEPLOYED big batch). This note covers the un-deployed follow-ups branch and sets up the next session.

## State of the world
- **DEPLOYED to prod (main @ `2d12d97`+):** digest truth, activity telemetry, gc-qrf/rch/0ej/8mi, gc-dyt (install reconciler v1), idempotent uninstall marking, webhook config `ghostcode-10` (registered app/uninstalled). Migration `lastSeenAt` applied; Inngest synced. See the other handoff for the monitoring watch-list (tomorrow's 6am reconciler + 7am digest).
- **gc-qkd DONE (prod data op):** the 5 missed-uninstall phantom shops were live-gated-redacted (probed each via raw refresh; deleted only Shopify-confirmed-gone). DB now 10 rows = 10 real installs (nw-dev-store-2 dev + 9 merchants). 0 real Professional, MRR $0. No customer impacted.
- **NOT deployed — branch `feat/digest-followups-9ms-4cv-2026-09-22`** (5 commits, 2912 tests green, tsc clean, ALL adversarially audited):
  - `c9dccaf` **gc-9ms** — billing-events digest line honors store exclusion; extracted shared client-safe `app/lib/store-exclusion.ts`.
  - `9318b44` **gc-4cv** — durable `Shop.isInternal` flag (migration `20260922130000`, backfills nw-dev-store-2) as primary exclusion signal; wired through partitionShops/aggregateActivity/getBillingEventStats; env list + `app-review-` prefix kept as override/ephemeral.
  - `2881f87` + `3b3004e` + `48ba7ea` **gc-5ha** — reconciler now catches the real expired-token uninstall (401 `requires an active refresh_token` / 404), which gc-dyt v1 missed. Body-aware classification (never churns on our own `invalid_client` credential error) + run-level circuit breaker (trips on all-churn N>=3 or >=50%). Rotation-safe (stores rotated session on 200). **2 adversarial audits + hardening** (1st caught a CRITICAL mass-churn hole; 2nd caught a small-N breaker gap; both fixed).

## To deploy the follow-ups branch (future session)
Merge → `git push origin main`. The `isInternal` migration auto-applies via `railway.toml` preDeployCommand (after the already-applied `lastSeenAt`). Then `curl -X PUT https://app.alpenglowsoftware.com/api/inngest` to re-sync Inngest (reconcile-installs changed). No new env vars needed.

## ⭐ NEXT SESSION: deep-dive review (`/deep-dive-review`)
Do this in a FRESH session — the orchestrator owns verify+synthesis (context-heavy), and this session is long. Suggested targets, priority order:
1. **The DEPLOYED main batch** (live, highest stakes) — telemetry hot-path writes, digest exclusion math, gc-dyt reconciler (now superseded by gc-5ha on the branch — note the reconciler on prod is v1 which MISSES expired-token uninstalls; gc-5ha branch fixes that).
2. **The follow-ups branch** (gc-9ms/4cv/5ha) before it ships — reconciler safety is the hot spot (it writes rotated tokens + can churn merchants; already 2× audited but a fresh security/logic pass is worth it).
Focus areas that saw the most churn/risk this session: **uninstall detection + token handling** (reconcile-installs.ts), **store exclusion** (store-exclusion.ts + 3 call sites), **telemetry GDPR** (page_visit redact/prune), **webhook registration** (declarative-only — see gc-c9v).

## Open beads
- **gc-c9v (P2)** — verify the app/uninstalled webhook fix on the next real uninstall (baseline: 1 `shop_uninstalled` event ever; watch for `source=webhook`). ROOT CAUSE was declarative-only webhooks needing `shopify app deploy` (done: `ghostcode-10`).
- **gc-dyt (P2)** — deployed v1; superseded by gc-5ha (branch). Verify tomorrow's 6am run (`reconcile_summary`: marked should be ~0). Once gc-5ha ships, gc-dyt is fully addressed.
- **gc-5ha (P2)** — DONE on branch (reconciler hardening), awaiting deploy.
- **gc-9ms / gc-4cv (P3)** — DONE on branch, awaiting deploy.
- **gc-rch (P3)** — operator to review the removal-safety mapping + softened "Likely safe — confirm app removed" label wording.
- **gc-8mi (P3)** — manual dev-store live-proof of JSON_LD_PRICE_CONFLICT (`docs/runbooks/gc-8mi-verify-jsonld-price-conflict.md`).

## Durable learnings this session (in memory)
- GhostCode webhooks are DECLARATIVE-ONLY → need `shopify app deploy` to register (git push doesn't). [[ghost-code-digest-truth-and-pricing-grandfathering]]
- Offline tokens EXPIRE + ROTATE (`expiringOfflineAccessTokens`); use `unauthenticated.admin` (auto-refresh+store), never raw stored tokens; a raw refresh probe must STORE the rotated session or it corrupts an installed shop.
- `uninstalledAt=null` ≠ installed — reconcile against the Partner Dashboard / a live refresh probe.
- NOBODY PAYS: 0 paid subs, MRR $0 (don't re-raise grandfathered pricing).
