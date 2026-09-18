# Session Handoff: 2026-09-18 — bundled deploy (reprice + competitive epic + attribution)

## What Got Done
- **Investigated the "unknown scripts" in the operator digest** (read-only prod spike). Findings: only 47 UnknownScript rows / 15 scans; **flywheel is inert (0 SignatureSubmissions ever)**; the digest's flywheel count is RAW (bypasses the shared `isBenignLibrary` matcher, so it over-counts benign public-CDN/font rows); bucket polluted by backup theme files + a `cdn.test-app.com` fixture. Deleted the temp spike script.
- **gc-3sb (NEW, CLOSED): attribution signature gaps.** GemPages serves from `assets.gemcommerce.com` (not just gempages.net) → added `gemcommerce.com` domain + `/gemcommerce\.com/` scriptPattern. Zooomy Wishlist had no signature → added one (`zooomyapps.com` + `/(^|\/)zooomy/i` filePattern). +5 unit tests. **Forward-fix only** — stored UnknownScript rows are NOT retroactively reclassified (attribution is frozen at scan time; only a re-scan re-evaluates; `acceptSubmissionsForDomain` needs merchant submissions, of which there are zero).
- **BUNDLED DEPLOY to main `5e41ce5`, green + SHA-verified live.** One GH cycle. Bundled: pricing $9/$29 + in-app price fix (was chore/pricing-9-29-and-digest-7mt), digest cron 8→7 AM MT, gc-rrh.1 (Pro PDF export), gc-rrh.3 (duplicate-tracker + overlapping-chat-widget detection + additive enum migration), gc-rrh.5 (before-you-uninstall), gc-3sb attribution.
- **Flake fix:** vitest `testTimeout: 20000` + `retry: 1`. Suite was non-deterministically flaky under parallel load (1-3 timeout failures/run) but deterministically green sequentially → pure load-contention, not real bugs. Caught in local preflight (zero GH cost).
- **Verified live:** in-app Plans page shows Free $0 / Standard $9 / Professional $29 (screenshot confirmed). Pricing drift fully closed (Shopify plan page + in-app copy both correct).
- **Branch hygiene:** deleted 15 merged local branches + the integration branch.
- Closed beads: gc-rrh.1/.3/.5 (shipped), gc-bzs + gc-35t (superseded reprice handoffs), gc-3sb (live).

## Key Decisions
- **One bundled deploy (not split) + rigorous local preflight** — chosen to conserve GH Actions minutes (Nathan near monthly limit). Risk analysis showed low blast radius: additive idempotent enum migration, NO enum-bundle-leak (new types used as string keys in routes, `FindingType.X` values only in `.server.ts`), clean auto-merge (billing.server.ts touched in both branches but non-overlapping regions). Rejected: 2-deploy split (2x GH), PR flow (2x GH).
- **Attribution fix scoped to signatures-only (forward-fix)** — rejected backfill of stored rows (tiny/cosmetic, mostly dev-store noise) and broader coverage sweep.
- **Flake fix = testTimeout 20s + retry 1** (rejected: raise-timeout-only, CI-only sequential). Masking risk minimal since sequential proved green.
- **Direct-to-main push** (not PR) for GH economy; both session branches were local-only (never pushed), so no remote cleanup needed.

## Patterns & Discoveries
- **Attribution is scan-time-frozen.** `identifyAppFrom*` (app-lookup.server.ts) runs at scan time against static `APP_SIGNATURES`; no match → UnknownScript row written. Reading never re-attributes. Adding signatures only helps FUTURE scans.
- **The digest flywheel count bypasses the benign-library matcher** (operator-digest.ts:717 raw `db.unknownScript.count`) while every user-facing surface filters via `isBenignLibrary`. DRY violation → digest over-reports.
- **Deploy-swap lag false-fails the smoke gate** — see the saved global memory `ghost-code-smoke-sha-pin-false-fails-on-deploy-swap-lag`. Deploy job green + smoke red on SHA-pin mismatch = Railway hadn't cut over; `gh run rerun --failed <id>` after 1-2 min passes.
- Test setup (`tests/setup.ts`) unconditionally pins a non-routable dummy DATABASE_URL, so local `vitest` is safe from prod leaks (post-2026-08-29 guard).

## In-Progress / Open Work
- **gc-1we (P1, in_progress but UNTOUCHED all session):** external dead-man's-switch — Railway cron evaluates cron heartbeats independent of Inngest (closes review H3). Fresh pickup; H3 code is live-inert, Railway cron wiring pending (see gc-9jw).
- **Digest-count DRY fix (DECIDED, NOT BUILT):** add model helper `countNewUnknownScripts(windowStart)` to `app/models/unknown-script.server.ts` (fetch urls, filter via `isBenignLibrary`, count — mirror `getUnknownScriptsForScan`), swap it into operator-digest.ts:717. Dispatch to a subagent per orchestrator-only rule. Not yet filed as a bead.
- **gc-3sb follow-up P3 (filed):** smoke.mjs should poll-until-SHA-match instead of single check, and stop printing "✓ all checks green" on a SHA-mismatch exit-1.

## Uncommitted Changes
- None. Working tree clean, main == origin/main @ 5e41ce5.

## Open Questions / Loose Ends
- **5 orphan `worktree-agent-*` local branches** (unmerged, no worktrees attached, likely abandoned). Left in place — force-delete (`git branch -D`) only if confirmed abandoned. Also 3 WIP locals kept: docs/refresh-submission-screenshots, docs/s30-planning-handoffs, fix/scan-detail-health-tile.
- **Remote branch debt:** ~25 stale `origin/*` branches — deferred (outward-facing, pre-existing, needs a deliberate pass).
- **Inert flywheel:** the signature-submission flywheel has never turned (0 submissions in app lifetime). Open product question whether to invest in the merchant submission UI or cut the feature — not filed.

## Recommended Next Steps
1. **gc-1we (P1)** — external dead-man's-switch; the highest-priority real remaining work. Wire the Railway cron to evaluate heartbeats independent of Inngest.
2. **Digest-count DRY fix** — file bead + dispatch the `countNewUnknownScripts` helper (small, decided).
3. Optional hygiene: force-clean the 5 orphan worktree-agent branches; a deliberate remote-branch pruning pass.

## Risks & Warnings
- **gc-rrh.3 enum migration is live** (DUPLICATE_TRACKER, OVERLAPPING_CHAT_WIDGET added to FindingType). Any future branch predating it needs `npx prisma generate` after switch or phantom typecheck errors.
- **Attribution forward-fix caveat**: don't expect the 47 stored unknowns to reclassify — they won't until those stores re-scan.
- Beads Dolt `bd dolt push` returns "no store available" (shared-server quirk); bead state is recorded locally regardless.
