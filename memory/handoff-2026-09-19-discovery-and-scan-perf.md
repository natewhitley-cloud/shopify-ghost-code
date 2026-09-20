# Handoff — 2026-09-19 — Discovery/GTM + scan-perf v1 (DEPLOYED)

Long session. Two arcs: (1) App Store discovery instrumentation + competitive/roadmap work, (2) scan-perf v1 shipped end-to-end (impl → adversarial audit → fix → bundled deploy → green).

## SHIPPED — live on main @ d65baa5 (Deploy + CI both green, smoke passed)

Bundled deploy `5e41ce5 → d65baa5` (perf + UX + docs in one GH run):
- **Scan perf v1 (gc-1bd, CLOSED):** consolidated the THREE separate product-catalog walks (tags/prices/metafields) into ONE `fetchProductAuditData` pass feeding 3 detectors in a single Inngest step. Plus per-phase timing instrumentation (scan_signal metadata: phaseMs, pageCounts, throttleSleepMs, truncatedWalks) and centralized caps (`app/lib/scan-limits.ts`: PRODUCT_AUDIT_CAP=500, REDIRECT_CAP=1000). Commits 28fe8c6, ec46318, f669d47.
- **Scan progress UX (gc-rzq CLOSED + gc-smi CLOSED):** live findings count in the "Scan In Progress" state (`scanProgressLabel`, reads the incremental findingCount the loader already returns + 3s poll) + honest duration copy ("usually under a minute, but several minutes with Product/Page/Redirect checks or a large catalog"). Commit 46af8bd. NO Inngest change.
- 2 docs commits (175c13f competitive/GA4, b3e071f) flushed in the same push.

### Why scan perf mattered (measured this session)
Same shop/theme A/B on nw-dev-store-2: read_themes-only scan = 7-68s; scope-gated audits ON = 317s; all-on = 476s and FAILED. The scoped audits added ~250-410s and found ZERO extra findings (cost is structural — walk the whole catalog to check). Long scans also FAIL (reliability). Root cause = 3 redundant product-catalog walks. Consolidation is the fix.

### Adversarial audit caught a real regression → fixed (Option C)
Audit CONFIRMED: the initial Option-4 "observable caps" marked a TRUNCATED walk as a skippedCategory; `diffScans` filters previous-by-skipped but not current → a >500-SKU (or >1000-redirect) store would report the same findings as "new" EVERY scan forever. **Nathan chose Option C: truncation is telemetry-only, NOT a skippedCategory** (fix f669d47, with a non-vacuous regression test proven to fail on pre-fix code). Core consolidation was verified SOUND (detection-equivalent, idempotent, 4MB-safe, failure-isolated). Follow-up = **gc-dsh (P3)**: window-aware truncation diffing (Option B), only worth it once real large-catalog merchants exist.

## SHIPPED — App Store discovery (no deploy)
- **GA4 listing tracking** wired (Measurement ID + API secret + 5 event-scoped custom dims incl `surface_type`). Data flows ~24h. Reusable for the other 3 apps. Memory: `ga4-shopify-listing-tracking.md`.
- **Listing SEO** retuned (tagline/intro/details "page speed" swap/bullet) — Nathan applied. Category stays `Site optimization → Other` (no better leaf exists; confirmed). Biggest discovery lever is REVIEWS (at 0), not text.
- **Agentic AI epic (gc-47c, now P1) LIVE-VERIFIED** (gc-xel CLOSED): scoped detectors run clean end-to-end when Products/Pages/Redirects granted. `GHOST_PRICE` ran but 0 findings (theme has no bad schema price) → positive-case still only unit-tested → follow-up bead to seed a fixture.
- **Competitive intel** logged (marketing-plan.md §6d): new entrants Residue ($49/yr, auto-remove), ScriptSweep (free, detection-only, claims page-weight), Upright Cleaner (unverified listing, closest to our method, working the forum content-marketing lane). All still 0 reviews — review race open.

## OPEN BACKLOG (priority order)
- **gc-1we (P1)** — external dead-man's-switch. STILL untouched across many sessions. Genuinely next.
- **gc-47c (P1)** — advance agentic epic; immediate next = seed bad-schema-price fixture (filed follow-up) to prove GHOST_PRICE positive case, then more detectors.
- **gc-qrf (P3)** — the ONE remaining FP-suppression gap: scan-history list count not ignore-filtered (`app.scans._index.tsx:243`). Core FP-suppression already shipped (PR#24).
- **gc-dsh (P3)** — Option-B window-aware truncation diffing (only when large-catalog merchants exist).
- **gc-0ej (P3)** removal instructions; **gc-rch (P3)** removal-safety labels; FP-telemetry flywheel (unfiled decision).
- Digest-count DRY fix (countNewUnknownScripts) — decided, unbuilt, unbeaded.

## STATE
- Working tree: 1 unpushed docs commit incoming (this handoff note — held back per docs-burn-a-deploy; gc-cpa would add path-ignore). origin/main = d65baa5.
- Feature branches feat/gc-1bd-scan-perf + feat/gc-rzq-scan-progress are merged into main (can be deleted).
- All session beads reconciled.
