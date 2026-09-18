# Session Handoff: 2026-09-17 — Filename-based app attribution (SHIPPED)

## What Got Done
- Reviewed the **first real-merchant scan** (`d4c4c4.myshopify.com`, scan `cmu48sn2600s4qg01fyhx3i87`, 26 findings). Confirmed the new observability signals (ScanDomain / scan_signal / resolution counts) were EMPTY on it — verified this is **expected**, not a bug: the scan ran 2026-09-16 15:17 UTC, ~4.5h before PR #25's signal code merged (19:47 UTC). No instrumented scan exists yet.
- Mined the 26 findings and found a **systematic attribution bug**: `GHOST_PIXEL`/`GHOST_SCRIPT`/`GHOST_STYLE` attributed to the generic tracker library (fbq→Facebook Pixel, ga→GA, gtag→GTM) instead of the app that orphaned the code. Real culprits: **Spreadr** (Amazon importer, entirely absent from `APP_SIGNATURES`) mislabeled as FB Pixel / GA; **PageFly**'s gtag loader mislabeled as GTM.
- Wrote + got approval on `docs/specs/filename-attribution-spec.md`, dispatched implementation, ran an **adversarial audit** (fixed one FP-risk warning it found), and **shipped to prod**.

## Shipped (PR #26 → main `022348e`, deployed + smoke + CI green 2026-09-17)
- **gc-1ql** (P2 bug, CLOSED): `filePatterns` on `AppSignature` + `identifyAppFromFilename()` + DRY `resolveAttribution(contentApp, filename, opts)` helper in `app/services/app-lookup.server.ts`. File-owner overrides a **generic tracker** (`isTracker`) or null content, never a specific non-tracker match (Judge.me-nested-in-EComposer stays Judge.me). Wired into `detectGhostPixels` + script/style detectors in `scan-engine.server.ts` with enriched descriptions ("left by Spreadr (calls Facebook Pixel)").
- **gc-rmb** (P2, CLOSED): new Spreadr signature (`filePatterns: [/(^|\/)spreadr[-.]/i]`, code markers `SpreadrClick`/`spreadrRedirectURL`/`SpreadrLink`).
- **gc-ohn** (P3, CLOSED): added `cdn.ecomposer.app` + `ecomposer.app` to EComposer `cdnDomains`.
- Full suite **2680 green** (+2 FP-prevention tests). tsc/eslint/prettier clean.

## Key Decisions
- **Precedence keyed on existing `isTracker` flag** (rejected: "file owner always wins", which would clobber legit nested widgets like Judge.me inside an EComposer file).
- **Gate the null-content case at the script/style call site** (`if (!contentApp) continue;` before resolving) — the audit's one warning. Rejected shipping the broader behavior where an unrecognized URL in an app-named file (e.g. `sections/ecom-hero.liquid`) manufactures a finding: FP risk on still-installed EComposer, and both real misattributions had non-null content so it wasn't needed. Deferred "detect non-signature scripts in app-owned files" as a future opt-in feature.
- **Evidence-driven filePatterns scope** (Spreadr/PageFly/EComposer only; rejected proactive Shogun/GemPages patterns — no evidence yet).
- **Enrich descriptions** on override ("left by X (calls Y)") to keep the tracker diagnostic without the misattribution.

## Patterns & Discoveries
- **Filename is a stronger attribution signal than the inline tracker call** for orphaned page-builder / importer code. The domain graph is NOT the lever for this class (Spreadr leftovers are inline pixels with no external domain).
- `fingerprintFinding` = `filename + findingType + normalize(codeSnippet, lineNumber)` — **`appName` is not in it**, so re-attribution causes zero scan-differ churn (verified via non-vacuous regression test).
- **Product signal**: uninstalled page builders dominate ghost code (EComposer = 15/26 findings on this merchant; merchant also tried PageFly). GA-Universal (Google-sunset 2023) leftovers = clean "genuinely dead code" story. Worth feeding into `docs/product-strategy.md` / GTM (page-builder-churn ICP).
- **Footgun (harmless today)**: `detectGhostPixels`'s hardcoded `TRACKING_PATTERNS` display names ("Facebook Pixel") ≠ the `isTracker` signature names ("Facebook Pixel (legacy)"). Pixel path forces `contentIsTracker: true` so it's fine; don't assume those strings are `isTrackerApp`-lookup-able.

## In-Progress / Ready Work (unchanged this session)
- **gc-1we** (P1, in_progress): external dead-man's-switch — Railway cron evaluates heartbeats independent of Inngest (closes review H3). NOT touched; pick up fresh.
- Deferred GTM from 09-12: gc-oam (checkout.liquid copy reframe, P1), forum post.

## Uncommitted Changes (working tree)
- `scripts/review-latest-scan.ts`, `scripts/dump-scan-findings.ts` — read-only review tooling, INTENTIONALLY kept uncommitted. These are the tools to run the pending live-verification (below).
- `memory/handoff-2026-09-16-scan-observability.md` — prior session's handoff note, still uncommitted from before this session.

## Open Questions / Loose Ends
- **Live end-to-end verification of the attribution fix is PENDING.** Code is deployed + smoke-verified + fully unit-tested, but no real scan has exercised it yet. Blocked on triggering a prod scan: local `INNGEST_EVENT_KEY` in `.env` is invalid for prod ("401 Event key not found"), and `railway login` is expired. To verify: (a) `railway login` then fetch the real event key, OR (b) trigger via the app UI, OR (c) wait for the next organic merchant scan. Then run `npx tsx --env-file=.env scripts/review-latest-scan.ts` and confirm `spreadr*`-file findings attribute to "Spreadr" and pagefly gtag → "PageFly".
- **`bd dolt push` remote is unconfigured** ("no store available"). Beads (incl. the 3 closed today) persist to the shared local `dolt sql-server` (running, pid was 1743), NOT to any remote mirror. If a remote mirror is expected, it needs setup.

## Recommended Next Steps
1. **Verify the fix live**: `railway login`, trigger a scan on `nw-dev-store-2` (Professional, has a "test-data" theme w/ 45 findings), then `npx tsx --env-file=.env scripts/review-latest-scan.ts` + `dump-scan-findings.ts <scanId>` to confirm Spreadr/PageFly attribution and that ScanDomain/scan_signal now populate (first instrumented scan).
2. **Decide on the review scripts**: commit `review-latest-scan.ts` + `dump-scan-findings.ts` as dev tooling (check for a docs/scripts paths-ignore so it doesn't burn a Railway deploy), or leave uncommitted.
3. **gc-1we** (P1): the external dead-man's-switch, still the top open engineering item.

## Risks & Warnings
- One stuck PENDING scan (`cmu5sy3ti…`) was created this session when the Inngest dispatch failed; the watchdog already auto-expired it to FAILED (self-healed). No action.
- The `IgnoredFinding` APP-scope behavior change (merchants who bulk-ignored "Facebook Pixel" will see re-attributed Spreadr findings resurface) is documented + accepted, but watch for merchant confusion if it comes up.
- EComposer's `filePatterns: [/(^|\/)ecom[-_.]/i]` is the broadest pattern; the null-content gate defuses the main FP risk, but a non-EComposer file named `ecom-*` containing a tracker/known-app URL could still get overridden to EComposer. Low risk, no evidence, left as-is.
