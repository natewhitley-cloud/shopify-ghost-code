# Session 6 Handoff: P2 Monetization + Engagement Sprint

**Date**: 2026-03-10
**Project**: ~/shopify-ghost-code
**Epic**: shopify-ghost-code-6gh (Ghost Code MVP)
**Last commit**: `70bc5ee` (retro)

---

## What Got Done

Two back-to-back sprints: monetization (3 beads) + engagement/review fixes (6 beads). 13 commits, 439 tests (up from 397).

### Sprint 1: Monetization
- **Pro price $59→$49** (6jo): shopify.server.ts + app.settings.tsx
- **First scan free** (ek4): hasCompletedScans() bypass in plan-gating, dashboard messaging
- **Free-tier finding preview** (acw): getHighestSeverityFinding(), scan detail shows count + categories + 1 full finding + upgrade banner

### Sprint 2: Engagement + Review Fixes
- **Pricing doc fixes** (qvd + 9cc): Stale $59 text, category label mismatch
- **DRY FindingRow** (87m): Extracted shared components in scan detail
- **Theme Health Score** (2oz): health-score.ts pure function, dashboard hero card + delta, scan detail inline
- **Monthly rescan nudge** (3nf): Standard plan banner when >30 days since last scan
- **Theme change nudge** (rol): lastThemePublishAt on Shop, themes/publish records it, dashboard banner

### Test Coverage Added
- 8 tests: hasCompletedScans + getHighestSeverityFinding
- 30 tests: computeHealthScore (20), getDistinctFileCount (5), updateThemePublishTimestamp (5)
- 1 test mock fix: themes/publish webhook missing new export

### Cumulative Project State
- **73/88 beads closed** (83%)
- **439 tests** across 21 test files
- **61 commits** on main

---

## Key Decisions

1. **First scan free as gating-layer concept**: Lives in plan-gating.server.ts (hasCompletedScans), not in billing PlanFeatures. It's a one-time bypass, not a plan feature.
2. **Health score computed at display time**: No schema change needed. getDistinctFileCount() + severity counts → pure function. Cheap query, always fresh.
3. **Theme change nudge via themes/publish**: Shopify doesn't webhook other app installs. themes/publish is the closest proxy. Required adding lastThemePublishAt to Shop schema.
4. **Upgrade banner suppressed at 1 finding**: "0 more findings" was confusing — when only 1 finding exists, the preview IS the full picture.

---

## Pending Migration

**CRITICAL**: `prisma/schema.prisma` has `lastThemePublishAt DateTime?` on Shop but migration was NOT applied.

```bash
npx prisma migrate dev --name add-shop-theme-publish-timestamp
```

The Prisma client was regenerated with dummy DATABASE_URL so types compile, but the column doesn't exist in any database yet. The app will error on `lastThemePublishAt` reads until migration runs.

---

## What's Next

### P1 — Deploy Blockers (2)
| Bead | Title | Notes |
|------|-------|-------|
| .66 | Update shopify.app.toml with Railway production URL | Needs Railway project first |
| .67 | Add Sentry error reporting | Deferred by user |

### P2 — Pre-Launch (3)
| Bead | Title | Notes |
|------|-------|-------|
| rb3 | Active upsell: notify on skipped auto-rescan | Marked post-launch |
| .39 | Create app review submission package | Manual: screenshots, listing copy |
| .40 | Run performance + compatibility audit | Needs running app |

### P3 — Polish (8)
l4l (scan count status filter), sg5 (auto-scan on uninstall), .73 (app signatures), .74 (Polaris link), .69 (cron optimization), .70 (lazy-load findings), .71 (export), .72 (scheduled scan), .68 (dead exports)

---

## Open Questions

- **countScansForShopSince status filter** (l4l, P3): Counts all statuses toward monthly free quota. FAILED scans consume a free user's scan. Intentional anti-abuse or bug? Decision: does a failed scan = "value delivered"? If no, add `status: COMPLETED` filter.

---

## Team State

| Member | Lines | Status | Notes |
|--------|-------|--------|-------|
| implementer | 49 | active | Pruned 56→49 this session. 5 new entries. |
| tester | 44 | active | 2 new entries. Approaching 50-line threshold. |
| scaffolder | 30 | steady | No changes this session |
| reviewer | 27 | steady | No changes this session |
| debugger | 24 | cold | Never dispatched |
