# Retrospective History

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

## Retro: 2026-03-10 (session 3)
- Tasks completed: 4/4 (100%) — .43 billing, .44 ORPHAN_ASSET, .45 test coverage, .42 DRY extraction
- Agents dispatched: 4 (3 implementer, 1 tester) — serial, no worktree
- New learnings: 14 across 2 members (implementer: 10, tester: 4), 3 pruned/merged
- Fix rate: 0% — clean sprint, no fix commits
- Test growth: 107 → 246 (+130%)
- Key insight: Single-task dispatch with detailed context produces high-confidence results (all 4 agents: high). Serial dispatch without worktrees works for 4 tasks but adds ~10min latency vs. parallel.
- Key risk: Tester agent didn't commit its 5 new test files — orchestrator had to commit manually. Agent prompts need explicit "commit your changes" instruction for file-creation tasks.
