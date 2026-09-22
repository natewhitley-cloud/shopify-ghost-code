# Deep-Dive Review — Ghost Code — 2026-09-22

**Scope:** Deployed `main` batch (digest truth, activity telemetry, install reconciler v1, webhook registration fix, gc-qrf/rch/0ej/8mi, gc-qkd redaction) + follow-ups branch `feat/digest-followups-9ms-4cv-2026-09-22` (gc-9ms billing-events exclusion + shared `store-exclusion.ts`, gc-4cv durable `Shop.isInternal` + migration, gc-5ha reconciler uninstall-shape hardening).

**Reviewers:** 11 category agents (security, Shopify compliance, logic/bugs, quality/perf, dead code, dependency audit, observability, accessibility, testing gaps, bad/hardcoded URLs, feature enhancements). Orchestrator verified the top findings against current code.

**Bottom line:** No CRITICAL findings. Zero externally-exploitable vulnerabilities. The follow-ups branch code (gc-9ms/4cv/5ha exclusion + isInternal) is clean and safe to ship. **However, the reconciler — which is live on prod — has one HIGH correctness bug that directly contradicts the gc-5ha handoff's "small-N breaker gap closed" claim**, plus a GDPR-completeness residual. Both are in already-deployed code, so they are fix-forward items, not deploy blockers for the follow-ups branch. Three HIGH *operational-readiness* gaps (observability) are also worth closing before relying on the system to catch an incident unattended.

---

## Force-Ranked Findings

### 🔴 HIGH

**1. Reconciler circuit breaker cannot trip at N=1 or N=2 active shops — mass-churn of the entire live base**
`inngest/functions/reconcile-installs.ts:544-547` · *VERIFIED against code · flagged independently by security, logic, and testing agents (testing rated HIGH)*
`churnThreshold = max(CB_MIN_MARKS=3, ceil(0.5·checked))`; `tripped = (checked>=3 && wouldMark===checked) || wouldMark>=churnThreshold`. At `checked=2, wouldMark=2` (100% churn — e.g. a rotated/wrong `SHOPIFY_API_SECRET` 401-ing every shop): clause 1 is false (`checked<3`), clause 2 is false (`2>=3` false) → **breaker does not trip, both shops marked uninstalled, no page, no abort.** The line-542 code comment claims "the all-probed-marked rule ensures a 100%-churn always trips even at a small base" — the code contradicts it at N=1,2.
**Contradicts the gc-5ha handoff**, which stated the "small-N breaker gap" was closed. gc-5ha fixed the N≥3 bypass (old MAX-with-cap form) but left N=1,2 unprotected. This app currently runs ~10 installs and every Shopify app *starts* at N=1 — exactly when an early-rollout misconfig is most likely and "churn all of them" is total.
**Fix:** change the all-marked clause to `checked >= 1 && wouldMark.length === checked` (trip on 100% churn at any base size), keeping the fractional/floor logic for larger N untouched. Add tests at N=1 and N=2 asserting a 100%-marked run trips. Effort: ~15 min + tests. Risk: near-zero (only makes the breaker *more* conservative).

**2. External dead-man's-switch is built and compiled but never scheduled — total-Inngest-outage blind spot**
`app/services/deadman-monitor.ts`, `package.json:7` (`build:deadman`) · *observability · known open bead gc-1we*
The internal stale-cron check runs *inside* an Inngest cron, so if Inngest itself goes dark (signing-key drift — a documented prior incident), nothing catches it. `deadman-monitor.ts` exists precisely to close this as an external Railway cron, compiles at every deploy, but no Railway cron service / GitHub Action / trigger invokes it (shipped "LIVE-INERT" 2026-09-11).
**Fix:** create the Railway cron service (`node build/server/deadman-monitor.js`, ~every 10m, sharing `DATABASE_URL`/`RESEND_API_KEY`/`OPS_ALERT_EMAIL`). Ops task, no code change — code has been ready and tested since 2026-09-11.

**3. Alert channel validity is never checked — a bad/rotated Resend key silently kills all paging**
`app/services/ops-alert.server.ts:56-64` (`getOpsAlertConfigStatus`) · *observability*
The self-check only verifies the env vars are *set*, not that the key authenticates. A present-but-wrong key makes every `sendOpsAlert` return `http_error`/`exception` — logged only, never re-alerted. The digest's own "alerting self-check" banner rides the same possibly-broken channel. Per memory, `RESEND_API_KEY`/`OPS_ALERT_EMAIL` are **shared with a sibling app**, so a rotation there silently breaks Ghost Code's paging.
**Fix:** have the self-check issue a lightweight authenticated Resend call (e.g. `GET /domains`), and/or write a structured `alert_send_failure` OpsEvent so `/health/deep` or the DB-backed digest section surfaces repeated failures even when email transport is dead.

