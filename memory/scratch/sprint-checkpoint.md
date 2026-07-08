# Sprint checkpoint — session 22, review-fix batches (2026-07-07)

## Batch 1 — DONE (all green on real main)

- implementer merged as cabf9f2 (bf26993); tester merged as c0fb8e9 (eb5277c, +23 tests, audit
  found ZERO bugs, all 7 probes pass). Gate on real main: tsc + 1752/1752 + build PASS.
- GC-4oc CLOSED. Learnings persisted (implementer ×2, tester ×2, cross-notes both ways).
- INCIDENT (resolved): orchestrator cwd had silently drifted into the tester's worktree — first
  "merge" of eb5277c was a no-op ("Already up to date" in its own tree) and the gate ran there,
  not on main. Caught by scaffolder's brief tripwire. Lesson saved to global memory
  (orchestrator-cwd-drifts-into-agent-worktrees). ALWAYS `cd <repo> && pwd` in the same
  invocation as merges/appends.
- Local main = c0fb8e9, 4 commits ahead of origin. PUSH DECISION WITH NATHAN: recommend one
  deploy after Batch 2 merges (SHA-check soft-launch needs a real deploy to observe anyway).

## Batch 2 — GC-59t smoke-gate SHA pinning (scaffolder RUNNING in background, redo dispatch)

- First scaffolder dispatch correctly self-blocked on the missing-eb5277c tripwire (no changes);
  re-dispatched fresh after the real merge. SendMessage unavailable in this session → fresh
  dispatch was the resume path.
- Assignee: scaffolder (owns .github/\*\*, Dockerfile; smoke.mjs + small health.deep loader
  addition folded in for pipeline coherence). Then tester audit.
- Root cause of prior failure (22d9d90, reverted in 3d4349f): read RAILWAY_GIT_COMMIT_SHA at
  runtime — empty under `railway up` CLI deploys, hard-failed blocking gate.
- Approach (per S20 memory + bead): workflow writes $GITHUB_SHA to a file before `railway up`;
  Dockerfile build stage already COPY . . → copy file into runtime stage; health.deep reports it
  (null-safe when absent, e.g. local dev); smoke compares vs EXPECTED_SHA=$GITHUB_SHA passed in
  the smoke job — **WARN-ONLY (soft-launch)**, flip to blocking only after ≥1 real deploy observed
  green (file follow-up bead for the flip).
- Key facts: deploy.yml deploy job runs in railway CLI container (no Node); smoke job is separate
  ubuntu-latest with Node. Dockerfile runtime stage lists explicit COPYs (must add the SHA file).
  railway.toml healthcheckPath=/health unaffected. Check .dockerignore/.gitignore for the SHA file.
- Trailers at dispatch: scaffolder@<git log -1 --format=%h -- memory/agents/scaffolder/learnings.md>.
- Mark GC-59t in_progress at dispatch.

## Batch 3 — gated on Nathan's manual QA (GC-89k gates); NOT sprintable

- Delete dead webhooks.app.subscriptions.update handler + tests + toml breadcrumb after GC-89k closes.

## ENDGAME (Nathan-approved 2026-07-07): after batch-2 audit returns

1. Merge audit branch (cd-pinned + `git branch --contains <sha>` verify), apply/dispatch fixes if any
2. Full gate on real main: tsc + vitest + npm run build
3. PUSH to main (authorized — "pushed/committed" per Nathan) = prod deploy; watch gh run
   (CI + Deploy + smoke) and confirm the GC-59t warn-only SHA line appears in the smoke log
   (⚠ WARN expected on this first deploy OR ✓ match — either is a successful soft-launch
   observation; a ✓ match means the flip-to-blocking bead can be actioned next session)
4. File flip-to-blocking follow-up bead for GC-59t once observed; close GC-59t (soft-launch
   shipped; flip is the follow-up)
5. /retro then /handoff

- Batch-2 audit agent note: first audit dispatch stalled (watchdog, zero work done, worktree
  agent-aa525a49ac6720622 locked+abandoned at a7bb057 — clean up at wrap); retry running.
