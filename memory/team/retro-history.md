# Retrospective History

## Retro: 2026-03-10 (session 5 — P2 audit sprint)
- Tasks completed: 15/15 (100%) — all P2 audit findings (.50–.65) + 9 P1/P3 beads created for tracking
- Agents dispatched: 5 (4 implementer, 1 tester) — serial, no worktree
- New learnings: 7 across 2 members (implementer: 4, tester: 3)
- Test growth: 330 → 397 (+20%, 67 new tests)
- Fix rate: 0% — zero rework across all 5 commits
- Key insight: Batching 3-4 related tasks per agent with precise file-level context from orchestrator code reads produces consistently high-confidence results. All 5 agents returned CONFIRMED.
- Key pattern: Reading source files in the orchestrator before composing dispatch prompts — not just relying on audit descriptions — eliminated ambiguity and produced zero-rework agents.
- Notable: TOCTOU race fix (S-07) uses application-level $transaction guard. A DB-level partial unique index would be the final backstop but requires raw SQL migration.

## Retro: 2026-03-10
- Tasks completed: 25/36 (69%) across 4 batches
- Agents dispatched: 11 total (2+3+3+3)
- New learnings: 30 across 4 members (implementer: 16, scaffolder: 9, reviewer: 3, tester: 2)
- Pruned/archived: 1 entry (reviewer CSP gotcha updated)
- Fix rate: 4% (1 fix commit out of 25 — Polaris prop types)
- Key insight: Batching 2-3 related tasks per agent is the sweet spot — single-task dispatch wastes overhead, 4+ risks turn limits. The scan pipeline agent demonstrated this perfectly by proactively writing 92 tests alongside 4 service implementations.
- Key risk: Polaris Web Component prop restrictions are underdocumented. First encounter always produces invalid props. The learning loop self-corrects by batch N+1.

## Retro: 2026-03-10 (session 2)
- Tasks completed: batch 5 (8 beads) + .41 + 11 audit fixes = 20 items
- Agents dispatched: 6 (1 implementer, 2 reviewers, 3 fix agents)
- New learnings: 3 implementer entries (from .41), 8 pruned via merge
- Fix rate: 67% (4 fix commits out of 6 — audit-driven fix batch)
- Key insight: Dual reviewer dispatch catches unique findings each — second reviewer found billing gap, transaction need, and plan filter miss that first missed. Worth the cost for pre-launch audits.
- Key risk: Agents that change function APIs (e.g., createFindings → completeScanWithFindings) without updating tests cause downstream failures. Fix agent prompts should explicitly include "update relevant tests."

## Retro: 2026-03-10 (session 4 — pre-launch audit)
- Tasks completed: 6 P0+P1 fixes across 2 sprints + 31-finding audit report
- Agents dispatched: 7 (2 audit reviewers + 2 P0 fix + 1 P1 fix debugger + 1 P1 fix implementer + 1 tester)
- New learnings: 4 across 3 members (debugger: 1, implementer: 2, tester: 1)
- Test growth: 246 → 330 (+84 tests across 3 new test files)
- Fix rate: 100% (all 7 commits are intentional audit-driven fixes or tests, zero rework)
- Key insight: Audit → sprint pipeline produces zero-rework fix sprints. Audit agents are expensive (~90K tokens each) but their file:line precision makes downstream fixes surgical (<90 sec per agent).
- Key finding: 2 P0 ship-blockers found (GID format mismatch + plan string case) that would have silently broken all Professional-plan auto-rescan features in production.
- Deferred: E-01 (blocked on Railway URL), E-07 (Sentry deferred by user)

## Retro: 2026-03-10 (session 3)
- Tasks completed: 4/4 (100%) — .43 billing, .44 ORPHAN_ASSET, .45 test coverage, .42 DRY extraction
- Agents dispatched: 4 (3 implementer, 1 tester) — serial, no worktree
- New learnings: 14 across 2 members (implementer: 10, tester: 4), 3 pruned/merged
- Fix rate: 0% — clean sprint, no fix commits
- Test growth: 107 → 246 (+130%)
- Key insight: Single-task dispatch with detailed context produces high-confidence results (all 4 agents: high). Serial dispatch without worktrees works for 4 tasks but adds ~10min latency vs. parallel.
- Key risk: Tester agent didn't commit its 5 new test files — orchestrator had to commit manually. Agent prompts need explicit "commit your changes" instruction for file-creation tasks.
