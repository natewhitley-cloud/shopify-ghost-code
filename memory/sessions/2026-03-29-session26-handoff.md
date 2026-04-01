## Session Handoff: 2026-03-29 (session 26) — Stale Scan Watcher, Theme Picker, Trend Chart

### What Got Done

1. **Stale scan watcher cron** — new Inngest function (`watch-stale-scans`) runs every 10 min. Checks for PENDING/IN_PROGRESS scans older than 15 min, auto-fails them so merchants can retry. No-ops when nothing is stuck. 11 tests.
2. **Theme picker** — Professional plan merchants can now select any theme to scan from a dropdown on the dashboard. Standard plan sees a disabled picker with upgrade nudge. Free plan sees nothing. Server-side validation prevents unauthorized theme selection. `fetchAllThemes()` service added. 22 tests.
3. **Health score trend chart** (feature-flagged) — inline SVG bar chart showing health score progression across last 7 completed scans. Trend direction indicator (Improving/Declining/Stable). Gated to Standard and Professional plans. Feature-flagged behind `ENABLE_TREND_CHART=true` env var — zero DB cost when off. 69 tests.
4. **Backlog cleanup** — closed 5 stale beads (LLC, deploy epic, E2E test, support email, deploy errors)
5. **Retro completed** — 3 durable learnings persisted to MEMORY.md

### Key Decisions

- **Theme picker UX by plan tier**: Free = hidden entirely, Standard = shown but disabled with upgrade nudge, Professional = fully functional. Rationale: shows Standard users what they're missing without cluttering Free experience.
- **Trend chart: last N scans, not calendar buckets**: Chart shows 7 most recent completed scans regardless of when they occurred. No weekly/monthly aggregation. Rationale: scan frequency already varies by plan; dates on x-axis communicate cadence naturally.
- **Feature flag for trend chart**: `ENABLE_TREND_CHART=true` env var. User wanted live feedback before exposing the chart to all merchants. Zero cost when off.
- **Trend direction thresholds**: Improving = newest > oldest + 3, Declining = newest < oldest - 3, Stable = within +/- 3 points.
- **Stale scan threshold**: 15 minutes, watcher runs every 10 minutes. 15 min is generous for slow themes but tight enough to unblock merchants quickly.

### In-Progress Work

None — all work completed, working tree clean.

### Uncommitted Changes

Only tackline session files — no code changes.

### Blocked Work

None blocked in beads.

### Open Questions

None — all design questions resolved during the session.

### Recommended Next Steps

1. **Check Shopify Partner Dashboard** for app review status (submitted session 25)
2. **When ready for trend chart feedback**: Set `ENABLE_TREND_CHART=true` in Railway (GC-ur6)
3. **After app approval**:
   - Set `SENTRY_DSN` in Railway
   - Flip `SHOPIFY_BILLING_TEST=false` in Railway
   - Update upgrade CTA link to App Store URL (GC-a9j)
4. **EIN retry** — try IRS online ~2026-04-01 or call 1-800-829-4933
5. **Remaining backlog**: GC-kis (trend chart parent — can close since implemented), GC-viy (spec bead — can close), GC-ngh (Prisma upgrade, P3), GC-a9j (post-approval CTA, P4)
6. **While waiting**: Start work on App 2 (bot-analytics-cleanup-app) or extract SVG trend chart to dedicated component (review suggestion)

### Risks & Warnings

- **`SHOPIFY_BILLING_TEST=true`** still set in Railway — MUST flip to `false` before going live
- **`SENTRY_DSN`** not set — Sentry is a no-op until configured
- **`ENABLE_TREND_CHART`** not set in Railway — trend chart is invisible until toggled on
- **Dashboard file growing** — `app._index.tsx` absorbed theme picker + trend chart inline. Review suggested extracting SVG chart to a component when flag is turned on.
- **Operating Agreement** still missing IP Assignment clause

---

## Handoff state

**Source**: /handoff
**Input**: Session 26 — stale scan watcher, theme picker, health score trend chart

### Items (5)

1. **Unfinished work** — 0 tasks in-progress
   - All work completed, app submitted and awaiting review

2. **Key decisions** — 5 decisions made this session
   - decisions: theme picker plan gating, last-N-scans (not calendar), feature flag for trend chart, trend direction thresholds, stale scan 15-min threshold
   - rationale preserved: yes — in handoff note + MEMORY.md

3. **Resumable agents** — none

4. **Open questions** — 0 unresolved

5. **Risks flagged** — 3 risks
   - risks: SHOPIFY_BILLING_TEST still true, SENTRY_DSN not set, ENABLE_TREND_CHART not set
   - confidence: CONFIRMED

### Summary

Session 26 was a productive feature session — 3 features shipped (stale scan watcher, theme picker, trend chart) with 69 net new tests across 3 commits. All code is committed and pushed. The trend chart is feature-flagged for live feedback gating. The app is still in Shopify's review queue from session 25. Next session should check review status and either address feedback or start on App 2 while waiting.
