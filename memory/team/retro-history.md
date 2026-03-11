# Retrospective History

## Retro: 2026-03-11 (session 7 — P3 polish sprint)
- Tasks completed: 8/8 (100%) — 1 bug fix, 4 tasks, 3 features
- Agents dispatched: 8 implementer + 1 Explore (serial, mixed worktree/direct)
- New learnings: 6 implementer entries added, 7 archived (55→48 lines)
- Test growth: 439 → 473 (+34 tests, net of 6 removed dead-export tests)
- Commits on main: 3 (fix, refactor, feat). 5 tasks left uncommitted changes from worktree agents.
- Fix rate: 0% — zero rework across all agents, all returned CONFIRMED
- Key insight: Worktree-isolated agents complete work correctly but their changes don't auto-land on main. Orchestrator must track and commit uncommitted diffs before session close.
- Key pattern: Fan-out coordinator/worker reuse — the same poll-check-shop worker serves both daily (Professional) and weekly (Standard) cron coordinators. Plan filtering belongs in coordinators, not workers.
- Notable: /review caught 2 warnings (Date serialization in Inngest step.run, misleading cron comment) and 1 test gap (scheduledScan assertions) — all added to backlog as f49, snq, e3v.

## Retro: 2026-03-10 (session 6 — P2 monetization + engagement)
- Tasks completed: 9 beads closed (3 monetization, 3 engagement features, 3 review fixes)
- Agents dispatched: 8 (7 implementer, 1 tester) — serial, no worktree
- New learnings: 8 across 2 members (implementer: 5, tester: 2), 7 archived from implementer (pruning from 56→49 lines)
- Test growth: 397 → 439 (+42 tests: 30 new + 12 from sprint agents)
- Fix rate: 8% (1 test mock fix out of 12 commits — themes/publish mock missing new export)
- Key insight: /review after implementation sprints catches test gaps and UX edge cases reliably. The "0 more findings" banner bug would have shipped without it.
- Key pattern: New module exports break existing test mocks. When an agent adds exports to a module, orchestrator should grep for test mocks of that module and fix them proactively.
- Notable: Prisma migration for lastThemePublishAt created but not runnable without DATABASE_URL. Prisma generate with dummy URL works for type checking.

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
