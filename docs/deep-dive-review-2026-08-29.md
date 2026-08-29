# Ghost Code — Deep-Dive Review (2026-08-29)

Full 11-agent pre-growth review ahead of the paid-ads push. Each finding was verified against current code + git history before inclusion (per `.claude/rules/backlog-triage.md`). One finding was **refuted** during the verify pass and dropped.

- **App state:** Live, `main` 2 commits ahead of origin (cosmetic; runtime no-op).
- **Context:** ad slice imminent → findings weighted for "what breaks or erodes trust under new traffic."
- **Raw findings:** 58 across 11 dimensions → ~40 distinct after dedup; 1 refuted.

---

## Verify-pass adjustments

| Finding | Source agent | Verdict | Why |
| --- | --- | --- | --- |
| Scan finalizes COMPLETED, never PARTIAL → "false Completed badge" | Logic bugs (HIGH) | **REFUTED — dropped** | Deliberate decision. Commit `c6a37b7` + in-code comment (scan-theme.ts:469): PARTIAL was the *permanent default* (app never requests optional scopes), read as "failed" to merchants + Shopify reviewers, made COMPLETED unreachable. `skippedCategories` still recorded for the diff engine + future nudge. This is the session-24 "decoupled the misleading Partial status" work. |
| Scan-pool inline fallback DoS | Security (HIGH) | **CONFIRMED (architectural); ReDoS exploitability plausible** | `catch` returns `scanThemeFiles(files)` inline on the main event loop (scan-pool.server.ts:84). Isolation-defeat is certain; catastrophic-backtracking claim not independently proven. |
| Shopify CDN TLD mismatch | URLs (MED) | **CONFIRMED** | Regex line 989 = `shopifycdn.com`; domain list 1861 = `cdn.shopifycdn.net`. Disagree. |
| react-router 7.17.0 CVEs | Deps (HIGH) | **CONFIRMED** | 7.17.0 installed, in advisory range; fix = bump ≥7.18.2. |

---

## P0 — Do before the ad push

### 1. Ops alerting is effectively blind (Observability — 3 findings)
The single highest-leverage cluster given the documented 2-week Shopify delist caused by exactly this failure mode.
- **Inngest failure notifications are TODO stubs** (`notifications.server.ts:47`) — `notifyFunctionFailure()` only logs + Sentry; `SLACK_WEBHOOK_URL`/`NOTIFICATION_EMAIL` never read. A failing cron reaches no human.
- **No cron dead-man's-switch** (`watch-stale-scans.ts`) — the watchdogs are themselves Inngest crons; if Inngest stops invoking (signing-key drift), they die too. Nothing external notices.
- **`health/deep` checks key *presence*, not correctness** (`health.deep.tsx:84`) — `Boolean(EVENT_KEY && SIGNING_KEY)`; a stale-but-present signing key (the exact drift incident) still reports `inngest: {ok:true}` and passes the CI smoke gate green.
- **Fix:** wire a Slack webhook behind the existing scaffold; per-cron `lastRunAt` DB heartbeat surfaced in `/health/deep`; make the Inngest check functional (recency, not presence).

