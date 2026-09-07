# Epic: Theme-library intelligence

**Epic ID**: gc-tus
**Created**: 2026-09-07
**Source**: /blossom
**Goal**: Turn recurring third-party-library noise in scan results into (A) suppression of benign CDN libraries and (B) a new merchant value signal (duplicate/conflicting library versions). Grounded in the 2026-09-07 weekend scan of store a3dea9-9f: 7 unknown scripts = Swiper v11 (x2), Swiper v8, vanilla-lazyload v19.1.3 (x2), simple-parallax-js v5.5.1, Google Fonts — all via cdn.jsdelivr.net + fonts.googleapis.com. None are apps; none are ghost code.

## Key Findings (from 4 spikes, all CONFIRMED w/ file:line)

- **Benign-CDN allowlist already half-exists**: `SHARED_CDN_DOMAINS` / `isSharedCdnDomain` (scan-engine.server.ts:2348-2360) is used ONLY by `detectGhostPreconnect`; the unknown-script collectors never call it.
- **Single chokepoint**: `collectUnknownScripts` (scan-engine.server.ts:1481-1510) + `collectUnknownStylesheets` (:1516-1547). They skip known-apps (identifyAppFrom*) and Shopify hosts, but NOT shared CDNs. Each external URL is Finding XOR UnknownScript.
- **Do NOT extend AppSignature with isLibrary** — would make ~17 detectors emit false GHOST_SCRIPT findings. Use a SEPARATE library module. Precedence: app -> library -> unknown.
- **FP-critical**: host-only allowlist of jsdelivr/unpkg is UNSAFE (they serve arbitrary code). Use package-PATH matchers (/npm/<pkg>@) for shared CDNs; host-only only for font hosts. Honor no-/g .test() rule.
- **Drop-at-collection** needs no migration; delete+recreate write path self-heals old scans on re-scan; digest count (raw db.unknownScript.count, operator-digest.ts:663) self-heals in 24h. Non-self-healing tails: merchant per-scan view + already-submitted benign SignatureSubmissions.
- **Thread B FindingType blast radius**: new DUPLICATE_LIBRARY = 10 source files + 1 additive migration + 5 count tests (27->28), incl. the EXTRA CROSS_FILE_FINDING_TYPES touch (cross-file detector). Client modules use string-literal keys, never enum VALUE import.
- **Thread B v1 viable URL-only** (weekend case all jsdelivr, parseable): cross-file Pass 5, group by (library, major), flag same-library different-MAJOR only, HEURISTIC / MEDIUM / "speed" lane.
- **A<->B interaction**: B2's detector must read RAW script URLs BEFORE A1 suppression, else A1 blinds it.

## Task IDs

| BD ID | Title | Priority | Status | Depends on | Agent |
|-------|-------|----------|--------|-----------|-------|
| gc-tus.5 | [A1] Suppress benign libraries in unknown-script collectors | P1 | open | none (ready) | implementer — scan-engine.server.ts + new lib module + tests |
| gc-tus.7 | [B1] Add DUPLICATE_LIBRARY FindingType (enum+migration+maps+tests) | P2 | open | none (ready) | implementer — FindingType blast-radius, prod-safe additive migration |
| gc-tus.8 | [B2] Cross-file duplicate-library detector (Pass 5) | P2 | open | gc-tus.7 | implementer — scan-engine.server.ts |
| gc-tus.6 | [A2] Clean up pre-existing benign data + drop-vs-telemetry | P3 | open | gc-tus.5 | implementer — unknown-script.server.ts, admin.submissions.tsx |
| gc-tus.9 | [B3] DUPLICATE_LIBRARY remediation copy + urgency (sign-off) | P3 | open | gc-tus.7 | product + implementer |
| gc-tus.10 | [B4] Extend detection to asset_url-hosted libs (content-sniff) | P3 | open | gc-tus.5 | implementer — cross-thread; speculative |

## Priority Order
1. gc-tus.5 [A1] P1 — quick win, mostly reuses existing helper, kills the noise problem
2. gc-tus.7 [B1] P2 — prereq for all of Thread B
3. gc-tus.8 [B2] P2 — the merchant value-add finding
4. gc-tus.6 [A2] P3 · gc-tus.9 [B3] P3 · gc-tus.10 [B4] P3

## Critical Path
gc-tus.7 [B1] -> gc-tus.8 [B2]  (FindingType must exist before the detector can emit it)

## Parallel Opportunities
- gc-tus.5 [A1] and gc-tus.7 [B1] are both ready NOW, disjoint files (collectors vs FindingType maps) — can run concurrently.
- After A1: gc-tus.6 and gc-tus.10 unblock. After B1: gc-tus.8 and gc-tus.9 unblock.
