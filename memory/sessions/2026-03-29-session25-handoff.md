## Session Handoff: 2026-03-29 (session 25) — Screencast, Screenshot Fixes, App Submitted

### What Got Done

1. **Screencast recorded** — Pro tier demo flow (dashboard → scan → results → findings → impact map → CSV export → settings), uploaded to YouTube unlisted, URL pasted in Partner Dashboard
2. **Screenshot fixes** — Shopify AI listing check flagged pricing text ("Upgrade Plan", "Unlimited scans on your plan"). Retook screenshots 03 and 11 with pricing text blurred/removed, resized to 1600x900, uploaded to Partner Dashboard
3. **App submitted for Shopify review** — all listing fields, screenshots, screencast, pricing, legal URLs complete
4. **DB housekeeping** — toggled plan between Free/Professional for screenshots, cleaned stuck/failed scan records
5. **Inngest dev server** — debugged connectivity (needed `-u` flag to point at app serve endpoint)
6. **Retro completed** — 2 durable learnings persisted to MEMORY.md

### Key Decisions

- **Pro-only screencast**: Showed full Pro experience only (not free tier). Shopify reviewers want to see the app's value, not the paywall.
- **Blur over crop for pricing text**: Blurred plan-related text in screenshots rather than cropping or retaking without those UI elements visible. Faster and preserves screenshot context.
- **Ignored app name AI flag**: Shopify AI flagged "Ghost Code" as potentially generic. It's a brand name, not a description — left as-is for human reviewer to assess.

### In-Progress Work

None — all work completed, working tree clean (only tackline session files uncommitted).

### Uncommitted Changes

Only tackline session management files — no code changes.

### Blocked Work

None blocked in beads. EIN still blocked on IRS processing (ref #101, retry ~2026-04-01).

### Open Questions

- **Review timeline**: Shopify app review typically takes 3-7 business days. No action needed until response.
- **Sentry DSN**: Still placeholder — create account and set `SENTRY_DSN` in Railway when ready.

### Recommended Next Steps

1. **Wait for Shopify review response** — monitor Partner Dashboard for feedback or approval
2. **If rejected**: Address reviewer feedback, resubmit. Common rejection reasons: billing flow issues, missing functionality, performance concerns.
3. **EIN retry** — try IRS online ~2026-04-01 or call 1-800-829-4933
4. **Post-approval tasks**:
   - Set `SENTRY_DSN` in Railway
   - Flip `SHOPIFY_BILLING_TEST=false` in Railway
   - Update upgrade CTA link to App Store URL (GC-a9j, P4)
   - EIN → bank account → W-9 to Shopify (for payouts)
5. **While waiting**: Start work on App 2 (bot-analytics-cleanup-app) or tackle remaining P2-P3 backlog items

### Risks & Warnings

- **`SHOPIFY_BILLING_TEST=true`** still set in Railway — MUST flip to `false` before going live
- **`SENTRY_DSN`** not set — Sentry is a no-op until configured
- **Dev store has test data** — plan set to Professional via DB override, some scan records from E2E testing
- **Operating Agreement** still missing IP Assignment clause

---

## Handoff state

**Source**: /handoff
**Input**: Session 25 — screencast, screenshot fixes, app submitted for review

### Items (5)

1. **Unfinished work** — 0 tasks in-progress
   - All work completed, app submitted

2. **Key decisions** — 3 decisions made this session
   - decisions: Pro-only screencast, blur pricing text in screenshots, ignore app name AI flag
   - rationale preserved: yes — in handoff note + MEMORY.md

3. **Resumable agents** — none

4. **Open questions** — 1 unresolved
   - questions: Shopify review timeline and outcome
   - blockers: external (Shopify review team)

5. **Risks flagged** — 2 risks
   - risks: SHOPIFY_BILLING_TEST still true, SENTRY_DSN not set
   - confidence: CONFIRMED

### Summary

Session 25 was the final submission push. Recorded the screencast, fixed screenshots flagged by Shopify's AI listing check, and submitted the app for review. Ghost Code is now in Shopify's review queue. The next session should check Partner Dashboard for review status. If approved, flip `SHOPIFY_BILLING_TEST=false` and set `SENTRY_DSN` in Railway before going live. While waiting, the backlog has 9 ready items (P1-P4) or work can shift to App 2 (bot-analytics).
