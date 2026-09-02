# Epic: Agentic AEO finding types

**Epic ID**: gc-47c
**Created**: 2026-09-02
**Source**: /blossom
**Goal**: Detect old/outdated/orphaned theme code, metadata, and structured data (JSON-LD, robots, canonical, hreflang) left by uninstalled apps that now misleads AI shopping agents (ACP/UCP) and answer-engine crawlers — feeding them wrong price/availability/product or blocking them entirely. Evaluate as additional value / new market/ICP for Ghost Code.

## Feasibility verdict (the 5 questions the blossom answered)

1. **Detection** — mostly EXTENSIONS of existing detectors, not greenfield. `JSON_LD_CONFLICT` already `JSON.parse`s and flags competing same-`@type` blocks (duplicate-Product largely present); `detectGhostRobots` already reads `<meta name="robots">`. The new work is: read into `Offer.price/availability`, widen robots to AI-crawler user-agents, and parse `robots.txt.liquid` stanzas.
2. **Limitations** — GC sees the **theme SOURCE only**. It fetches every theme text file (incl. `templates/robots.txt.liquid`, `config/settings_data.json`) but has **zero storefront HTTP-fetch capability** (Admin-GraphQL-only). So rendered `/robots.txt`, root `/llms.txt`, ACP feed, and Merchant Center feeds are CONFIRMED out-of-reach.
3. **Scopes / PCD** — the buildable candidates (Offer JSON-LD conflict, duplicate Product, AI-crawler robots block, canonical/hreflang reframe) are **theme-file-only: NO new scope, NO PCD**. Only exception: comparing a stale theme price against the *live* product price would use `read_products` (already an optional scope, still not PCD).
4. **Feasibility/complexity** — new `FindingType` = 8 enforced layers / ~13 files incl. a Postgres enum migration + drift-guarded tests. **Reusing an existing enum keeps a change to ~1–2 files** — the dominant cost lever.
5. **Cheap → expensive** — copy reframe < AI-crawler meta (reuse GHOST_ROBOTS) ≈ duplicate-Product (reuse JSON_LD_CONFLICT) < Offer-conflict (new parse logic) < robots.txt.liquid parser (new type) < llms.txt (new fetch stack, OUT OF REACH).

**Correction:** `GHOST_PRICE` is Admin-API compare-at pricing, NOT JSON-LD — do NOT reframe it as agent-misleading.

## Spike Findings

See closed spikes gc-47c.1–.4 (bd notes) for full pipe-format reports with file:line evidence. Headlines:
- **.1 structured-data**: GHOST_JSON_LD = string/signature match only (reads no Offer fields); JSON_LD_CONFLICT already JSON-parses + flags competing @type. Blind spots: skips Liquid blocks, bails on `@graph`/array `@type`, only compares blocks[0].
- **.2 robots/crawler**: reads robots only from `<meta name="robots">`; `robots.txt.liquid` is fetched+scannable but unparsed. AI-crawler meta detection = cheap; robots.txt.liquid stanza parser = new build.
- **.3 access/scope**: read_themes reaches all theme text files; llms.txt/rendered-robots/feeds out-of-reach (no HTTP fetcher). a/b/c = theme-only, no scope/PCD.
- **.4 architecture**: 8-layer / ~13-file cost per new enum; reuse existing enums to stay ~1-2 files. Deeper gotchas: PG enum `ALTER TYPE ADD VALUE`, scan-differ `skippedCategories` coupling (only if new Admin-API type), operator-digest auto-adapts.

## Priority Order

| BD ID | Title | Priority | Status | Agent |
|-------|-------|----------|--------|-------|
| gc-47c.7 | Agentic so-what copy reframe (canonical/hreflang/robots/JSON-LD/conflict/dup-meta) | P1 | open | copy/UX |
| gc-47c.5 | Detect orphaned AI-crawler blocks via meta tags (+ AI_CRAWLER_USER_AGENTS) | P1 | open | scanner/detector |
| gc-47c.9 | Harden JSON_LD_CONFLICT: @graph + array @type + all-pairs | P1 | open | scanner/detector |
| gc-47c.8 | Extend JSON_LD_CONFLICT to detect conflicting Offer price/availability | P1 | open (blocked by .9) | scanner/detector |
| gc-47c.10 | DECIDE + build orphaned Product+Offer detection (static-vs-static vs static-vs-live) | P2 | open (blocked by .9) | scanner/detector + product |
| gc-47c.12 | GHOST_OG agentic reframe (og:price/availability) | P3 | open | copy/UX |
| gc-47c.6 | robots.txt.liquid stanza parser | **P4 PARKED** (Nathan 9/2) | open | — |
| gc-47c.11 | llms.txt / rendered-robots / feeds out-of-reach | **P4 PARKED** (Nathan 9/2) | open | — |

**GO-SET (approved 2026-09-02):** gc-47c.7, gc-47c.5, gc-47c.9 → gc-47c.8. Parked: .6, .11.

## Critical Path

gc-47c.9 (harden JSON-LD parse loop) → gc-47c.8 (Offer price/availability conflict) — the flagship "agent quotes the wrong price" detector. Everything else is parallelizable.

## Parallel Opportunities

Wave 1 (independent): gc-47c.7 (copy), gc-47c.5 (AI-crawler meta), gc-47c.9 (harden), gc-47c.6 (robots.txt.liquid), gc-47c.12 (OG). Wave 2 (after .9): gc-47c.8, gc-47c.10.

## Notes

- This epic is the AGENTIC FINDING-TYPES workstream. The broader "so what / now what" dashboard reframe (organize findings by merchant CONSEQUENCE: SEO/Speed/Customers-see-it/Privacy/AI-agents, with primary + secondary tags) is a SEPARATE, larger initiative discussed the same session — link but don't merge. gc-47c.7 is the bridge (it starts attaching agentic consequence copy to findings).
- Recommend shipping gc-47c.7 + gc-47c.5 first (cheap, immediate agentic value), then the .9→.8 flagship. Park .11.
