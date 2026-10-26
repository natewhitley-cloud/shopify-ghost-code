## Session Handoff: 2026-10-21, security batch (gc-dcyh Phase 0 + gc-3y89 + gc-xtno + gc-n3in)

### RESUME HERE (2026-10-26 ~13:00Z): DEPLOYED, nothing in flight
- **Prod = main = 92d0700** (deployed 2026-10-26 12:5xZ). Smoke (scripts/smoke.mjs, EXPECTED_SHA pinned) green:
  /health 200, deep health ok (db, inngest keys, 0 expired sessions, 0 stuck scans), SHA match, PUT /api/inngest 200.
  Runtime logs clean right after deploy. Rollback: Railway dashboard redeploy of the dce2101 deployment, or revert
  dce2101..92d0700 and deploy (no schema change).
- **Deployed via local CLI, NOT GitHub Actions.** The GH secret RAILWAY_TOKEN is genuinely invalid now (re-run
  2026-10-26 12:48Z failed with Railway green). On 10-21 the same error came from the Railway outage
  (status.railway.com/incident/QH8L8B3E, resolved). Local path used: clean worktree at the SHA,
  `git rev-parse HEAD > .deploy-sha`, `railway link` (project ghost-code ef319f99..., env production ca140675...,
  service shopify-ghost-code d49c0498...), `railway up --service d49c0498... --ci`, then smoke with
  HEALTH_CHECK_TOKEN read from `railway variables --json` (never printed). Failed GH run 39629377721 stays red.
- **TODO Nathan:** (1) new Railway project token (ghost-code, production) -> `gh secret set RAILWAY_TOKEN
  --repo natewhitley-cloud/shopify-ghost-code`, or every push to main will fail to deploy; (2) Railway security
  incident (blog: preliminary-report-october-security-incident): rotate env vars stored in Railway across all
  projects (ghost-code, bot-analytics-cleanup-app, fraud-triage, tax-integrity, form-to-crm); AI provider keys first;
  (3) decide on SUSPICIOUS_CODE_SIGNAL_ENABLED=true (starts Phase 0 data for gc-yn50).
- Beads closed 2026-10-26: gc-dcyh, gc-3y89, gc-xtno, gc-n3in. Open follow-ups: gc-yn50, gc-e3zo, gc-s6p2, gc-gayw.
- Release 2: rebase ~/shopify/gc-rrh4 on 92d0700 before slice 3 (see merge notes below).

### What shipped in 92d0700 (7 commits on dce2101)
- cb608eb gc-dcyh Phase 0: `app/lib/suspicious-code.ts` (filename marker `<name>.null.js`/nulled/warez,
  packer, `_0x` identifiers, hex-escape density, charcode+eval/atob). Runs in the asset pass only when
  `SUSPICIOUS_CODE_SIGNAL_ENABLED === "true"` (unset = no work, no key). Writes only
  `scan_signal.suspiciousCode {fileCount, files<=20, reasonCounts}`. No findings, no merchant surface.
- 66dddca gc-3y89: retry cleans homepage rows on every attempt; exports say "Your live homepage";
  preconnect/dns-prefetch labelled as hints, iframe/form/importmap read; Speed page single read on paid;
  theme health malicious row "None found" + reason when the homepage wasn't read; Home route test;
  free one-time speed-test hit dated ("Found in the speed test on <date>").
- be3cdb9 gc-xtno: dead advisory card removed; Home banners persist during a rescan/failed scan from the
  last completed scan (dated line); "k security risks" counts distinct risks (banners); red
  "Security risk: check before anything else" safety badge for malicious + advisories.
- eba67f4 + c1082f8 gc-n3in: Sidekick top findings say "Security risk" for malicious rows; advisories
  stay "Security advisory" (instructions.md:14 guardrail). Sidekick speed summary unchanged (item 9
  removed in audit fix, now gc-s6p2).
- 323dfcc, 92d0700 audit fixes (A1-A5, A7-A11).

### Verification
- Gate on 92d0700 (orchestrator run): lint 0, format:check 0, typecheck 0, 259 test files / 10,473 tests
  passed, build 0. Baseline was 257 / 10,335.
- Adversarial audit: 0 HIGH, 3 MED (A1 Sidekick advisory label, A2 Sidekick speed risks without
  instructions, A3 Home poll DB reads), all fixed and re-gated; LOWs A4, A5, A7-A11 fixed; A6 -> gc-gayw,
  A12 -> gc-s6p2, A13 noted below. No HIGHs, so no second audit round.

### Expected visible change after deploy (audit A13)
- With the homepage check live, Theme health "Known malicious code" reads "None found" with a reason
  (not "Clean") for shops whose latest scan predates homepage coverage (until they rescan) and
  permanently for password-protected storefronts. Sidekick's `checksNotFullyRun` lists it too.

### Release 2 merge notes
- Release 2 branch (`~/shopify/gc-rrh4`) is still dce2101 + docs: rebase it on 92d0700 before slice 3.
  Expected overlaps: soft-launch-flags (trivial), Home loader + tests (moderate, slice 4),
  scan-theme.ts (low), instructions.md (slice 6 owns; also drop the A8 test exception there),
  docs/pricing-and-plans.md (slice 7).

### Open beads from this batch
- gc-yn50 Phase 1 SUSPICIOUS_CODE finding (after FP data + deploy B + policy publish)
- gc-e3zo gc-3y89 items 5, 7, 8 (after slice 5)
- gc-s6p2 Sidekick speed risks + instructions (slice 6), incl. A8 exception + A12
- gc-gayw how to read Phase 0 telemetry
- Spike report: `docs/spikes/gc-dcyh-nulled-theme-spike.md` (untracked in the main checkout; commit with this handoff)
