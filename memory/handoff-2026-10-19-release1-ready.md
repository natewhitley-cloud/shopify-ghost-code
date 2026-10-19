# Handoff 2026-10-19: release 1 ready, awaiting Nathan's go

## RESUME HERE

Worktree `~/shopify/gc-5nok`, branch `feat/gc-5nok-sidekick` (local only, NOT pushed).
origin/main = 8df5faf (NOD digest commits from another session; ancestor of this
branch, so the push fast-forwards). Prod before release = 5d2d6af + those NOD commits.

Release 1 contents: gc-9ae6 (Selly), gc-5nok (Sidekick tools), gc-d0ui (Pro 5/day,
Standard monthly speed, Free one-time), gc-4wvb (Settings redesign), psew, cswd, wnhs,
gc-14x5.1/.2 (advisory embed handles), gc-vgqc (named speed regressions), gc-q5z8
(security-risk UI), plus two audit rounds of fixes (no open HIGH or MEDIUM).

Release 2 (not started): gc-rrh.4 What changed, gc-qafb, Sidekick get_recent_changes;
spec at docs/specs/what-changed-release2.md.

## Release checklist (each outward step needs Nathan's go)

1. Nathan reviews and publishes the privacy policy patch (prepared from
   data-integrity-suite/ghost-code/privacy.html; also see docs/privacy-sidekick-draft.md).
   Covers Sidekick, Standard monthly speed, email speed section for Standard, Pro named
   apps, server error records. Bump effective date. Legal repo: check unpushed before push.
2. Owner decisions before deploy: paw-naturals bought "Unlimited scans" (tell or
   grandfather; Pro is now 5/day); gc-w5mk Free speed upsell copy (Pro only vs Standard).
3. `git push origin "HEAD:refs/heads/main"` from gc-5nok (brace the refspec in zsh).
   Deploy is self-migrating. Watch the GitHub Actions deploy run: its smoke job checks
   /health/deep deployedSha == pushed SHA and the deep checks.
4. Unauthenticated OPTIONS on https://app.alpenglowsoftware.com/api/sidekick/latest-scan
   and /api/sidekick/speed returns 204 with CORS headers.
5. Same sitting: `shopify app deploy` (non-TTY flow, memory
   shopify-app-deploy-noninteractive-review-flow). Diff must show only the sidekick-tools
   extension. The extension uid was hand-written: if the CLI rejects it, delete the uid
   line and let the CLI write one. Rollback: `shopify app release --version <prev>`.
   Settings plan tiles already say "Ask Sidekick", so don't leave a gap.
6. Nathan's dev-store Sidekick check: docs/sidekick-dev-store-check.md.
7. With Nathan's go: set APP_INCIDENT_ADVISORY_LIVE_ENABLED=true on Railway. Kill switch:
   set it false, then the runbook DELETE (required): docs/runbooks/app-incident-advisory.md.
8. Close beads: gc-9ae6 gc-5nok gc-d0ui gc-4wvb psew cswd wnhs gc-14x5.1 gc-14x5.2 gc-vgqc gc-q5z8.

## Open beads from this batch
gc-xtno (q5z8 LOWs), gc-gxnp (APP_EMBED_OFF/GHOST_APP_EMBED fingerprint collision),
gc-w5mk, gc-at1g (quota race), gc-b8s8 (DRY), gc-gjn3 (rate-limit backoff), gc-76dt,
gc-hlvu (Speed page 390px overflow), gc-ujsc, gc-nit6, gc-6yks, gc-qafb, gc-rrh.4.
Also: the paid scan page overflows at 390px from the App Impact Map table (pre-existing).

## Artifacts
Settings https://claude.ai/artifact/PU3oM2HJhkLT3wZMHqMHHs ; What changed
https://claude.ai/artifact/DRiqhyoB5wGL5PdUUrCvvj ; Security risk
https://claude.ai/artifact/QCXVMq3auoa41SQjdWGNGu (built shots on top).
Preview harness: ~/shopify/gc-preview-harness/{settings,speed,risk}/ (root harness broken: duplicate React).
