# Session Handoff: 2026-07-02 (session 20)

## What Got Done
- **Confirmed S19's post-deploy smoke gate is genuinely working** — verified via the smoke job log that it runs real assertions (db/inngest/sessions/scans) and is NOT a masked false-green. It's green on `main` and enforcing.
- **Attempted + cleanly reverted SHA-pinning** of the smoke gate (close the smoke-races-rollout risk). Reverted because Railway doesn't populate `RAILWAY_GIT_COMMIT_SHA` on `railway up` CLI deploys → the app reported `version: null` → the blocking gate went red on a config gap (no outage).
- **Ran `/tend`** — 5 agents assessed, learnings already healthy. Real payoff: caught `.claude/rules/imports.md` (must-strength) documenting import order **backwards** vs the linter; fixed it (sibling-before-parent, verified via `eslint --fix`) and added `npx eslint --fix` as the authoritative workflow. Closes the import/order friction first flagged in the session-17 retro.
- **Ran `/retro`** — captured the soft-launch-before-blocking-gate learning.

## Key Decisions
- **Revert SHA-pinning rather than fix forward** — the forward fix depended on Railway CLI behavior unverifiable from the dev box; a second prod guess on a red pipeline was worse than restoring a known-good green. (rejected: best-effort fallback = too clever/implicit; fix-forward via Railway var = unverifiable).
- **Fix imports.md to match the linter, keep `must` strength** — the doc was empirically wrong (verified by running eslint), not a judgment call. Led with `eslint --fix` because the ordering is subtle and version-dependent. (rejected: autofix-only = loses the worked example; example-only = no autofix escape hatch).
- **Honored the project's serialized-dispatch rule over `/tend`'s parallel default** — and did the curation inline (pragmatic for a solo-dev repo of this size).

## Patterns & Discoveries
- **Railway `railway up` (CLI) deploys carry no git context** → `RAILWAY_GIT_COMMIT_SHA` is empty at runtime. To pin anything to the deployed commit, inject the SHA yourself. (global memory: `ghost-code-railway-cli-deploy-no-git-sha`)
- **imports.md was wrong**: linter enforces sibling (`./`) before parent (`../`); among parents, alphabetical by path. `eslint --fix` is authoritative.
- **Stale index drift**: MEMORY.md's "migrate on boot" line was corrected to `preDeployCommand` (its own detail file was already right).

## In-Progress Work
- None. Clean stop, nothing mid-flight.

## Uncommitted Changes
- `memory/team/retro-history.md` (M) — session-20 retro entry; bundled with this handoff commit.
- `docs/backlog-live-168-2026-07-01.json` (untracked) — by-design frozen-beads backup; leave as-is.

## Blocked Work
- **BEAD-1..4 filing** — blocked on the beads lineage reconciliation (owner decision). Beads DB still frozen/untrusted (168-world lineage). Outputs live in `memory/pending-beads`, not `bd`.

## Resumable Agents
- None — both SHA-pinning implementation dispatches (sonnet, general-purpose) completed and were verified.

## Open Questions
- **Beads lineage reconciliation** (`.beads/` Dolt DB vs git-tracked `docs/backlog-snapshot.json` + `docs/backlog-live-168-2026-07-01.json`): how to unify the two disjoint datasets so BEAD-1..4 can be filed. Options: (A) git-tracked JSONL export as source of truth (portable, diffable, no Dolt remote) vs (B) stand up a Dolt remote. Criteria: do you want beads portable/reviewable in git, or a live shared DB? Owner decision — no code blocker.
- **SHA-pinning re-land** (`scripts/smoke.mjs` + Dockerfile + `.github/workflows/deploy.yml`): deferred. Approach = build-time injection — write `github.sha` to a file in the deploy job before `railway up`, `COPY` into the runtime image, app reads it. Criteria to unblock: verify `.dockerignore`/`.railwayignore` won't exclude the file + confirm the multi-stage `COPY` path. Ship it NON-FATAL first, prove green, then flip to blocking (per new memory).

## Recommended Next Steps
1. **Beads lineage reconciliation** — highest leverage; unblocks BEAD-1 (SEO/listing pass), the top live-merchant work. Needs the A-vs-B decision above first.
2. **BEAD-1 (SEO/listing)** once beads unblocked — Partner Dashboard app name/description updates (already in `bd ready` directionally: GC-rcj, GC-fh0).
3. **SHA-pinning re-land** (optional hardening) — only if you want to close the theoretical rollout race; low urgency (never bitten across many deploys).

## Risks & Warnings
- **Blocking smoke gate has no auto-rollback** — a genuinely bad deploy red-alerts but keeps serving; recovery is manual (an S19-carried risk, unchanged).
- **Any push to `main` triggers a full deploy** (docs-only pushes included) — the deploy job runs `railway up` + the blocking smoke on every push.
- **Beads DB frozen/untrusted** — if `bd` shows a dataset that disagrees with `docs/backlog-snapshot.json`, suspect the mid-session DB swap; don't treat `bd` as authoritative until reconciled.
