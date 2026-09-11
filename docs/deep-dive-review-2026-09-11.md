# GhostCode — Deep Dive Review (2026-09-11)

**Scope:** Whole repo (`/Users/nathanwhitley/shopify/ghost-code-app`), branch `main` at `f375404`. Working tree clean apart from one untracked handoff note.

**Method:** 11 category review agents run in parallel (2 specialists: `security-reviewer`, `shopify-compliance-reviewer`; 9 general). ~49 non-enhancement findings collected + 10 feature enhancements. Verify pass performed by the orchestrator (Opus) directly against the cited code: all 4 HIGH findings and the most consequential MEDIUMs were confirmed by reading the source; the remaining MEDIUM/LOW findings are accepted on the category agents' own file-level verification (each read the cited file and grepped for references). **0 findings refuted.**

**Notable method notes:**
- **Security category surfaced zero formal vulnerabilities** — a genuinely clean result, not an un-reviewed one. Every `/app/*` route calls `authenticate.admin`, every webhook calls `authenticate.webhook`, all scan-scoped resource routes verify `scan.shopId === shop.id` (no IDOR), admin routes are fail-closed allowlisted, no raw SQL, no `dangerouslySetInnerHTML`, no SSRF surface (GraphQL-only), and the scan-engine regexes have a dedicated ReDoS suite. The only security note is a LOW timing-comparison nit (below).
- **`npm audit` reports 45 vulns (35 high) but the Dockerfile does `npm ci --omit=dev` and the runtime image copies node_modules only from the prod-deps stage** — so all the graphql-codegen / typescript-eslint / vitest / eslint / postcss high-severity advisories never ship. Real runtime dependency risk is small; see DEP-1/DEP-2.
- **Criticality adjustments:** none required for real findings (each HIGH's impact text is internally consistent). Feature enhancements are presented as *priorities* (not severities) and are `N/A (enhancement, not verified)`.

---

## Summary by criticality

| Criticality | Count |
|---|---|
| HIGH | 5 |
| MEDIUM | 16 |
| LOW | 18 |
| Enhancement (unverified) | 10 |

## Summary by category

| Category | HIGH | MED | LOW | Notes |
|---|---|---|---|---|
| Security | 0 | 0 | 1 | Clean; 1 timing-comparison nit |
| Shopify Compliance | 1 | 1 | 3 | shop/redact gap; optional-scopes reachability |
| Logic / Bugs | 1 | 1 | 3 | page-dangling false positives (live) |
| Dead Code | 0 | 3 | 5 | dead webhook route, dead exports/tokens |
| Quality / Performance | 0 | 3 | 3 | redundant scope probes, DRY dupes |
| Bad / Hardcoded URLs | 0 | 0 | 2 | clean; env-driven throughout |
| Testing Gaps | 0 | 2 | 2 | GDPR failure path, deprecated-webhook suite |
| Dependency Audit | 0 | 2 | 5 | EOL Node 20, runtime HTTP stack |
| Accessibility | 0 | 1 | 4 | trend chart invisible to SR |
| Observability | 2 | 3 | 2 | cron-outage blindness, Sentry dormancy |
| Enhancements | — | — | — | 10 product ideas |

---

## Top 10 — act on these before GTM

1. **[LOGIC-HIGH] Page "broken link" false positives on stores with >250 pages** — live Standard+ feature reports existing pages as "no longer exists (verified via Admin API)". Directly damages the data-integrity brand.
2. **[COMPLIANCE-HIGH] `shop/redact` leaves the shop's myshopify domain in the `OpsEvent` table** — GDPR erasure gap; exactly the class App Store reviewers probe.
3. **[OBSERVABILITY-HIGH] A total Inngest/cron outage is internally undetectable** — every alert channel is itself an Inngest cron; the known "signing-key drift kills all crons" failure mode is silent between deploys.
4. **[OBSERVABILITY-HIGH] Sentry can be silently dormant in prod** — no fail-fast guard, not in `/health/deep`; if `SENTRY_DSN` is unset the app is blind on exceptions. *Verify the DSN is actually set in Railway first.*
5. **[COMPLIANCE-HIGH] Optional scopes are declared but never requested** — no App Bridge `scopes.request` call anywhere, so `read_products/content/translations` are never granted and the Standard+ product/collection dangling-reference, translation, redirect, and live-price audits are structurally unreachable (always ACCESS_DENIED → PARTIAL). *Verify against prod scan behavior.*
6. **[OBSERVABILITY-MED] Full request URL (with `id_token` session JWT) is forwarded to Sentry on every captured error** — no `beforeSend` scrubber; a credential leaks into a third-party service.
7. **[LOGIC-MED] `page-detector` / `metafield-detector` flag pages & metafields of *still-installed* apps as ghost code** — invites merchants to delete assets their active apps depend on.
8. **[DEP-MED] Production base image is EOL Node 20** (`node:20-alpine`, unsupported since 2026-04-30) — standing, un-remediated runtime with no security patches.
9. **[OBSERVABILITY-MED] Operator failure-alert emails have no dedup/throttle** — a failure burst floods the inbox and can exceed Resend's rate limit, silently dropping real alerts.
10. **[TEST-MED] The GDPR `shop/redact` failure path is untested and leaves `ops-event.server` unmocked** — the highest-stakes webhook skips the "failure is recorded before re-throw" assertion its siblings all make, and risks prod writes in tests.

---

## Full findings (ranked)

### HIGH

#### H1 — Page dangling-reference audit false-positives for stores with >250 pages
- **Category:** Logic / Bugs · **Verdict:** CONFIRMED (read `dangling-reference-resolver.server.ts` + `content-fetcher.server.ts`)
- **File:** `app/services/dangling-reference-resolver.server.ts:299` (`resolvePages`), cap at `app/services/content-fetcher.server.ts:82`
- **Description:** `resolvePages` calls `fetchPages(admin)` (capped at `maxPages=250`), builds `existing = new Set(pages.map(handle))`, then reports every page candidate NOT in that set as a `DANGLING_REFERENCE`. Any real page beyond the first 250 is absent from `existing` and is reported missing. Unlike products/collections (exact per-handle query) and unlike the lookup-budget path (which sets `truncated`/`capHit` so the differ excludes truncated results), the page path has **no truncation signal**: `fetchPages` never tells `resolvePages` that more pages exist, so `truncated` stays `false` and the diff engine will not suppress the false finding. Live in prod (`DANGLING_REFERENCE_LIVE_ENABLED=true`, Standard+).
- **Impact:** HIGH. Content-heavy merchants (the growth-stage target) get confident merchant-facing false claims: "Broken page link: /pages/X. This page no longer exists (verified via Admin API)." The "verified via Admin API" wording makes it especially trust-damaging, and it is never diff-suppressed.
- **Recommendation:** Resolve page existence with an exact per-handle query (mirror `handleExists` for products/collections) counted against `MAX_LOOKUPS`; or propagate `hasNextPage` from `fetchPages` and mark the category skipped/`truncated` when the page list is capped so no page beyond the fetched set is reported missing.

#### H2 — `shop/redact` does not purge OpsEvent rows carrying the shop domain
- **Category:** Shopify Compliance · **Verdict:** CONFIRMED (read `shop.server.ts:206`, `ops-event.server.ts`, `schema.prisma`)
- **File:** `app/models/shop.server.ts:206` (`deleteShopData`)
- **Description:** `deleteShopData` deletes `Session` rows and the `Shop` row (relying on Prisma cascade for Scan/Finding/UnknownScript/SignatureSubmission/BillingEvent). `OpsEvent` has **no FK relation to Shop** (plain `id/eventType/key/message/metadata`), so it is never cascaded or touched. But `ops-event.server.ts` writes the shop's myshopify domain into OpsEvent rows in three places: `recordWebhookFailure` (`metadata.shop`, `key = topic`), `recordApiError` (`metadata.shopDomain`), and the `SHOP_UNINSTALLED` event (`key = shop` domain). `pruneOpsEvents` only prunes `cron_heartbeat` rows older than 30d and explicitly leaves webhook_failure/api_error untouched at any age.
- **Impact:** HIGH. After `shop/redact`, the shop's identifying domain persists indefinitely in `OpsEvent`. This is exactly the "table outside the obvious cascade chain" gap Shopify app review flags redact handlers for. (Nuance: shop domain is merchant/shop data, not customer PII — but `shop/redact` obliges deletion of *all* shop data.)
- **Recommendation:** In `deleteShopData`, add a step to delete or redact OpsEvent rows referencing the domain (`deleteMany({ where: { OR: [{ key: domain }, { metadata: { path: ['shop'], equals: domain } }, { metadata: { path: ['shopDomain'], equals: domain } }] } })`). Add a regression test asserting no OpsEvent references the domain post-`deleteShopData`.

#### H3 — Total Inngest/cron outage is internally undetectable
- **Category:** Observability · **Verdict:** CONFIRMED-mechanism (aligns with documented "signing-key drift kills ALL crons" recurring incident)
- **File:** `inngest/functions/monitor-deep-health.ts:14` (and the whole monitor stack)
- **Description:** The entire alerting stack (`monitor-deep-health`, `monitor-scan-failures`, `operator-digest`, `watch-stale-scans`) runs *as Inngest crons*. When Inngest itself stops, none of them fire, scans sit PENDING forever, and `watch-stale-scans` can't expire them. Railway's healthcheck hits the **shallow** `/health` (DB-only, stays 200 during a cron outage). `/health/deep` *would* return 503 via the dead-man's-switch, but the only callers are the deploy-time smoke gate and the now-dead `monitor-deep-health` cron. No GitHub Actions cron or external uptime monitor exists in the repo.
- **Impact:** HIGH. A production Inngest outage (signing-key drift is a known repeat incident portfolio-wide) is silent between deploys — no scans complete, no alert reaches the operator — until the next deploy's smoke gate fails or a merchant complains.
- **Recommendation:** Stand up an out-of-band monitor that does not depend on Inngest — an external uptime service or scheduled GitHub Actions cron that GETs `/health/deep` with `x-health-token` and pages on 503, and/or wire Sentry Cron check-ins so missed check-ins are detected server-side. Treat as a pre-GTM checklist item, not a code TODO.

#### H4 — Sentry error tracking can be silently dormant in production
- **Category:** Observability · **Verdict:** CONFIRMED-mechanism (read `sentry.server.ts`; impact conditional on prod env)
- **File:** `app/lib/sentry.server.ts:25`
- **Description:** `initSentry()` returns silently when `SENTRY_DSN` is unset, and every `captureException/captureMessage` early-returns to a no-op. Unlike `SHOPIFY_API_SECRET` and the Inngest keys (which throw at boot), `SENTRY_DSN` has **no** production fail-fast guard and is **not** checked by `performDeepHealthChecks`. A missing/typo'd DSN in Railway makes the whole error-tracking layer inert while smoke passes and `/health/deep` stays green. A repo handoff note historically recorded `SENTRY_DSN` unset in Railway ("errors just go unmonitored").
- **Impact:** HIGH *if* the DSN is unset (then the app is blind on all exceptions with no signal revealing the gap). **First action: confirm `SENTRY_DSN` is set in Railway prod.**
- **Recommendation:** Add `SENTRY_DSN` presence to `performDeepHealthChecks` (report an "observability" check) so a missing DSN degrades `/health/deep` and fails the smoke gate; and/or add a production warn-log at boot when `NODE_ENV=production` and DSN is unset (keep it optional, not a hard throw).

#### H5 — Optional scopes are declared but never requested (paid detectors unreachable)
- **Category:** Shopify Compliance · **Verdict:** CONFIRMED (grep found zero `scopes.request`/App Bridge grant flow; verify against prod scan behavior)
- **File:** `shopify.app.toml:39` (`optional_scopes`)
- **Description:** `optional_scopes = ["read_translations","read_products","read_content","read_online_store_navigation"]` are consumed defensively (probe → ACCESS_DENIED → `skippedCategories`) but there is **no** App Bridge scopes-request call or `/auth` re-consent redirect anywhere in `app/routes`, `app/components`, or `app/lib` (including `app.settings.tsx`). Optional scopes are not auto-granted at install, so without an explicit grant flow no merchant can ever grant them.
- **Impact:** HIGH. The Standard+ product/collection dangling-reference detection (a paid differentiator), translation ghost-audit, redirect ghost-audit, and JSON-LD live-price audit are permanently ACCESS_DENIED → skipped for every merchant, silently degrading paid-plan value. Also a plausible reviewer question: scopes declared but structurally unobtainable. (Interacts with H1: product/collection resolution is "safe" only because it never runs.)
- **Recommendation:** Add a settings control that calls `shopify.scopes.request([...])` (or an OAuth re-consent redirect) gated to plans that need the scopes; or remove the scopes from `optional_scopes` until the request flow ships. **Verify current prod behavior** — if merchants are seeing PARTIAL scans on every audit category, this is confirmed live.

### MEDIUM

#### M1 — Full request URL (with `id_token`) forwarded to Sentry
- **Category:** Observability · **Verdict:** CONFIRMED (`entry.server.tsx:69` sends `url: request.url`; no `beforeSend` in `sentry.server.ts`)
- **File:** `app/entry.server.tsx:69`
- **Impact:** MEDIUM. Embedded Shopify requests carry the session token as `id_token` (and sometimes `hmac`/`session`) on the URL. A thrown loader/action error attaches the full URL to the Sentry event, exfiltrating a (short-lived) credential to a third party.
- **Recommendation:** Strip the query string before capture (`new URL(request.url).pathname`) and add a `beforeSend` hook redacting `id_token/session/hmac/signature` from event URLs/extras.

#### M2 — Detectors flag still-installed apps' pages/metafields as ghost code
- **Category:** Logic / Bugs · **Verdict:** CONFIRMED (design gap; read both detectors)
- **File:** `app/services/page-detector.server.ts:55`, `app/services/metafield-detector.server.ts:66`
- **Impact:** MEDIUM. `detectOrphanedPages` / `detectOrphanedMetafields` flag by app-name pattern / namespace alone, without verifying the app is uninstalled. A merchant actively using Judge.me/PageFly/Klaviyo gets those pages/metafields reported as ghost code — false positives that invite deletion of live dependencies. Contrast `price-detector.server.ts`, which requires positive orphan evidence.
- **Recommendation:** Apply the same positive-evidence bar `price-detector` uses, or downgrade to informational with copy that says "from this app whether or not it is still installed — verify before removing", or cross-reference the theme scan (only surface an app's pages/metafields when that app also left ghost theme code).

#### M3 — Production base image is End-of-Life Node 20
- **Category:** Dependency Audit · **Verdict:** CONFIRMED (`Dockerfile:1`)
- **File:** `Dockerfile:1` (`FROM node:20-alpine`)
- **Impact:** MEDIUM. Node 20 reached EOL 2026-04-30; no further security/bug fixes. A standing, un-remediated runtime exposure that worsens monthly. The `engines` range still permits 20, so nothing flags it.
- **Recommendation:** Bump to `node:22-alpine` (satisfies `>=22.12`) or `node:24-alpine`; tighten `engines` to `>=22.12`. No app-code changes.

#### M4 — Runtime HTTP stack carries advisories on the live request path
- **Category:** Dependency Audit · **Verdict:** CONFIRMED (traced prod tree via `--omit=dev`)
- **File:** `package.json` (`@react-router/serve` → express@4 subtree)
- **Impact:** MEDIUM (bordering low). `react-router-serve` ships `qs` (array-limit bypass, DoS), `body-parser` (DoS), `morgan` (log forging) — the only vulnerable cluster that both ships to prod AND processes attacker-influenceable input (query strings, bodies, log lines). Impact limited to DoS/log-forging; mitigated by Railway's proxy and HMAC-verified webhooks.
- **Recommendation:** `npm audit fix` / bump `@react-router/serve` to the latest 7.x patch (non-major, server-subtree only); re-run build + smoke before deploy.

#### M5 — Operator failure-alert emails have no dedup/throttle
- **Category:** Observability · **Verdict:** CONFIRMED (`middleware.ts:105`, `notifications.server.ts:66`)
- **File:** `inngest/middleware.ts:105`
- **Impact:** MEDIUM. `notifyFunctionFailure()` sends an email on every failing execution with no dedup/window. Inngest retries (default 4) and systemic causes fail many shops at once → a burst of near-identical emails (alert fatigue), and if it exceeds Resend's rate limit, `sendOpsAlert` returns `http_error` and genuine alerts are silently dropped. Only the worker-fallback path is deduped.
- **Recommendation:** Dedup `function_failure` emails by `functionId` within a trailing window (query the last such OpsEvent before sending), and/or send only from a terminal `onFailure` handler rather than per-attempt. Keep the OpsEvent record on every failure for the digest.

#### M6 — GDPR `shop/redact` failure path untested; `ops-event` model unmocked in tests
- **Category:** Testing Gaps · **Verdict:** CONFIRMED (read `tests/routes/webhooks.test.ts`, `tests/integration/gdpr-flow.test.ts`)
- **File:** `tests/routes/webhooks.test.ts` (+ `tests/integration/gdpr-flow.test.ts`)
- **Impact:** MEDIUM. `webhooks.tsx` calls `recordWebhookFailure` before re-throwing on error, but no test exercises the SHOP_REDACT catch path, and neither the unit nor the integration test mocks `ops-event.server` — so the real `db.opsEvent.create` fires during the test (the "leaked 45 OpsEvents to prod" hazard class, saved only by `setup.ts`'s dummy URL). The sibling webhooks explicitly assert the failure-recording; the most compliance-critical one skips it.
- **Recommendation:** Mock `ops-event.server` and add a SHOP_REDACT case where `deleteShopData` rejects; assert the action rejects AND `recordWebhookFailure` was called with the right args. Add the mock to `gdpr-flow.test.ts`.

#### M7 — `billing-flow` integration suite tests only the deprecated, unwired webhook
- **Category:** Testing Gaps · **Verdict:** CONFIRMED
- **File:** `tests/integration/billing-flow.test.ts:127`
- **Impact:** MEDIUM. The 242-line "Billing flow" suite exclusively drives `webhooks.app.subscriptions.update.tsx`, which is dead (APP_SUBSCRIPTIONS_UPDATE removed 2026-04-28). The live path (`reconcileShopPlan` + `plan_handle` fast-path) is only unit-tested. False "billing is integration-tested" signal on the pre-GTM bar.
- **Recommendation:** Repoint (or add) an integration test for the live path (`app.tsx` loader + `plan_handle` → `reconcileShopPlan` → `updateShopPlanByDomain`, plus the stale backstop). Relabel or delete the deprecated suite alongside the dead route (see M8).

#### M8 — Dead APP_SUBSCRIPTIONS_UPDATE webhook route retained
- **Category:** Dead Code (also flagged by Compliance) · **Verdict:** CONFIRMED
- **File:** `app/routes/webhooks.app.subscriptions.update.tsx:30`
- **Impact:** MEDIUM. ~140-line handler for a topic Shopify no longer sends and the toml no longer registers; it still writes plan state (duplicating `billing-reconciler`). Its own header says it's retained "for historical reference." Risk: a future `shopify app config link` / manual toml edit silently re-registers a second, uncoordinated plan-writer that races the reconciler.
- **Recommendation:** Delete the route + its test (billing is covered by `billing-reconciler`), or move it out of `app/routes/` so `flatRoutes()` no longer registers a live URL, or add a loud runtime guard (throw/410).

#### M9 — Exported model/lib functions with zero production callers (test-only)
- **Category:** Dead Code · **Verdict:** CONFIRMED (grepped prod excluding tests)
- **File:** `app/models/finding.server.ts:269` (`getDistinctFileCount`, `countFindingsBySeverity`), `app/models/billing-event.server.ts:48` (`getBillingEventsForShop`), `app/lib/finding-sort.ts:14` (`sortFindingsBySeverity`)
- **Impact:** MEDIUM. ~4 functions plus substantial test suites maintain behavior nothing ships — dead public API surface that inflates test count.
- **Recommendation:** Remove the unused functions + their dedicated tests, or wire them into the feature they were built for (check git history for mid-feature abandonment).

#### M10 — Dead exported design-system tokens in `shared.ts`
- **Category:** Dead Code · **Verdict:** CONFIRMED (1 occurrence each = the definition)
- **File:** `app/styles/shared.ts:142`
- **Impact:** MEDIUM. Ten unused exports (`TABLE_BG_STRIPE`, `INFO_BD_LIGHT`, `ACCENT_SUB`, `GROUND_BORDER`, `HAIRLINE`, `heroStat`, `statNumber`, `textSubdued`, `textSubduedSm`, `textSubduedLg`). Note `HAIRLINE` is dead while lowercase `hairline` is the live one — a copy-paste footgun in the single design-system source of truth.
- **Recommendation:** Delete the ten unused exports (mark any reserved for in-progress pages with a one-line comment).

#### M11 — Redundant Shopify scope-probe GraphQL calls per scan
- **Category:** Quality / Performance · **Verdict:** CONFIRMED
- **File:** `inngest/functions/scan-theme.ts:406` (+ 427/448/467/534), `app/lib/scope-check.server.ts:100`
- **Impact:** MEDIUM. `probeScope` issues a live GraphQL round-trip and is never cached; `hasProductScope` is called independently by ~5 audit steps and `hasContentScope` by 2+, so 5–7 identical probes per scan add latency and consume the 50 pts/s rate-limit budget for no new info.
- **Recommendation:** Probe each distinct scope once per scan (e.g. one `currentAppInstallation { accessScopes { handle } }` query up top) and thread the `grantedScopes` set forward via step return values.

#### M12 — 28-entry `FindingType` zero-map literal duplicated verbatim
- **Category:** Quality / Performance (DRY) · **Verdict:** CONFIRMED
- **File:** `app/models/finding.server.ts:205` (and `:107`)
- **Impact:** MEDIUM. The exhaustive `Record<FindingType, number>` seed is hand-written twice, byte-identical. Adding a FindingType requires editing both; missing one silently returns 0 with no compile error (imperative build skips exhaustiveness checking). Directly in the finding-count hot path.
- **Recommendation:** Extract `zeroedFindingTypeCounts(): Record<FindingType, number>` built from `Object.values(FindingType)` with a `satisfies`/mapped-type construction for compile-time exhaustiveness.

#### M13 — Shop row + admin context re-fetched independently in each audit step
- **Category:** Quality / Performance · **Verdict:** CONFIRMED (design-inherent)
- **File:** `inngest/functions/scan-theme.ts:151`
- **Impact:** MEDIUM. `runAuditStep` and the bespoke steps each call `db.shop.findUnique` + `unauthenticated.admin(shop.domain)` — ~9 shop reads + ~9 session-storage loads per scan. Bounded and correct, but pure repeated work; compounds with M11 to make each scan chattier than necessary.
- **Recommendation:** Resolve `shop.domain` once in step 2 and pass it via the step-2 return value to eliminate the per-step `findUnique`. Leave `unauthenticated.admin` unless profiling shows the session load dominates (it's harder to hoist across retry boundaries).

#### M14 — Health-score trend chart data is invisible to screen readers
- **Category:** Accessibility · **Verdict:** CONFIRMED
- **File:** `app/components/HealthScoreTrendChart.tsx:147`
- **Impact:** MEDIUM. The SVG has `role="img"` with a generic aria-label, which collapses the per-segment aria-labels on inner `<rect>` nodes. No data-table fallback, no numeric summary. Blind/low-vision merchants on paid plans get none of the trend's numeric payload.
- **Recommendation:** Compose a data-bearing accessible name (per-scan date + totals) or render a visually-hidden `<table>` alongside the SVG; drop the now-dead per-rect aria-labels.

#### M15 — `logger.error` forwards to Sentry as a stackless `captureMessage`, double-reporting Inngest failures
- **Category:** Observability · **Verdict:** CONFIRMED
- **File:** `app/lib/logger.server.ts:34`
- **Impact:** MEDIUM. `logger.error` uses `captureMessage` (never `captureException`), losing the Error stack and grouping by static message string. For log-only error paths this is the only Sentry signal (stackless). For Inngest failures it also double-reports (the middleware captures the raw Error with stack AND `notifyFunctionFailure → logger.error` captures a second stackless message). Degraded triage + inflated volume/quota.
- **Recommendation:** Route real Errors through `captureException(err, context)`; reserve `captureMessage` for genuine non-exception signals. De-dup the Inngest path so a failure is captured once.

#### M16 — Optional scopes declared for audits that never run (see H5 duplicate lens)
> Consolidated into **H5**. Retained here only as a pointer — the compliance and quality lenses converge on the same root cause.

### LOW

- **L1 — Non-constant-time health-token comparison.** `app/routes/health.deep.tsx:54` uses `!==` on `x-health-token`. Timing side-channel on a token that only guards aggregate health counts (no PII). Use `crypto.timingSafeEqual` if you want defense-in-depth. *(Security — the category's only observation.)*
- **L2 — Reinstall does not force a plan reconcile.** `app/routes/app.tsx:41`: `reactivateShop` clears `uninstalledAt` but doesn't reset `planReconciledAt`, so a fast uninstall→reinstall within the 1h freshness window retains the old (possibly paid) plan for ≤1h. Reset `planReconciledAt = null` on reactivate. *(Logic)*
- **L3 — `MetricSnapshot` plan breakdown uses a stale bucket schema.** `app/models/metric-snapshot.server.ts:179` seeds `{ free, professional, business }` — phantom `business` (always 0), no typed `standard`. Cosmetic (internal operator page). Derive keys from `PLANS`. *(Logic)*
- **L4 — "NEW" badge key omits line number/snippet.** `app/routes/app.scans.$scanId.tsx:820`: `newFindingKeys` collapses same-type/file/severity/app findings on different lines, mislabeling the per-row NEW badge. Counts/tiles unaffected. *(Logic)*
- **L5 — Hardcoded `PLAN_AMOUNTS` has no check against Partner Dashboard pricing.** `app/lib/billing.server.ts:88`. Silent `BillingEvent.amount` corruption if pricing changes without a code change. Fetch price from the subscription query or add a drift check. *(Compliance/data-integrity)*
- **L6 — API version currency.** `shopify.app.toml` + `shopify.server.ts` consistently pin `2026-04`; likely one cycle behind current stable (2026-07) as of review date. Not deprecated. Re-verify against the shopify.dev changelog before next deploy. *(Compliance)*
- **L7 — Unused runtime dep `@shopify/app-bridge-react`.** Never imported (App Bridge is CDN-delivered); only referenced in `vite.config.ts:54` `optimizeDeps.include`. Remove from `dependencies` + the optimizeDeps entry. *(Dead Code / Dependency)*
- **L8 — Unused exported helpers in `polaris-events.ts`.** `readNumberValue` (`:45`), `readChecked` (`:54`) — zero refs. Only `readValue` is used. *(Dead Code)*
- **L9 — Dead exports `laneForType` / `CONFIDENCE_TYPE_SETS`.** `app/lib/finding-consequence.ts:311`, `app/lib/finding-classification.ts:175` — exported + tested, zero prod callers. *(Dead Code)*
- **L10 — Duplicate `ThemeFile` type.** Identical `{ filename; content }` exported twice: `scan-engine.server.ts:81` and `theme-fetcher.server.ts:17`. Divergence footgun across the scan pipeline. Define once and import. *(Dead Code / DRY)*
- **L11 — Reimplemented protocol-relative URL normalization.** `app/lib/library-matcher.server.ts:97,168` re-implement `hostnameFromUrl`'s `//`-prefix handling (comment even says "mirror"). Extract to `url.server.ts`. *(Dead Code / DRY)*
- **L12 — Unbatched per-candidate Admin GraphQL in price & dangling audits.** `jsonld-price-audit.server.ts:513`, `dangling-reference-resolver.server.ts:269` do one round-trip per handle (capped 50 each → up to ~100 sequential calls). Batch with `handle:a OR handle:b`. Only worth it if large-theme scan latency becomes a complaint. *(Performance)*
- **L13 — Comment-skip line set recomputed per detector; `lines()` reallocates per call.** `scan-engine.server.ts:297,262` — `buildCommentSkipLines` runs ~9× per file across comment-aware detectors; `lines()` reallocates an N-element array each call. Memoize per file (content-keyed, like `lineIndexFor`). *(Performance, off-thread)*
- **L14 — Theme cache is lazy-eviction only, no size bound.** `theme-cache.server.ts` via `ttl-cache.server.ts` — an idle shop's entry is never re-read to trigger expiry, so it stays resident. Not a real leak at current scale; add max-size/LRU if fanning out to thousands of shops/instance. *(Performance)*
- **L15 — Inngest serve endpoint (signing-key fail-closed) has no test.** `app/routes/api.inngest.ts:24` — the "fails closed when `INNGEST_SIGNING_KEY` absent" claim is unverified; given the portfolio's signing-key-drift history, a boot-time guard/registration test is cheap insurance. *(Testing)*
- **L16 — Trivial routes/libs with no tests.** `auth.$.tsx`, `logger.server.ts`, `plans.ts`, `scan-engine.worker.ts`. Mostly genuinely trivial/covered-by-pool; optional one-line smoke test for `auth.$.tsx` to satisfy the DoD uniformly. *(Testing)*
- **L17 — `SHOPIFY_APP_URL` missing from `.env.example`.** `shopify.server.ts:20` throws at boot without it, but the example omits it — a fresh clone crashes on boot. Add it under `# App`. *(Bad URLs / onboarding)*
- **L18 — App Store review link hardcodes the handle.** `app/routes/app._index.tsx:763` uses literal `apps.shopify.com/ghost-code#...` while `APP_HANDLE` (`plans.ts:13`) is the source of truth used elsewhere. Build the URL from `APP_HANDLE`. *(Bad URLs / DRY)*
- **Accessibility LOWs:** table `<th>` lack `scope="col"` (`app.scans.$scanId.tsx:294` + 3 admin/history tables); copy-to-clipboard success not announced to SR (`:178`, while failure IS via toast); confidence/heuristic caveat conveyed via `title` tooltip only (`:212`, mouse-hover, not keyboard/AT); raw `<h2>` mixed with auto-leveling `<s-heading>` may produce an inconsistent heading outline (`:1248`).
- **Dependency LOWs (all dev-only or inactive, do not block GTM):** 35 "high" audit findings are dev/build-only (never ship via `--omit=dev`); OTel Jaeger-propagator DoS ships via inngest/@sentry but on inactive code paths; `prisma` CLI + `deepmerge-ts` ship because prisma is a runtime dep (deploy-time config load, trusted input); `@react-router/dev` is a runtime dep shipping unused valibot/lodash (template layout — optionally move to devDependencies); supply-chain hygiene is otherwise sound (committed lockfile, no `*`/`latest`, single deliberate `p-map` override).

---

## Feature enhancements (opinions — `N/A (enhancement, not verified)`)

Presented as *priorities*, highest first. GhostCode is already feature-dense on detection breadth; the highest-leverage wins are in the fix-loop, trust, and retention layers, and reuse infrastructure already present.

1. **(High) Deep-link each finding into the Shopify theme code editor** (`app.scans.$scanId.tsx:226`). The app locates the problem perfectly then drops the merchant at the doorstep. Build an admin URL from `themeId` + `filename` (Admin surfaces for GHOST_PAGE/TAG/REDIRECT/PRICE). Effort S, biggest activation win.
2. **(High) False-positive control — ignore / allowlist / mark-intentional** (no such model in `schema.prisma:159`). Unsuppressable false positives make the health score dishonest and cap detection aggressiveness. Add an `IgnoredFinding` model keyed by a stable fingerprint; filter from counts/score/lanes/diffs. Effort M.
3. **(High) Merchant email digest tied to the existing background scans** (`notifications.server.ts` is operator-only). Scheduled/auto scans currently deliver nothing unless the merchant opens the app — the flagship paid differentiator is silent. Reuse Resend + `scan-differ` newFindings; gate Professional. Effort M.
4. **(High) Quantify developer-cost-avoided** (`health-score.ts`). The validated "$200–500 developer cost" message is never expressed in-product. Add a per-finding-type time→dollar estimate on the dashboard hero. Effort S.
5. **(Med) Shareable, human-readable report** (`export.tsx:114` is CSV/JSON only). A printable HTML report (browser "Save as PDF") with health score, lanes, and the remediation text already authored — an agency/dev handoff surface + Professional differentiator. Effort M.
6. **(Med) Quota-exempt "verify fix" re-scan** (`plan-gating.server.ts:26`). The UI says "re-scan to confirm it's gone" but that spends the merchant's one scan; the confirm-the-fix payoff is paywalled. Add a limited quota-exempt re-scan (mirror the AUTO_PUBLISH/SCHEDULED exemption) and surface "Resolved since last scan: N". Effort S–M.
7. **(Med) "Before you uninstall" proactive scan mode** (`product-strategy.md:193`). Snapshot an app's footprint while installed so the merchant knows what will be orphaned — a distinct wedge answering the "it trashed my theme" fear. Effort L (needs attribution snapshotting).
8. **(Med) Surface the "speed-optimizer paradox"** (`product-strategy.md:197`). The app already computes resource weight; a "this installed performance app adds more weight than it removes" callout is screenshot-worthy word-of-mouth. Effort M.
9. **(Low) Orphaned metaobject-definition detection** (`metafield-detector.server.ts`). Add a `GHOST_METAOBJECT` detector mirroring the metafield namespace approach. Effort M.
10. **(Low) First-scan onboarding expectations** (`app._index.tsx:778`). Add a credibility stat ("checks 26 signal types across 115 known apps") + a 3-step "what happens next" + a clean-first-scan empty state. Effort S.

---

## Notes on method

- Category agents were read-only (Read/Grep/Glob + read-only bash); no tests were executed (local vitest/e2e can touch prod paths per project rules).
- The orchestrator's verify pass confirmed all HIGH findings and the highest-impact MEDIUMs against source; MEDIUM/LOW findings not independently re-read are accepted on the category agents' own file-level verification (they read cited files and grepped for references). Nothing was refuted.
- Several findings converge across categories (dead APP_SUBSCRIPTIONS_UPDATE route: dead-code + compliance + testing; optional-scopes: compliance + quality) — consolidated to a single canonical entry with cross-references.
- Two HIGH findings carry an explicit prod-verification action rather than a pure code fix: **H4** (confirm `SENTRY_DSN` is set in Railway) and **H5** (confirm merchants aren't getting PARTIAL scans on every audit category). Check these first — they change whether the finding is "latent risk" or "already broken in prod."