### 2. Scan-pool inline-fallback event-loop DoS (Security HIGH)
`scanThemeFilesInPool` catches any worker failure/timeout and re-runs the identical CPU-bound regex scan **synchronously on the main thread** (`scan-pool.server.ts:84`), stalling the whole multi-tenant app (auth, health, other shops' scans, GDPR webhooks). No file-size cap before scanning; several detector regexes use adjacent-quantifier alternations that can backtrack.
- **Fix:** on worker failure, mark scan degraded/failed (or retry in a fresh worker) — never inline re-run. Cap `file.content` length (~200KB) before detector regexes. Rewrite `CANONICAL_RE`/`PRECONNECT_RE`/`LINK_STYLESHEET_RE`/`META_ROBOTS_RE`/`OG_META_RE` to isolate tag text first (non-backtracking split) then apply attribute regexes.

### 3. No reference-theme regression tests for v1.3/v1.4 detectors (Testing CRITICAL+HIGH)
The only real-stock-theme golden-file suite covers `GHOST_TITLE`/`GHOST_OG` only. `GHOST_CANONICAL`, `GHOST_PRECONNECT`, `GHOST_FONT`, `GHOST_AJAX` have **zero** coverage against real Dawn/Sense/Craft markup — every "does not flag" test is a synthetic one-liner. This is the exact LOG-1 false-positive-on-stock-themes class, on the newest code, right as ad traffic hits.
- **Fix:** extend `tests/fixtures/reference-themes.ts` with verbatim Dawn preconnect/`@font-face`/`fetch()`/canonical markup; add 0-findings assertions per detector. Also: no integration-pipeline test exercises the 6 new types end-to-end (unit-only) — add one.

---

## P1 — High

4. **react-router 7.17.0 on the live request path carries 5 CVEs** (Deps) — route-matching DoS + RSC CSRF bypass, directly reachable. Bump `react-router`/`@react-router/{dev,node,serve}` to ≥7.18.2 (also clears the transitive body-parser advisory). The other ~35 audit hits are dev-only noise; the OpenTelemetry-via-inngest subtree (protobufjs/jaeger DoS) is a separate `npm audit fix`.
5. **Merchant notifications don't exist** (Enhancements) — Standard weekly scans + Pro on-publish rescans fire silently; no merchant is ever told new ghost code appeared. Highest retention lever, undercuts the paid value prop under ad-driven acquisition. Reuse existing scan-diff logic; email via Resend/Postmark.
6. **Shopify CDN TLD mismatch → false positives** (URLs) — legit first-party scripts served from `shopifycdn.net` aren't allowlisted by `SHOPIFY_FIRST_PARTY_RE` (`.com` only) → misclassified as "unknown external resource." Consolidate to one shared allowlist (`isShopifyDomain()`); add a regression test.
7. **No per-finding dismissal** (Enhancements) — can't mark a known-acceptable finding "not a problem"; it resurfaces every scan. This is the trust-erosion / false-positive-noise pattern that got Cleanify Code delisted. Persist a `dismissed` flag keyed on a stable fingerprint (appName+filename+type).
8. **Scan-engine perf hotspots** (Quality, 2) — `GHOST_TEXT` runs all 115 signatures per line of every file (`scan-engine.server.ts:809`); `lineNumberAtOffset` is O(offset) per match → quadratic on large themes (`:658`). Both worsen under ad-driven scan volume. Add a keyword pre-filter; precompute line-start offsets + binary search.

---

## P2 — Medium (quality, GTM, hygiene)

9. **Health Score Trend Chart is built + tested but dark** (`ENABLE_TREND_CHART` unset everywhere) — decision: **enable it** (verify DB load first; it's the clearest before/after GTM artifact — a rising score line + "share this score" export) **or cut it**. Shipped-but-hidden is the worst of both. *[Judgment call — see chat.]*
10. **SignatureSubmission moderation black hole** — merchants submit "which app left this?" suggestions; no route ever reads them (`getSubmissionsByDomain`/`updateSubmissionStatus`/`acceptSubmissionsForDomain` uncalled). Build an admin review route or stop collecting.
11. **Findings give no removal guidance** (Enhancements) — copy-to-clipboard on the full snippet + a per-type "how to remove" blurb. The strategy doc's wedge is eliminating the *fix* steps, not just *find*; current UI only does find.
12. **`scan-engine.server.ts` is 2289 LOC**; comment-skip logic duplicated 4× (3 detectors reimplement `buildCommentSkipLines`, already drifted in `detectGhostFont`). Split into `detectors/` modules + shared `detector-utils`.
13. **Health monitoring gaps** (Observability) — `/health/deep` only hit once at deploy (add a 5-15min external monitor); worker-fallback logged as `warn` so it never reaches Sentry (escalate to `error`); `snapshot-metrics` collected but never alerted on.
14. **Unbounded `findMany`** in `unknown-script.server.ts` (`getSubmissionsByDomain` no `take`; `acceptSubmissionsForDomain` uses non-indexable `contains`). Add a store-time `domain` column + bound the query.
15. **No confidence signal on findings** (Enhancements) — signature-matched types (GHOST_SCRIPT/PIXEL/PRICE) vs heuristic (ORPHAN_ASSET/SETTINGS_DRIFT) present identically. Add a High/Heuristic badge from the existing type taxonomy.
16. **Multi-theme gating exists only in docs** (Enhancements) — `canUseMultipleThemes()` referenced in pricing doc, absent in code; Pro's flagship "unlimited themes" has no upgrade nudge. Add the theme-picker nudge; correct the stale doc.

---

## P3 — Low (polish, defer past launch)

- **Accessibility** (mostly the one custom SVG chart + hand-rolled table/input in `app.scans.$scanId.tsx`): trend-chart SVG has no SR data-table fallback (MED); unknown-script input has no label (MED); table captions, CSV-button `aria-hidden`, plan-tile heading semantics (LOW). App is otherwise a11y-sound via Polaris WC.
- **OpenTelemetry-via-inngest** transitive CVEs (protobufjs/jaeger) — `npm audit fix`, no major bump.
- **Health-check token** uses `!==` not constant-time compare (`health.deep.tsx:79`) — low blast radius.
- **Dead `GHOST_TITLE` severity branch** (`severity-classifier.server.ts:112`) — `/page_title/` never matches any real description; remove or wire a real signal.
- **API version 2026-04** is likely a quarter behind stable (2026-07) — *verify against Shopify's release table*, then bump `shopify.app.toml` + `shopify.server.ts` together.
- **`app/uninstalled` hard-deletes immediately** (same as `shop/redact`), skipping Shopify's 48h reinstall grace window — *confirm intentional* (privacy-first) vs. defer wipe to `shop/redact`.
- **Stale billing comment** (`shopify.server.ts:56`) describes an unused classic-Billing pattern; app uses Managed Pricing. Update comment.
- **`ttl-cache` unbounded** (fine at current cardinality; guard if reused per-scanId), **composite `(scanId, severity)` index** (fine at current row counts).

---

## Doc hygiene (from the roadmap reconciliation)

- **`docs/product-strategy.md` is ~5 months stale** — flip v1.3 (`GHOST_CANONICAL/TITLE/OG`) and v1.4 (`GHOST_PRECONNECT/FONT/AJAX`) from "Planned/next sprint" to **Shipped** (commits `e287bbe`, `dd973f8`). Counts drifted: finding types 20→26, signatures 94→~114.
- **Genuinely unbuilt roadmap items** (the only real feature backlog left): "before you uninstall" scan mode, speed-optimizer paradox detection, render-blocking severity enhancement, lazy-loading LCP regression.
- **Cross-portfolio memory correction:** ghost-code's `.npmrc` has NO `shamefully-hoist` (only `engine-strict`) — the standing note is stale for this repo.

---

## What was checked and found correct (no action)

`scan-differ.server.ts` multiset fingerprint diffing, `plan-gating.server.ts` quota boundaries, `health-score.ts` scoring math, the v1.3/v1.4 detectors vs. real Dawn markup (title/OG SAFE_*_VARS allowlists hold), Polaris-owned a11y (focus, `s-*` semantics, `aria-live` scan-status card, labeled theme picker).
