## Session Handoff: 2026-03-27 (session 22) — Submission prep + Partner Dashboard

### What Got Done

1. **Committed interrupted session work** — pre-submission checklist from crashed session
2. **Security review** — background agent found 3 warnings, all fixed: tenant isolation on `unknownScriptId`, max-length on `suggestedAppName`, `TOKEN_ENCRYPTION_KEY` required in production
3. **Added 11 app signatures** — 96 → 107 (SMSBump, Nosto, ShipBob, Attentive, Postscript, AdRoll, Tapcart, Route, Skio, Affirm/Afterpay, Reamaze). Listing now says "100+"
4. **Railway verification** — deployment healthy, 20 migrations applied (none pending), Inngest connected, all env vars set
5. **Custom domain setup** — `app.alpenglowsoftware.com` (Railway) and `legal.alpenglowsoftware.com` (GitHub Pages). Updated `shopify.app.toml`, Railway env vars, and re-ran `shopify app deploy`
6. **Partner Dashboard ~90% complete** — listing copy, pricing plans (Free/$29/$49), app icon, legal URLs, testing instructions, category (Site optimization - Other), SEO fields, install requirements, capabilities, test account
7. **App icon created** — ghost with code bracket mouth via Imagen 4.0, 1200x1200, uploaded
8. **LLC formation confirmed** — docs received, Operating Agreement reviewed (needs IP Assignment clause)
9. **Automated Shopify checks all passing** — auth, redirects, GDPR webhooks, HMAC, TLS
10. **Formatting + type checks** — 1026 tests passing, zero TS errors, all files formatted

### Key Decisions

- **Custom domain over Railway rename**: Used `app.alpenglowsoftware.com` instead of renaming Railway service. More professional and avoids Shopify's "no shopify in URL" rule permanently.
- **100+ signatures, not 200+**: Diminishing returns beyond ~120. Unknown script submission feature is the real long-tail strategy.
- **Monthly billing only**: No annual pricing at launch — code only handles monthly, simplicity over premature optimization.
- **Skip demo store URL**: Optional, needs real scan data. Will fill in after E2E test pass.
- **EIN not a submission blocker**: Only needed for payouts (W-9), not app review. Deferred.

### In-Progress Work

- **GC-ue5 (P1)**: LLC formed, but needs IP Assignment clause added to Operating Agreement and EIN obtained (retry IRS ~2026-04-01)
- **GC-mfj (P1 epic)**: Deploy epic — Railway verified, custom domain live, `shopify app deploy` done. Remaining subtask: GC-mfj.8 (E2E test)

### Uncommitted Changes

None — working tree clean (unused icon files deleted).

### Blocked Work

None currently blocked in beads. EIN is blocked on IRS processing (ref #101).

### Open Questions

- **Operating Agreement IP clause**: User has the Northwest template. The IP Assignment clause text is in `strategy/llc-setup-guide.md` Step 4. User needs to manually add it, sign, and file with records. Not a code task — just a reminder.

### Recommended Next Steps

1. **E2E test on dev store** — `shopify app dev`, install on dev store, run a scan, verify all flows. This unblocks screenshots, feature media, and screencast.
2. **Capture screenshots** (1600x900) during E2E: dashboard, scan results, scan comparison, scan history, settings. Upload to Partner Dashboard.
3. **Record screencast** (3-8 min) showing install → scan → results → settings. Upload to YouTube unlisted, paste URL in Partner Dashboard.
4. **Submit for app review** — all other fields are complete.
5. **EIN retry** — try IRS online again ~2026-04-01 or call 1-800-829-4933.

### Risks & Warnings

- **`SHOPIFY_BILLING_TEST=true`** is still set in Railway — MUST flip to `false` before launch (after app review approval, before going live)
- **Dev store may have stale test data** — clean synthetic artifacts before E2E test and screenshots
- **Operating Agreement** still missing IP Assignment clause — not a submission blocker but a legal loose end

---

## Handoff state

**Source**: /handoff
**Input**: general session handoff

### Items (5)

1. **Unfinished work** — 2 tasks partially complete
   - GC-ue5: LLC formed, needs IP clause + EIN
   - GC-mfj.8: E2E test not started, blocked on dev store session
   - pickup points: run `shopify app dev`, install app, run scan

2. **Key decisions** — 5 decisions made this session
   - decisions: custom domain, 100+ signatures cap, monthly-only billing, skip demo store, EIN not a blocker
   - rationale preserved: yes — in handoff note

3. **Resumable agents** — none

4. **Open questions** — 1 unresolved
   - questions: Operating Agreement IP clause (user action, not code)
   - blockers: none — just needs user to add clause and sign

5. **Risks flagged** — 2 risks
   - risks: SHOPIFY_BILLING_TEST still true, dev store may have stale data
   - confidence: CONFIRMED

### Summary

Session 22 was a submission prep marathon — took Ghost Code from "code complete" to "Partner Dashboard 90% done" with all automated checks passing. The only items blocking submission are visual assets (screenshots, feature media, screencast) which all need an E2E test pass on a dev store. The next session should run `shopify app dev`, install the app, do a clean scan, capture screenshots and video, upload them, and submit for review.