**4. Unhandled loader/action/render errors are not durable, not counted, and never page**
`app/entry.server.tsx:63-66` (`handleError`), `:42-44` (`onError`) · *observability*
Since the Sentry removal (2026-09-11) both hooks only `console.error`. Route errors never become an OpsEvent, so they're invisible to the digest's failure counts and never trip an alert — a loader crash-loop is pure Railway-stdout log spam. The webhook/Inngest paths *do* record failures (`recordWebhookFailure`/`notifyFunctionFailure`); route errors have no equivalent wrapper.
**Fix:** wrap `handleError`/`onError` to also call `recordApiError` (or a new `route_error` OpsEvent type). Low effort — the pattern already exists twice.

### 🟡 MEDIUM

**5. `reconcile_aborted` OpsEvent leaks raw shop domains into a field `shop/redact` can't reach**
`inngest/functions/reconcile-installs.ts:556` vs `app/models/shop.server.ts:346-355` · *VERIFIED · compliance #1 + observability #5*
On a breaker trip the row embeds the full affected-domain list in the free-text `message` (`Domains: ${wouldMark.join(", ")}`); `metadata` is counts-only. `deleteShopData` matches OpsEvents on `key` / `metadata.shop` / `metadata.shopDomain` / `metadata.shopId` — none match a domain that lives only in `message`. The code comment claims parity with `function_failure`, but that type *also* writes structured `metadata.shop` (redactable); this one doesn't. The domains named here are precisely the shops about to be marked uninstalled — the population most likely to later request redaction. This is the "every table" completeness miss App Store review checks for.
**Fix (cheapest):** stop interpolating domains into `message` — log the domain list only to the paged ops alert (not a GDPR-scoped store) and keep the durable row counts-only, like `reconcile_summary` already is. Also correct the misleading comment.

**6. No total-theme-size ceiling before the worker pool — structural OOM risk**
`app/services/scan-engine.server.ts:3305` (per-file only), `theme-fetcher.server.ts:56-68` (unbounded pagination), `scan-pool.server.ts:161` · *quality #1 · speculative impact*
`MAX_SCANNABLE_FILE_BYTES` caps a single file but nothing caps total file count / aggregate bytes before the whole `files` array is serialized into a Piscina worker. A theme with thousands of sub-1MB assets could hold hundreds of MB in the main thread and again in the worker → container OOM, not just a worker failure. Not observed at 10 installs; structural.
**Fix:** add a total-bytes-or-file-count guard with the same "skip + record" pattern already used for oversized single files. One constant + early skip — do not build streaming/adaptive scanning.

**7. `getBillingEventStats` fails *open* on null shop + carries a dead second aggregation path**
`app/models/billing-event.server.ts:91,100-112` · *logic #2 + testing #3 + dead-code #2*
`if (row.shop && isExcludedShop(...)) continue;` — a null `row.shop` is *not* skipped and falls through to being **counted** (fail-open; should fail-closed/exclude on missing shop). Unreachable today (`shopId` is a required cascade FK) but inverts the safe default. Separately, the `groupBy` fallback branch (no-`opts` path) is never exercised in prod — the only caller always passes `opts` — so it's a dead maintenance trap with two divergent aggregation implementations.
**Fix:** make `opts` required (deletes the dead branch + its test), and add a `shop: null` test pinning intended behavior. Aligns with your DRY preference.

**8. Operator-digest handler has no end-to-end orchestration test — exclusion wiring across 5+ steps unverified**
`inngest/functions/operator-digest.ts:788-952` · *testing #2 (MED-HIGH)*
`partitionShops`/`aggregateActivity`/`getBillingEventStats` are thoroughly unit-tested in isolation, but the handler that must thread the *same* `excludeSet`/`excludePrefixes` into every `step.run` has only a `toBeDefined()` smoke check. A future edit that forgets to pass exclusion into one new step (or swaps the two type-compatible `Set<string>` args) passes every existing test and silently leaks a dev/`app-review-*` store back into the digest — the exact bug class the gc-qkd/gc-4cv/gc-9ms work was created to prevent.
**Fix:** one handler-level test mirroring `reconcile-installs.test.ts`'s `getInngestHandler` pattern, asserting excluded rows are absent from the final digest end-to-end.

**9. `.graphqlrc.ts` codegen pinned to `October25` while runtime is `July26`**
`.graphqlrc.ts:11` vs `app/shopify.server.ts:28` + `shopify.app.toml:12` · *VERIFIED · bad-URLs #1*
Codegen validates queries against a schema one version ahead of the live API — the exact drift class `gc-2tq` fixed before. A field valid in October25 but not July26 would generate clean types and fail at runtime.
**Fix:** align to `ApiVersion.July26` (or export one shared constant). 5-minute change.

