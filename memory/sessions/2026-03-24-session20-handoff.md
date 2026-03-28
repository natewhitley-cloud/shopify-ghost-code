## Session Handoff: 2026-03-24 (session 20) — SEO Integrity + Performance Detectors (v1.3 + v1.4a)

### What Got Done

1. **Lightweight spec written** for v1.3 SEO integrity detectors at `docs/specs/v1.3-seo-integrity-spec.md` — detection heuristics, false positive boundaries, regex patterns, test cases for GHOST_CANONICAL, GHOST_TITLE, GHOST_OG.
2. **4 new detectors implemented:**
   - GHOST_CANONICAL (HIGH) — orphaned canonical tags: empty href, unresolved Liquid vars, duplicates, app-attributed
   - GHOST_TITLE (HIGH) — orphaned title overrides: empty titles in layouts, unresolved vars, app-attributed, duplicates
   - GHOST_OG (MEDIUM, HIGH for og:image) — orphaned Open Graph/Twitter Card meta: empty content, unresolved vars, app-attributed
   - GHOST_PRECONNECT (MEDIUM) — orphaned preconnect/dns-prefetch/preload hints to known app CDN domains
3. **2 new app signatures** added: Socialhead, SEO King.
4. **Severity nuance rules** — GHOST_TITLE downgrades to MEDIUM when `page_title` present; GHOST_OG upgrades to HIGH for `og:image`.
5. **Code review run** — found and fixed 9 issues: comment-block handling consistency, severity cross-contamination, hoisted string splits, deduplicated buildSnippet calls, renumbered comments, removed unused property.
6. **Prisma migration created** (--create-only): `20260324040259_add_seo_performance_finding_types`.

### Key Decisions

- **Added GHOST_PRECONNECT (v1.4 item) to this sprint**: Low effort, operates on same `<head>` content as SEO detectors.
- **Spec-first for SEO detectors**: Higher false positive risk than prior detectors — distinguishing app-injected from native theme code requires explicit heuristics.
- **Comment-block suppression over severity-downgrade**: Findings inside HTML comments are suppressed entirely, consistent with GHOST_PRECONNECT pattern.

### DB Migrations (pending on Railway)

- `20260324040259_add_seo_performance_finding_types` — adds new finding type enum values

### Test Count

- 998 tests, all passing
- Zero TypeScript errors

### Commits

| Hash      | Description                                                             |
| --------- | ----------------------------------------------------------------------- |
| `e287bbe` | feat(scanner): add SEO integrity and performance detectors (v1.3+v1.4a) |

### Uncommitted Changes

Accumulated from prior sessions — not committed this session:

- `.specs/` modifications
- `scripts/review-submissions.ts` modifications
- `docs/product-strategy.md` updates
- `memory/sessions/` handoff files from sessions 15-19
- `.claude/tackline/` session files

### Open Backlog

**Pre-launch (P1-P2):**

- GC-ue5 (P1): Form legal entity (LLC)
- GC-mfj (P1 epic): Deploy — 1 subtask (E2E test)
- GC-ehc (P2): Set up support email
- GC-mfj.8 (P2): E2E test in dev store
- GC-qys (P2): Better deploy error messages

**Scanner expansion (sprint-ready):**

- GC-25n (P3): Settings data drift
- GC-lxk (P3): Inline tracking pixel detection
- GC-azd (P3): JSON-LD conflict detection
- GC-6m7 (P3): Page builder layout duplication

**Other P3:**

- GC-nmc: Theme picker
- GC-kis: Health score trend chart
- GC-ngh: Prisma 6→7 upgrade

### Recommended Next Steps

1. **Verify Railway migration** — check `railway logs` to confirm `20260324040259_add_seo_performance_finding_types` applied successfully. New finding types are in the enum but migration may not have run yet.
2. **Update product strategy doc** — mark v1.3 items as shipped, reorganize v1.2/v1.3/v1.4 sections into shipped vs planned vs killed.
3. **Form LLC** (GC-ue5) → support email → legal docs → E2E test → submit for app review.
4. **v1.4 remaining items** (GHOST_FONT, GHOST_AJAX) if there's time before app submission.
5. **Batch-commit housekeeping files** — specs, scripts, docs, session files accumulating across sessions.

### Risks & Warnings

- **Railway migration pending** — `20260324040259_add_seo_performance_finding_types` needs to be applied. Railway auto-deploys from main, so the code is live but enum values may not be in the DB yet.
- **Dev store theme has synthetic artifacts** — clean before E2E or app review.
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist.
- **Product strategy doc partially stale** — shipped/killed/open items mixed together in v1.2/v1.3/v1.4 sections.
- **Uncommitted file sprawl** — multiple sessions of uncommitted changes. Risk of merge conflicts or stale content if not addressed.
