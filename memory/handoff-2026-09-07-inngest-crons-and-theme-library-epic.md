# Session Handoff: Inngest cron alerts + Theme-library intelligence epic (2026-09-07)

Prod: `9ed177e` on main. Health OK. Working tree clean (only untracked: `docs/gtm/listing-v2.md` — pre-existing, NOT this session's). No resumable agents (all 5 completed). No in-progress beads.

## What Got Done
1. **Diagnosed the `monitor-deep-health` "overdueCrons" alert emails.** Root cause = **Inngest platform "Degraded Function Execution" incident** (status.inngest.com), which paused crons long enough to trip the dead-man's-switch (grace = interval×2: watch-stale-scans 20m, monitor-deep-health 30m). NOT signing-key drift (PUT /api/inngest returned 200; key unchanged per Nathan), NOT a deploy (none that day), NOT concurrency (app was idle, 0 scans/8h). Self-healed. Verified live: all crons heartbeating, `getStaleCrons` = [].
2. **Shipped PR #18 (`f5bed50`, merged `9ed177e`, DEPLOYED + PUT-synced).** Capped `scan-theme` and `poll-check-shop` `concurrency: {limit:5}` → `{limit:3}` to reserve cron headroom on the shared 5-slot Inngest Hobby pool (shared across Ghost Code + ClearSignal + TaxDelta). CI green, 2338 tests, build passed, post-deploy smoke passed, `PUT /api/inngest` → 200 `modified:true` (limit:3 now registered/live).
3. **Investigated the weekend digest** (new store `a3dea9-9f`, 1 clean scan, 3 findings, 7 new unknown scripts). Pulled the 7 unknowns (read-only): all benign theme-dev deps — Swiper v11 (×2), Swiper v8, vanilla-lazyload v19.1.3 (×2), simple-parallax-js v5.5.1, Google Fonts — via cdn.jsdelivr.net + fonts.googleapis.com. Correctly NOT merchant findings; "0 submissions" is expected (submission is a human step).
4. **Ran /blossom → epic `gc-tus` "Theme-library intelligence"** (4 spikes, all CONFIRMED). Created 6 firm tasks, wired deps, validated (Swarmable YES). Epic state persisted to `memory/epics/gc-tus/epic.md`.

## Key Decisions
- **Concurrency cap = limit 3** (not upgrade plan / not separate accounts): cheapest proportionate fix at ~0 scan volume; reserves headroom without cost. (rejected: defer — Nathan wanted the latent risk closed; separate Inngest accounts — bigger lift, parked as durable option; Pro upgrade — premature.)
- **Thread A = drop-at-collection, NOT a schema label.** No migration; delete+recreate write path self-heals old scans on rescan, digest self-heals in 24h. (rejected: `UnknownScript.isBenign` column — needs migration + read-side filtering in 3+ consumers for purely-informational benefit.)
- **Thread A = SEPARATE library module, NOT `AppSignature.isLibrary`.** An isLibrary entry would make ~17 ghost detectors emit false GHOST_SCRIPT findings.
- **Thread A matching = package-PATH matchers for shared CDNs, host-only ONLY for font hosts.** Host-only allowlisting of jsdelivr/unpkg is unsafe (they serve arbitrary code).
- **Thread B = new `DUPLICATE_LIBRARY` FindingType**, HEURISTIC / MEDIUM / "speed" lane, flag same-library different-MAJOR only. v1 URL-only (public CDN), Thread-A-independent.

## Patterns & Discoveries
- **Benign-CDN allowlist already half-exists**: `SHARED_CDN_DOMAINS`/`isSharedCdnDomain` (scan-engine.server.ts:2348-2360) — used ONLY by detectGhostPreconnect, NOT the unknown-script collectors.
- **Single chokepoint** for both threads: `collectUnknownScripts` (:1481-1510) + `collectUnknownStylesheets` (:1516-1547). Skip known-apps + Shopify hosts, but NOT shared CDNs.
- **A↔B interaction (critical):** Thread A drops benign libs at collection; Thread B needs to SEE them to detect duplicates → B2's detector must run over RAW script URLs BEFORE A1 suppression, as an independent cross-file Pass 5 (not over the post-suppression UnknownScript array).
- **FindingType blast radius = 10 source files + 1 hand-authored ADDITIVE migration + 5 count-literal tests (27→28)**, incl. the EXTRA `CROSS_FILE_FINDING_TYPES` touch (finding-classification.ts:199) vs JSON_LD_PRICE_CONFLICT. Client modules: `import type` + string-literal keys, never enum VALUE import. Full file list in gc-tus.7 description + epic.md.
- **Cron dead-man's-switch triage** now has 3 triggers (memory updated): key drift (PUT→401) / platform outage (status.inngest.com, self-heals) / concurrency starvation (status green + scan burst).

## In-Progress Work
None. Clean stop.

## Uncommitted Changes
None (code). Committing this handoff note + `memory/epics/gc-tus/epic.md` as a docs(memory) commit. `docs/gtm/listing-v2.md` untracked is pre-existing, left alone.

## Resumable Agents
None — all 5 dispatched agents (1 impl + 4 blossom spikes) completed.

## Open Questions (deferred to implementation)
- **B3 (gc-tus.9) urgency tier**: `act-now` vs `whenever` for DUPLICATE_LIBRARY on the speed lane. Lean `whenever` (matches GHOST_PRECONNECT/GHOST_FONT). Criteria: product call on how aggressively to nudge. Copy must avoid "orphaned/uninstalled app" framing — say "consolidate to one version."
- **A2 (gc-tus.6) drop-vs-telemetry**: silent drop vs log/ops-event count of benign skips (codebase treats silent drops as anti-pattern). Decide during A2.
- **A1 allowlist breadth**: seed = jsdelivr/unpkg/cdnjs (path-matched) + fonts.googleapis/gstatic (host) + package matchers for swiper/vanilla-lazyload/simple-parallax. Extensible later via the existing crowd-sourced SignatureSubmission loop.

## Recommended Next Steps (NEXT SESSION)
1. **`/sprint gc-tus`** — dispatch **A1 (gc-tus.5, P1)** and **B1 (gc-tus.7, P2)** IN PARALLEL. Both ready, disjoint files (collectors vs FindingType maps). Load `memory/epics/gc-tus/epic.md` first for full spike detail.
2. After A1: gc-tus.6 (A2) unblocks. After B1: **gc-tus.8 (B2)** — the actual duplicate-library detector — unblocks; then gc-tus.9 (B3).
3. gc-tus.10 (B4, asset_url-hosted) stays parked unless a real scan shows an asset-vendored duplicate.

## Risks & Warnings
- **B1 is high-blast-radius** — missing one of the 10 maps/5 tests breaks the build (compiler-enforced maps catch most; count-literal tests catch the rest). Use the epic.md file list. Migration is hand-authored `ALTER TYPE ... ADD VALUE` — NEVER `migrate dev` (.env=PROD).
- **B2 must NOT read the post-A1-suppression unknown bucket** (see A↔B interaction) or A1 will blind it once both ship.
- No dev/staging — "live or it isn't." Verify via tests+build+smoke. Prod-safe additive migration only.
- Deploys auto-run on merge to main (self-migrating); a memory-only commit still triggers a Deploy (docs, harmless).
