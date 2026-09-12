# Session Handoff: 2026-09-11 — MEDIUM hygiene batch shipped; wave 2 planned

## What Got Done

Shipped the MEDIUM-tier deep-dive remediation batch + two UI-honesty items to prod via **PR #23 (merge `a708f37`)**. One branch, one CI run (green), one deploy.

- **M3** — Node 20 (EOL) → Node 24 base image (`Dockerfile`, `.nvmrc`, `engines >=22.12`). NOTE: local dev machine is on Node v20.20.1 — run `nvm install 24` locally. This is the only change that truly validates on the Railway deploy.
- **M7 + M8** — deleted dead `APP_SUBSCRIPTIONS_UPDATE` route + its unit test; repointed `billing-flow.test.ts` from the dead route to the live path (`reconcileShopPlan` → `Shop.plan`), 2 cases.
- **M5** — `notifyFunctionFailure` dedups operator emails by `functionId` within a 60-min window (`getLatestOpsEvent`); always still records the OpsEvent.
- **M6** — `shop/redact` failure-path tested; `ops-event.server` mocked in both webhook tests (closes prod-write hazard).
- **Plans copy** — `app.settings.tsx` bullets reconciled to the official Shopify pricing page across all 3 tiers; every claim verified vs the plan matrix.
- **gc-l8o** — Theme Health tile now shows change-vs-last-scan delta (inverted colors; new `computeHealthDelta` helper in `health-score.ts`).

Gate: lint/format/typecheck green; **2441 tests pass** (down from 2446 due to dead-test deletion; +11 new).

## Key Decisions (2026-09-11)

- **Batch landed as its own deploy** (not accumulated with wave 2) — validates the Node 24 bump cleanly.
- **Wave 2 = E2-anchored.** E2 (false-positive suppression) is the anchor; **M2 is downgraded to a light copy/source fix** because app-level ignore in E2 IS the M2 solution.
- **E2 granularity: BOTH** per-finding (fingerprint) AND app/namespace-level.
- **E1: theme-editor deep-links first**, Admin-resource links as fast-follow.
- **H5 = its own pre-paid-GTM track** (not wave-2 hygiene). See below.

## H5 verdict (important — re-investigated)

H5's structural claim is **CONFIRMED**: `scopes.request` exists nowhere; `optional_scopes` can't be granted by real managed-install merchants. Nathan's Professional **dev store not returning PARTIAL is INCONCLUSIVE** — dev installs auto-grant optional scopes AND the resolver only probes (→ ACCESS_DENIED → PARTIAL) when candidates exist. **This partially inerts the SHIPPED Standard+ "Broken Links" feature (gc-m4h) for real paid merchants.** LATENT today (zero paid merchants = no harm), but a **must-fix before real paid GTM**. Fix = build the `shopify.scopes.request()` flow (bead **gc-1wf**), do NOT remove the scopes. Subsumes M16.

- Nathan confirmed: **no paid audits exist right now** (can't observe PARTIAL on a real merchant).
- M1 + M15 are **MOOT** (Sentry was removed last session) — don't re-file.

## Wave-2 Backlog (filed this session)

- **gc-gis** [P1 epic] E2 false-positive suppression — children:
  - **gc-bn7** [P1] E2.1 IgnoredFinding schema+model (per-finding fingerprint + app/namespace rule; reuse `fingerprintFinding` from scan-differ)
  - **gc-57t** [P1] E2.2 exclude ignored from counts/health-score/lanes/diffs + the gc-l8o delta (single choke point)
  - **gc-8qb** [P1] E2.3 ignore UI (row action + app-level + management view)
- **gc-aky** [P2 bug] M2 light fix (informational + "verify before removing"; suppression via E2) — related to gc-gis
- **gc-3on** [P1] E1 theme-editor deep-links (first cut) · **gc-7h9** [P2] E1-followup Admin-resource links
- **gc-lmh** [P2] M4 bump `@react-router/serve` (must ride a branch through CI+build+smoke)
- **gc-jpl** [P3] M9 remove dead test-only exports
- **gc-bbb** [P2 bug] L2 reset `planReconciledAt=null` on reactivate · **gc-cj6** [P2] L6 re-verify API version 2026-04 · **gc-7wj** [P3] L5 PLAN_AMOUNTS drift check · **gc-xbq** [P3] L17 add SHOPIFY_APP_URL to .env.example
- **gc-1wf** [P1, label pre-paid-gtm] H5 scopes.request flow

## Recommended Next-Session Sequence

1. **E2 epic (gc-gis)**: gc-bn7 → gc-57t → gc-8qb, then fold M2 (gc-aky) in.
2. **E1 (gc-3on)** — cheapest activation win, standalone.
3. Hygiene riders: L2 (gc-bbb), L6 (gc-cj6), then M4/M9/L5/L17.
4. **H5 (gc-1wf)** when a paid install is on the horizon.

## Still Open From Prior Handoff (NOT this session)

- **gc-1we** — H3 dead-man's-switch still **INERT** until the Railway cron service is wired (dashboard task): new service, start `node build/server/deadman-monitor.js`, cron `*/10 * * * *`, share `DATABASE_URL`+`RESEND_API_KEY`+`OPS_ALERT_EMAIL`; verify log `deadman-monitor: all crons healthy`. Railway config redeploys skip the GitHub smoke gate.

## Risks

- Node 24 bump only validates on the Railway deploy (CI doesn't run `npm run build`).
- E2.2 must catch EVERY aggregation path (counts/score/lanes/diffs/delta) or ignored findings leak into one — build a single choke point + a test that proves an ignore moves none of them.
