## Session Handoff: 2026-10-21, security batch (gc-dcyh Phase 0 + gc-3y89 + gc-xtno + gc-n3in)

### RESUME HERE (2026-10-21 ~16:00Z)
- **main = 92d0700, prod = dce2101 (NOT deployed yet).** Push to main succeeded; the Deploy workflow
  (run 39629377721, re-run once) failed at "Deploy to Railway" with `Invalid RAILWAY_TOKEN`. Cause is NOT
  the token: Railway major incident https://status.railway.com/incident/QH8L8B3E ("Dashboard and API
  unavailable, builds paused", from 07:24 UTC 10-21). Same CLI image digest as the 10-20 good run and the
  secret is unchanged since 2026-03-22. Railway never got a build, so prod is untouched.
- **Unblock:** once the incident is Resolved (builds unpaused), `gh run rerun 39629377721` (redeploys
  92d0700 with .deploy-sha; smoke pins EXPECTED_SHA). Only if it STILL says invalid token with Railway
  green, create a new project token (production) and `gh secret set RAILWAY_TOKEN`. If smoke fails on a
  SHA mismatch right after deploy, it is usually Railway swap lag: wait 1-2 min, `gh run rerun --failed <run-id>`.
- **SECURITY (Railway, 10-21 ~21:30Z):** Railway disclosed that an unauthorized party may have accessed (and for some
  decrypted) customer environment variables (https://blog.railway.com/p/security-disclosure-wednesday-october-21st).
  Recommendation: rotate ALL Railway env vars (Shopify API secret, DATABASE_URL, Inngest keys, Resend, IPQS,
  Google Ads, TOKEN_ENCRYPTION_KEY, any AI provider keys) across GhostCode, ClearSignal, FraudPilot, TaxDelta, NOD,
  and review logs. Builds still paused at 7 pm MT 10-21 (last checked 01:00Z 10-22). The deploy of 92d0700 is ON HOLD
  for Nathan's call: rotate GhostCode secrets first and deploy once (recommended), or deploy as soon as builds return.
  Open offer: a per-app rotation runbook (Nathan does dashboard steps; Claude never rotates/revokes).
- **After green:** close gc-dcyh (Phase 0 shipped dark), gc-3y89 (1-4, 6, 10 shipped; 9 -> gc-s6p2;
  5, 7, 8 -> gc-e3zo), gc-xtno (1, 2, 3, 4a shipped; 4b -> gc-o7y7; 5 deferred: remaining 3 Hulk
  files are store theme repos, fixture bar already met), gc-n3in. Then decide on turning on
  `SUSPICIOUS_CODE_SIGNAL_ENABLED=true` in Railway to start the 2-4 week false-positive measurement
  (gc-yn50 go/no-go; read data per gc-gayw).
- **Rollback (after it deploys):** `git revert --no-edit dce2101..92d0700` on a branch from origin/main,
  gate, push to main (deploys the revert); or Railway dashboard "Redeploy" on the previous dce2101
  deployment. No schema change in this batch, so rollback is code-only.
- Worktree: `~/shopify/gc-dcyh` (branch feat/gc-dcyh-security-batch == origin/main 92d0700).
  Remove after the deploy is verified ([[worktree-globs-pollute-test-runs]]).

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