**10. Express / body-parser / qs / morgan run in production (moderate advisories, non-breaking fix)**
`@react-router/serve` → prod server (Dockerfile CMD) · *dependency audit*
The **only** advisories in the 45-item `npm audit` that touch untrusted internet-facing input in prod. All moderate, all `fixAvailable: true` non-breaking. The other 35 "high" are dev/build/codegen tooling or verified-dead transitive branches (`@opentelemetry/*` is unreachable in the current Inngest config; `@shopify/shopify-app-session-storage-prisma`'s "high" is an inherited rollup, not a runtime bug — do **not** apply npm's suggested major downgrade). Note: `npm audit fix` currently throws `Cannot read properties of null (reading 'edgesOut')` on this lockfile — regenerate the lockfile in a branch before bulk fixes.
**Fix:** `npm update express body-parser qs morgan` within the `@react-router/serve` subtree; verify `npm run build` + tests green.

### 🟢 LOW / cleanup

**11.** Reconciler raw-refresh POST (`reconcile-installs.ts:315`) interpolates DB `domain` into an OAuth URL carrying `client_secret` with no `*.myshopify.com` assertion — defense-in-depth only (trust chain into `Shop.domain` is fully closed by the Shopify SDK today), but cheap insurance given it's a secret-bearing POST. *(security #2, bad-URLs #2)*
**12.** Health-check token compared with `!==` — use `crypto.timingSafeEqual`. Read-only ops endpoint, no PII; hardening only. `health.deep.tsx:54` *(security #1)*
**13.** Dead code: `readNumberValue` / `readChecked` in `app/components/polaris-events.ts:45,54` — zero callers (ported from ClearSignal, never wired). Delete. *(dead-code #1)*
**14.** Stale schema comment: `prisma/schema.prisma:415` calls `worker_fallback` "reserved," but it's live (`scan-pool.server.ts` escalation + digest count). Fix comment. *(dead-code #4)*
**15.** `reconcile_summary` OpsEvent is written daily, read nowhere — a sustained high `skipped` count (rate-limiting early-warning) is invisible. Add checked/marked/skipped to the digest. *(observability #4)*
**16.** `monitor-scan-failures` CRITICAL (>25% failure rate) is `logger.error`-only — no OpsEvent, no page. Inconsistent with every other monitor. Record + page on sustained CRITICAL. *(observability #7)*
**17.** `getStaleCrons` never flags a cron with zero heartbeats (cold-start safety), so a *misregistered* cron (id typo, failed Inngest sync) is permanently invisible. Add a one-time post-deploy check that every `CRON_HEARTBEAT_EXPECTATIONS` key has ≥1 heartbeat within 48h. *(observability #6)*
**18.** Accessibility: `HealthScoreTrendChart.tsx:143` SVG has a static `role="img"` label that flattens all per-bar `aria-label`s out of the tree — SR users get no data. Build the label from data or add a visually-hidden summary table. Also `app.scans.$scanId.tsx:905` `suggestedAppName` input has no accessible name (add `aria-label`, matching the sibling reason field). *(accessibility #1,#2)*
**19.** `getDomainsForScan` (`scan-domain.server.ts:55`) — `ScanDomain` rows are written every scan but never read through this function (intended future flywheel). Leave or delete; awareness only. *(dead-code #3)*

---

## Feature Enhancements (N/A — opportunities, not defects)

All grounded in existing code; not verified defects. Standouts for a 10-install / $0-MRR app where activation is the core problem:

1. **Merchant re-engagement email** from existing `lastSeenAt`/`page_visit` telemetry (currently operator-only) — reuse the Resend transport, target dormant installs. *High.*
2. **Activation-funnel instrumentation** (installs → first scan → repeat scan) via an OpsEvent on first-scan-completed + a digest line — tells you whether $0 MRR is an activation vs. pricing problem. *High.*
3. **Upgrade prompt at the moment of value:** theme-publish webhook silently records the timestamp for non-Pro shops — surface "your theme just changed; Professional would've rescanned automatically" where the nudge already renders. *High.*
4. Free-tier trend teaser (aggregate resolved-count only), quota "1 scan left" soft-warning, review-prompt keyed on *resolved* findings, monthly merchant health digest. *Medium/Low.*

---

## Recommended Sequencing

**Before deploying the follow-ups branch** (the branch code itself is clean):
- Nothing strictly blocks the merge. The follow-ups branch (gc-9ms/4cv/5ha exclusion + isInternal) passed all reviewers.

**Fix-forward, high priority (all in already-live `main` code):**
- #1 circuit-breaker N<3 (correctness, live blast radius, contradicts handoff) — **do this next, small + tested.**
- #5 `reconcile_aborted` GDPR residual (bundle with #1 — same file, same session).
- #2 dead-man's-switch Railway cron (ops task, gc-1we) + #3 alert-key validation + #4 route-error durability — the "can we detect an incident unattended" set.

**Cheap wins, fold into the above session:** #9 graphqlrc version, #13 dead helpers, #14 stale comment, #10 express bump.

**Track as beads, not urgent:** #6–#8, #11–#12, #15–#19.
