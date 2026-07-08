# Session 22 Handoff: Review-Fix Sprint (Batches 1+2 shipped)

**Date**: 2026-07-07
**Project**: ~/shopify/ghost-code-app
**Prod state**: main `33ad905` deployed green (CI ✓ Deploy ✓ smoke ✓, incl. `✓ deployed SHA matches`)

## What Got Done

- **/review** of session-20/21 billing work → 8 findings → 3 logical batches
- **Batch 1 (GC-4oc, CLOSED)**: one-shot Admin-API retry in `reconcileShopPlan` gated on
  `recordEvent: true` (the redirect fast-path marker) so conversion BillingEvents survive a
  transient Shopify error; + 3 stale-comment fixes (`shopify.server.ts`, `billing.server.ts`);
  - direct unit tests for `determineBillingEventType`/`PLAN_AMOUNTS` (coverage now survives
    future webhook-handler deletion). Audit: 0 bugs, 7/7 probes pass. Suite 1726 → 1752.
- **Batch 2 (GC-59t, CLOSED)**: smoke-gate SHA pinning via build-time `.deploy-sha` file
  (deploy.yml writes $GITHUB_SHA before `railway up` → Dockerfile copies with touch-guard →
  `/health/deep` reports `deployedSha` → smoke compares vs EXPECTED_SHA, **warn-only**).
  Audit caught 1 real bug pre-deploy: `.deploy-sha` was gitignored and `railway up` respects
  .gitignore → the file would never reach the build context (permanent invisible no-op). Fixed
  (`4650fc4`). Suite → 1754. **Soft-launch observed `✓ deployed SHA matches` on first deploy.**
- **/retro** done: 7 learnings persisted (implementer/tester/scaffolder) + 3 cross-agent notes;
  retro-history appended; global memory updated (session file, audit-pattern 7→8 bugs,
  cwd-drift lesson).

## Key Decisions

- **Retry keys off `recordEvent: true`, no separate retryOnError option** — recordEvent IS the
  fast-path semantic marker; a second flag would be redundant (rejected: loader-side retry).
- **SHA pin shipped warn-only despite passing everything locally** — per the S20 soft-launch
  rule; flip condition (≥1 green observation) met on the FIRST deploy, so the flip is ready now.
- **Batch 3 filed as GC-dda, dependency-blocked on GC-89k** rather than done opportunistically.
- **One combined push for both batches** — the SHA soft-launch needed a real deploy to observe
  anyway; a single rollover gave the billing fix + the observation.

## Patterns & Discoveries

- **`railway up` respects `.gitignore`** (has `--no-gitignore` opt-out) — CI-injected
  build-context files must NOT be gitignored. In scaffolder learnings + global memory.
- **Orchestrator cwd drift incident**: shell cwd silently sat inside an agent worktree; a merge
  no-op'd ("Already up to date"), the gate ran in the wrong tree, two learnings appends landed
  in the worktree copy. Caught ONLY by the next agent's brief tripwire ("verify commit reachable
  after merging main, else STOP"). Recovery: re-merge from canonical repo, re-append learnings,
  re-run gate. Rules now: `cd <repo> && pwd` in the same invocation as any repo mutation;
  verify merges with `git branch --contains <sha>`; keep tripwires in every dispatch brief.
- First Batch-2 audit dispatch stalled (600s watchdog, zero work done — worktree still at
  session-start HEAD). Disk-state check before re-dispatch avoided duplicate/lost work.
  SendMessage was unavailable this session; fresh re-dispatch was the resume path.

## In-Progress Work

None — clean stop. No uncommitted app code, no stashes, no in_progress beads.

## Blocked Work

- **GC-dda** (Batch 3: delete dead `webhooks.app.subscriptions.update` handler + tests + toml
  breadcrumb): blocked on GC-89k. Zero coverage loss when it runs (direct tests landed in eb5277c).
- **GC-fir** (Partner API migration): still blocked on 2026-07 RC → GA.

## Open Questions

None blocking. GC-89k's two QA gates are decidable only by running them on a store (Nathan).

## Recommended Next Steps

1. **GC-89k (Nathan, ~15 min)**: welcome-link route under `/app` + live upgrade test on a store
   → close GC-89k → GC-dda unblocks. Code-side note: `_index/route.tsx:11` preserves
   searchParams on `/` → `/app` redirect, so `plan_handle` survives a root landing.
2. **GC-7ml (agent-ready)**: flip smoke SHA check to blocking — condition met (run 28916107597).
   ~3-line smoke.mjs change + deploy.yml comment; keep warn-only when EXPECTED_SHA is unset.
3. **/curate before next sprint**: tester (53) and implementer (52) learnings past the 50-line
   warning; tester's pre-commit-eslint entry is a flagged /promote candidate.
4. **GC-rcj + GC-fh0 (Nathan)**: Partner Dashboard listing copy — fully written in the beads.

## Risks & Warnings

- Every push to main = full prod deploy; smoke gate blocks but does NOT roll back.
- SHA check is still warn-only until GC-7ml — the rollover false-green gap exists until then.
- Concurrent-double-redirect BillingEvent race (two simultaneous fast-path reconciles) noted by
  the Batch-1 audit as a theoretical DB-level double-record; needs DB locking; deliberately not
  beaded (low likelihood/impact).
- `.claude/worktrees/` had 5 leftover agent worktrees at session end (all merged; one locked
  from the stalled dispatch) — removed at wrap; if any survive, `git worktree remove` them.
