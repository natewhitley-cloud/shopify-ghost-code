## Session Handoff: 2026-03-28 (session 23) — Signatures + code review + pre-submission fixes

### What Got Done

1. **Added 6 targeted app signatures** (107 → 113) — Smart SEO, Schema Plus for SEO, Yoast SEO, ShopLift (new A/B Testing category), Bold breakout (Options/Upsell/Discounts replacing single Bold Commerce entry)
2. **Full codebase /review** — 5 warnings, 4 test gaps, 2 nitpicks, 5 monitoring suggestions identified
3. **Fixed all 5 warnings** — billing isTest uses SHOPIFY_BILLING_TEST env var, Prisma query moved to model layer, unbounded query fixed with DB-level filter, scan detail loader parallelized (Promise.all), FINDING_TYPE_LABELS completed (10 → 26 types)
4. **Fixed 2 nitpicks** — scan timeout mechanism added (expireStaleScans in daily cron), stray `// test` comment removed
5. **Added 24 new tests** (1026 → 1050) — CSV injection edge cases, deleteShopData cascade, webhook invalid payload, scan expiry
6. **Created 5 monitoring backlog beads** — Sentry, scan failure rate, billing metrics, rate limit alerting, Inngest notifications (all P3/P4, deferred)
7. **Retro completed** — 3 durable learnings persisted, retro history updated

### Key Decisions

- **Billing isTest switched to dedicated env var**: `SHOPIFY_BILLING_TEST` instead of `NODE_ENV`. Gives explicit control without changing deployment config. `.env.example` already had the var documented, code now reads it.
- **Signature gaps prioritized by market research**: Used switching analysis data (strategy/market-research/) to identify highest-value gaps. SEO apps and ShopLift chosen over other candidates because SEO impact is core to Ghost Code's value prop.
- **Bold breakout into 3 individual signatures**: Better attribution for merchants who use specific Bold products. Shared `bold-common.liquid` snippet appears in all three entries.
- **Monitoring deferred to post-launch**: 5 observability beads created but not prioritized for submission. Correct call — app review doesn't test monitoring.

### In-Progress Work

- **GC-ue5 (P1)**: LLC formed, needs IP Assignment clause added to Operating Agreement and EIN obtained (retry IRS ~2026-04-01)
- **GC-mfj.8 (P2)**: E2E test on dev store — not started, blocks screenshots/screencast/submission

### Uncommitted Changes

None — working tree clean (retro history committed and pushed).

### Blocked Work

None blocked in beads. EIN blocked on IRS processing (ref #101).

### Open Questions

- **Operating Agreement IP clause**: Text is in `strategy/llc-setup-guide.md` Step 4. User needs to manually add, sign, and file. Not a code task.

### Recommended Next Steps

1. **E2E test on dev store** — `shopify app dev`, install on dev store, run a clean scan, verify all flows (dashboard → scan → results → settings → billing)
2. **Capture screenshots** (1600x900) during E2E: dashboard, scan results, scan comparison, scan history, settings. Upload to Partner Dashboard.
3. **Record screencast** (3-8 min) showing install → scan → results → settings. Upload to YouTube unlisted, paste URL in Partner Dashboard.
4. **Submit for app review** — all other Partner Dashboard fields are complete.
5. **EIN retry** — try IRS online ~2026-04-01 or call 1-800-829-4933.

### Risks & Warnings

- **`SHOPIFY_BILLING_TEST=true`** is still set in Railway — MUST flip to `false` before going live (after app review approval)
- **Dev store may have stale test data** — clean synthetic artifacts before E2E test and screenshots
- **Operating Agreement** still missing IP Assignment clause — not a submission blocker but a legal loose end
- **Implementer learnings file at 52 lines** — approaching cap, needs `/curate` in a future session

---

## Handoff state

**Source**: /handoff
**Input**: general session handoff

### Items (5)

1. **Unfinished work** — 2 tasks partially complete
   - GC-ue5: LLC formed, needs IP clause + EIN
   - GC-mfj.8: E2E test not started, blocks submission
   - pickup points: run `shopify app dev`, install app, run scan

2. **Key decisions** — 4 decisions made this session
   - decisions: billing isTest env var, signature gaps from market research, Bold breakout, monitoring deferred
   - rationale preserved: yes — in handoff note

3. **Resumable agents** — none

4. **Open questions** — 1 unresolved
   - questions: Operating Agreement IP clause (user action, not code)
   - blockers: none — just needs user to add clause and sign

5. **Risks flagged** — 3 risks
   - risks: SHOPIFY_BILLING_TEST still true, dev store stale data, Operating Agreement IP clause
   - confidence: CONFIRMED

### Summary

Session 23 hardened the codebase for submission: added 6 signatures targeting SEO and A/B testing gaps, ran a full code review, fixed all findings, and added 24 tests. The app is now at 1050 tests, 113 signatures, zero TS errors, and all automated Shopify checks passing. The only items blocking submission are visual assets (screenshots, screencast) which require an E2E test on the dev store. The next session should run `shopify app dev`, do a clean scan, capture screenshots/video, upload to Partner Dashboard, and submit.
