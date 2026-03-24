## Session 20 Retro: 2026-03-23/24

### Velocity

- **4 new detectors implemented** (GHOST_CANONICAL, GHOST_TITLE, GHOST_OG, GHOST_PRECONNECT)
- **2 new app signatures** added (Socialhead, SEO King)
- **+273 tests** (725 → 998), all passing
- **1 lightweight spec** written (`docs/specs/v1.3-seo-integrity-spec.md`)
- **1 Prisma migration** created (`20260324040259_add_seo_performance_finding_types`)
- **1 code review** run — 9 findings, all fixed before commit
- **1 commit** (`e287bbe`), pushed to main

### Quality

- All 998 tests passing, zero TypeScript errors
- Code review caught 2 real bugs (severity cross-contamination, inconsistent comment-block handling) before shipping
- Severity nuance rules implemented: GHOST_TITLE downgrades to MEDIUM when `page_title` present; GHOST_OG upgrades to HIGH for `og:image`
- Comment-block suppression made consistent across all 4 detectors using insideComment state machine pattern

### What Worked

1. **Spec-first approach** — writing detection heuristics, false positive boundaries, and regex patterns upfront reduced ambiguity during implementation. Higher false-positive risk detectors (SEO vs theme-native) benefit most from this.
2. **Sprint → review → fix cycle** — review caught severity cross-contamination and comment inconsistency before they shipped. Both were non-obvious bugs that would have caused false positives in production.
3. **Opportunistic scope addition** — pulling GHOST_PRECONNECT (v1.4) into the sprint was low-effort since it operates on the same `<head>` content as the SEO detectors.
4. **Serial subagent dispatch** continued to deliver clean results with no rework.

### What Could Improve

1. **Migration testing gap persists**: `--create-only` migration not applied locally. Railway auto-deploy may or may not run it successfully — need to verify.
2. **Uncommitted file sprawl**: Multiple sessions of uncommitted changes accumulating (specs, scripts, docs, session files). Should batch-commit housekeeping files periodically.
3. **Product strategy doc drift**: v1.2/v1.3/v1.4 sections mix shipped, killed, and open items. Needs reorganization.

### Learnings

- **Severity nuance rules should match against `description`, not `codeSnippet`**: The description contains the specific property name (e.g., `og:image`), while the snippet contains ±3 lines of surrounding context that may include unrelated tags. Matching against snippet causes cross-contamination where nearby tags trigger wrong severity rules.
- **Comment-block handling must be consistent across all detectors**: The insideComment state machine pattern from GHOST_PRECONNECT (tracking `<!--` open and `-->` close across lines) is the reference implementation. All 4 SEO/performance detectors now use this pattern.
- **GHOST_PRECONNECT is a natural companion to SEO detectors**: Both scan `<head>` content for app-attributed artifacts. Bundling them in one sprint avoids duplicate file-scanning logic.
