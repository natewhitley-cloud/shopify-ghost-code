# Session Handoff — Ghost Code Session 5 (P2 Audit Sprint)

**Date**: 2026-03-10
**Project**: ~/shopify-ghost-code
**Epic**: shopify-ghost-code-6gh (Ghost Code MVP)
**Last commit**: `c920369` (integration tests)

---

## What Got Done

P2 audit sprint: 15 tasks completed across 5 agent dispatches in 4 batches, 0 rework.

- **5 commits** on main (2 fix, 2 feat, 1 test)
- **15/15 P2 audit findings closed** (.50–.65)
- **397 tests passing** (up from 330, +20%) across 20 test files
- **9 new beads created** for remaining P1/P3 backlog tracking (.66–.74)
- **Retro completed** — 7 new learnings persisted (4 implementer, 3 tester)

### What Was Fixed (Security — 7)
- S-05: Auth ordering in scan detail loader (shop validated before scan fetch)
- S-06: Cascade delete Scan→Shop (Prisma schema + migration)
- S-07: TOCTOU race on double-scan (atomic $transaction guard in createScan)
- S-08: Poll cron includes PENDING in active-scan check
- S-09: Inline GraphQL in installed webhook → fetchMainTheme
- S-10: Idempotency guard for Inngest retry (deleteMany before createMany)
- S-14: Unused accessToken removed from poll cron

### What Was Built (Enhancement — 8)
- E-04: FAILED scan shows error state (not misleading zeros)
- E-05: IN_PROGRESS scan shows "scanning" placeholder
- E-06: Cursor-based pagination in scan history (20/page + Load More)
- E-08: Structured JSON logger across all 8 webhook handlers
- E-09: Stale TODO removed from api.inngest.ts
- E-10: 59 integration tests (scan pipeline, billing flow, GDPR)
- E-13: Manage subscription card for paid plan users
- E-14: Free plan scan usage indicator on dashboard

### Cumulative Project State
- **64/79 beads closed** (81%)
- **397 tests** across 20 test files
- **48 commits** on main
- All P0, all fixable P1, all P2 (code) complete

---

## What's Next

### P1 — Blocked on Deployment
| Bead | Title | Notes |
|------|-------|-------|
| .66 | E-01: Update shopify.app.toml with Railway production URL | Needs Railway project created first |
| .67 | E-07: Add Sentry error reporting | Deferred by user to post-deploy |

### P2 — Manual / Needs Running App
| Bead | Title | Notes |
|------|-------|-------|
| .39 | Create app review submission package | Screencast, listing copy, privacy policy |
| .40 | Run performance + compatibility audit | Needs `shopify app dev` running |

### P2 — Pricing Refinements (from earlier blossom)
| Bead | Title |
|------|-------|
| ek4 | Free tier: first scan free, then 1/month ongoing |
| acw | Free tier: preview single highest-severity finding |
| rb3 | Active upsell: notify when paid feature would have applied |

### P3 — Post-Launch Polish (7 items)
| Bead | Title |
|------|-------|
| .68 | E-11/E-12: Remove dead exports |
| .69 | E-15: Optimize sequential cron for scale |
| .70 | E-16: Lazy-load findings for free plan |
| .71 | E-17: Add findings export functionality |
| .72 | E-18: Add scheduled scan for Standard plan |
| .73 | E-19: Add missing app signatures to pattern DB |
| .74 | E-20: Replace raw `<a>` with Polaris s-link |

### Outside Beads
- GitHub repo creation + first push (user: natewhitley-cloud)
- Railway project setup + environment variables
- Run Prisma migration (S-06 cascade delete) after DATABASE_URL is set
- Shopify app deployment to dev store for testing
- Manual QA: billing flow, GDPR webhooks, scan pipeline end-to-end

---

## Key Decisions Made This Session

1. **Batch sizing**: 3-4 related tasks per agent. Confirmed as optimal — all 5 agents returned high confidence, zero rework.
2. **TOCTOU guard (S-07)**: Application-level $transaction, not DB-level partial unique index. Simpler, sufficient for expected concurrency. A DB index would be the final backstop at scale.
3. **Subscription cancellation (E-13)**: Shopify manages cancellation, not the app. Added info card linking to Shopify Admin billing settings rather than implementing a cancel mutation.
4. **Structured logging (E-08)**: Created `app/lib/logger.server.ts` with JSON output. Routes warn/error to stderr for Railway log severity parsing.
5. **Scan history pagination (E-06)**: Cursor-based with full-page navigation (not append). Simpler, and avoids client-side state complexity.

## Open Questions

1. **Install welcome scan vs free limit**: Does the auto-scan on install count against the free monthly limit? Currently it does. Decision criteria: conversion impact vs simplicity. See bead `ek4`.
2. **TOCTOU DB-level index**: Should we add a partial unique index `(shopId, status) WHERE status IN ('PENDING', 'IN_PROGRESS')` as a final backstop? Decision criteria: expected concurrent scan rate. Low priority unless scale testing reveals races.
3. **Implementer learnings curation**: At 48 lines, approaching 50-line warning. Run `/curate` on implementer before next sprint. Candidates for archive: dispatch .12/.13 (regex patterns), .41 (Inngest v3 specifics).

---

## Key Context for Next Session

1. **CWD matters**: Start with `cd ~/shopify-ghost-code`
2. **Deploy path**: GitHub push → Railway setup → run Prisma migration → update shopify.app.toml (unblocks .66) → `shopify app deploy`
3. **Curate before sprinting**: Run `/curate` on implementer learnings (48 lines, nearing cap) before dispatching more work
4. **Migration pending**: S-06 cascade delete migration needs `npx prisma migrate dev --name add-cascade-delete-scan-shop` with DATABASE_URL set
5. **Dirty working tree**: Memory files modified this session need committing (MEMORY.md, learnings, retro-history, handoff)

## Team State

| Member | Learnings | Lines | Status | Notes |
|--------|-----------|-------|--------|-------|
| implementer | ~34 entries | 48 | active | Curate before next sprint — approaching 50-line warning |
| tester | ~28 entries | 41 | active | 3 new entries this session (integration test patterns) |
| scaffolder | ~21 entries | 30 | steady | All infra complete |
| reviewer | ~18 entries | 27 | steady | Last dispatched in session 4 (audit) |
| debugger | ~13 entries | 24 | cold | Never dispatched — consider for S-07 DB index investigation |
