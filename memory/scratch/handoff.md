# Session 7 Handoff: P3 Polish Sprint

**Date**: 2026-03-11
**Project**: ~/shopify-ghost-code
**Epic**: shopify-ghost-code-6gh (Ghost Code MVP)
**Last commit**: `97319b6` (feat: app signatures) — but 5 tasks' changes uncommitted

---

## What Got Done

Full P3 sprint: 8/8 beads closed. 473 tests (up from 439). Zero rework.

### Quick Wins (3)
- **.74**: Replaced 2 raw `<a>` tags with Polaris `<s-link>` in scan detail
- **l4l**: Fixed countScansForShopSince to filter COMPLETED + IN_PROGRESS only (FAILED scans no longer consume free-tier quota)
- **.68**: Removed 7 dead exports across 6 files (IS_BILLING_TEST, PlanName, PlanFeatures, updateShopPlan, canUseMultipleThemes, Theme, fetchThemes)

### Optimizations (2)
- **.70**: Scan detail loader skips findings JOIN for free-tier shops (getScanById now accepts `{ includeFindings }`)
- **.69**: Fan-out refactor of poll-theme-changes: coordinator + poll-check-shop worker with concurrency limit 5

### Features (2)
- **.71**: CSV/JSON findings export at `/app/scans/:id/export?format=csv|json` with download button on scan detail
- **.72**: Weekly scheduled scan for Standard plan (Sunday 6 AM UTC) reusing poll-check-shop worker; `scheduledScan` feature flag added to PlanFeatures

### Data (1)
- **.73**: 12 new app signatures added (54 total): Swym, FOMO, Hextom, Weglot, Currency Converter, AccessiBe, Kiwi Sizing, Loop Returns, Narvar, Vitals, Appikon, Ageify

### Review Findings (filed as beads)
- **f49** (P2): Date comparison in poll-check-shop.ts relies on implicit ISO string coercion after Inngest step.run() serialization — wrap in new Date()
- **snq** (P3): weekly-scan.ts JSDoc claims cron is "offset" from daily but both fire at 06:00 UTC
- **e3v** (P3): billing.test.ts missing scheduledScan assertions

### Retro
- Implementer learnings pruned 55→48 (7 archived)
- 2 new workflow learnings in MEMORY.md (worktree commit gap, Explore agent cost)

---

## Key Decisions

1. **Scan quota filter: COMPLETED + IN_PROGRESS** (l4l): Excludes FAILED (no value delivered) and PENDING (not yet started). IN_PROGRESS prevents concurrent scan spam. User approved Option C.
2. **Fan-out over sequential loop** (.69): Coordinator sends batch events, worker processes per-shop with concurrency: 5. Trades single-function simplicity for scalability + independent retries.
3. **Worker reuse for weekly scan** (.72): Standard weekly and Professional daily coordinators both fan out to the same poll-check-shop worker. Plan filtering stays in coordinators.
4. **Export as resource route** (.71): No UI component — just a loader returning Response with Content-Disposition: attachment. Gated on canViewFindingDetails (Standard+).

---

## Uncommitted Changes

**CRITICAL**: 5 of 8 sprint tasks left changes uncommitted. These are staged in the working tree but NOT committed to main:

| Area | Files | From Task |
|------|-------|-----------|
| Scan status filter | scan.server.ts, scan.server.test.ts | l4l |
| Lazy-load findings | scan.server.ts (getScanById), app.scans.$scanId.tsx | .70 |
| Cron fan-out | poll-theme-changes.ts, poll-check-shop.ts (new), events.ts, api.inngest.ts, tests | .69 |
| Findings export | app.scans.$scanId.export.tsx (new), tests (new), app.scans.$scanId.tsx (button) | .71 |
| Weekly scan | weekly-scan.ts (new), tests (new), billing.server.ts, pricing doc | .72 |

**Also uncommitted**: retro outputs (learnings, archive, retro-history, MEMORY.md), sprint checkpoint.

All 473 tests pass. Safe to commit as a batch or per-feature.

---

## Cumulative Project State

- **92 beads**: 81 closed, 10 open (ready), 1 blocked (k82)
- **473 tests** across 24 test files
- **~64 commits** on main (3 this session + uncommitted)
- **App signatures**: 54 known apps

---

## What's Next

### Immediate (next session start)
1. **Commit uncommitted sprint changes** — batch or per-feature commits for the 5 tasks above

### P1 — Deploy Blockers (3)
| Bead | Title | Notes |
|------|-------|-------|
| .66 | Update shopify.app.toml with Railway production URL | Needs Railway project setup |
| .67 | Add Sentry error reporting | Previously deferred by user |
| k82 | Apply Prisma migration (lastThemePublishAt) | Blocked on .66 |

### P2 — Review Fixes + Pre-Launch (4)
| Bead | Title | Notes |
|------|-------|-------|
| f49 | Fix Date comparison in poll-check-shop.ts | Wrap in new Date() for Inngest serialization safety |
| rb3 | Active upsell: notify on skipped auto-rescan | Marked post-launch |
| .39 | Create app review submission package | Manual: screenshots, listing copy |
| .40 | Run performance + compatibility audit | Needs running app |

### P3 — Polish (3)
| Bead | Title | Notes |
|------|-------|-------|
| e3v | Add scheduledScan assertions to billing.test.ts | Trivial |
| snq | Fix misleading offset comment in weekly-scan.ts | Trivial |
| sg5 | Pro: auto-scan on app uninstall | Feature work |

---

## Open Questions

None carried forward. The scan quota decision (l4l) was resolved this session.

---

## Team State

| Member | Lines | Status | Notes |
|--------|-------|--------|-------|
| implementer | 48 | active | 6 new, 7 archived this session |
| tester | 43 | steady | Approaching cap; prune if dispatched next |
| scaffolder | 30 | steady | No changes |
| reviewer | 27 | steady | No changes |
| debugger | 24 | cold | Never dispatched |
