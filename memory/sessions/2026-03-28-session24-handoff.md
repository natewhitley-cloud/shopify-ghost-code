## Session Handoff: 2026-03-28 (session 24) — Monitoring sprint + downgrade billing

### What Got Done

1. **Monitoring sprint — 5 beads closed** (GC-rqt, GC-lrq, GC-hsk, GC-8ib, GC-cxr):
   - Sentry scaffold (`app/lib/sentry.server.ts`) — @sentry/node with placeholder DSN, no-op fallback, wired into logger + Inngest middleware
   - Scan failure rate monitoring — `getFailureRateStats` in scan model + 6h Inngest cron with 10%/25% severity thresholds
   - Billing event metrics — `BillingEvent` Prisma model + migration + 3 model functions, wired into subscription webhook with fire-and-forget recording
   - Rate limit proximity alerting — stateless `checkThrottleStatus` + extensions wrapper, wired into `fetchThemeFiles`
   - Inngest failure notifications — `failureLoggingMiddleware` + `notifications.server.ts` scaffold with Slack/email TODOs
2. **Downgrade billing fix** (GC-rc0) — cross-portfolio gap identified by bot-analytics sprint:
   - "Switch to Standard" button on settings page when on Professional
   - `replacementBehavior: APPLY_ON_NEXT_BILLING_CYCLE` on Standard plan config
   - Cancel deep link to `shopify://admin/settings/billing`
3. **63 new tests** (1050 → 1113), 48 test files, zero TS errors
4. **Retro completed** — 2 durable learnings persisted to MEMORY.md

### Key Decisions

- **Hybrid metrics approach**: DB for billing events (queryable business data), structured logging for scan failure rate + rate limits (operational signals). Avoids unnecessary schema for ephemeral data.
- **replacementBehavior is plan-config, not per-request**: Set on Standard plan in shopify.server.ts so Pro→Standard downgrades defer to next billing cycle automatically.
- **Batched tester after full sprint**: More efficient than per-task — one pass fixed all 11 mock breaks + wrote 62 new tests.

### In-Progress Work

None — all beads closed, working tree clean.

### Uncommitted Changes

None — working tree clean.

### Blocked Work

None blocked in beads. EIN still blocked on IRS processing (ref #101, retry ~2026-04-01).

### Open Questions

- **Sentry DSN**: Placeholder scaffolded. User needs to create a Sentry account and set `SENTRY_DSN` in Railway before it activates.
- **Inngest `attemptNumber`**: The failure middleware declares `attemptNumber` in its type but Inngest's `transformOutput` hook doesn't expose retry count. May need `transformInput` hook or field removal.

### Recommended Next Steps

1. **E2E test on dev store** (GC-mfj.8, P2) — `shopify app dev`, install on dev store, run a clean scan end-to-end. Verify: dashboard → scan → results → settings → billing (including new downgrade button). Clean stale test data first.
2. **Capture screenshots** (1600x900) during E2E: dashboard, scan results, scan comparison, scan history, settings/billing (show all 3 plan tiles + downgrade button).
3. **Record screencast** (3-8 min) showing install → scan → results → settings. Upload to YouTube unlisted, paste URL in Partner Dashboard.
4. **Submit for app review** — all other Partner Dashboard fields are complete.
5. **EIN retry** — try IRS online ~2026-04-01 or call 1-800-829-4933.

### Risks & Warnings

- **`SHOPIFY_BILLING_TEST=true`** still set in Railway — MUST flip to `false` before going live
- **`SENTRY_DSN`** not set — Sentry is a no-op until configured (not a blocker, just not active)
- **Dev store may have stale test data** — clean before E2E and screenshots
- **Operating Agreement** still missing IP Assignment clause — not a submission blocker but a legal loose end
- **Implementer learnings at 58 lines** — run `/curate` early next session before dispatching

---

## Handoff state

**Source**: /handoff
**Input**: Session 24 — monitoring sprint + downgrade billing fix

### Items (5)

1. **Unfinished work** — 0 tasks in-progress
   - All 6 beads closed, working tree clean

2. **Key decisions** — 3 decisions made this session
   - decisions: hybrid metrics approach, replacementBehavior is plan-config, batched tester dispatch
   - rationale preserved: yes — in handoff note + MEMORY.md

3. **Resumable agents** — none

4. **Open questions** — 2 unresolved
   - questions: Sentry DSN (user action), Inngest attemptNumber field accuracy
   - blockers: none critical

5. **Risks flagged** — 3 risks
   - risks: SHOPIFY_BILLING_TEST still true, dev store stale data, implementer learnings near cap
   - confidence: CONFIRMED

### Summary

Session 24 completed the full observability stack (Sentry, scan failure rate, billing metrics, rate limit alerting, Inngest notifications) and fixed a missing billing downgrade path surfaced by a cross-portfolio sprint. The app is at 1113 tests, zero TS errors, billing lifecycle complete, and all automated Shopify checks passing. The only items blocking submission are visual assets (screenshots, screencast) which require an E2E test on the dev store. The next session should run `shopify app dev`, do a clean scan, capture screenshots/video, upload to Partner Dashboard, and submit.
