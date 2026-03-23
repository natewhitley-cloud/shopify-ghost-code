# Retrospective History

## Retro: 2026-03-23 (session 19 — Permission Audit removal)

- Tasks completed: 1 bead closed (GC-iw0 Permission Audit removal)
- Agents dispatched: 2 (1 implementer, 1 scaffolder) — serial, no worktree
- New learnings: 1 implementer entry (grep inngest/ during feature removal)
- Test delta: 833 → 705 (-128 tests removed with feature)
- Commits: 2 (1 fix scope gate, 1 refactor full removal)
- Lines removed: 5,471
- Key insight: `appInstallations` GraphQL query is restricted to Shopify-internal apps — no third-party scope exists. Third feature killed by API restrictions (after Ember + Tax Integrity Monitor). New portfolio-level memory created to enforce query-level feasibility testing before feature work.
- Key pattern: `/spec` → `/sprint` pipeline for surgical removal worked cleanly. Spec identified 17 files + 8 cross-cutting refs; agents caught 2 additional refs via grep sweep.

## Retro: 2026-03-23 (session 18 — signatures, theme testing, E2E scan)

- Tasks completed: 20 app signatures added, E2E scan verified (41 findings), theme testing automated, GC-nmc created
- Agents dispatched: 2 (1 implementer for signatures, 1 research for missing apps)
- Test growth: 819 → 833 (+14 tests for new signatures)
- Commits: 2 (1 feat signatures, 1 docs retro/handoff from prior session)
- Key insight: Shopify CLI `theme push --allow-live` eliminates manual copy/paste for theme testing. Pull → edit → push is fully scriptable.
- Key gap filled: Cookie consent category had only Pandectes; now has 5 apps. Search & Filter was empty; now has 2.
- Signature DB: 74 → 94 apps across 15 categories.

## Retro: 2026-03-23 (session 17 — GC-5n8 + GC-icb feature sprint)

- Tasks completed: 2 features (GHOST_TEXT, GHOST_TRANSLATION), 3 CI lint fixes, 1 metadata commit
- Agents dispatched: 3 (1 explore, 1 research spike, 2 implementer)
- New learnings: 0 agent entries (orchestrator-direct session)
- Test growth: 778 → 819 (+41 tests, 10 finding types now, 43 test files)
- Commits: 5 (2 feat, 2 fix, 1 chore)
- Fix rate: 40% — both fixes were CI lint (unused vars/imports), not logic bugs
- Key insight: Background research spike for translation API ran while text fragment feature was implemented in foreground — zero idle time, research directly shaped implementation.
- Key pattern: Subagent-written code has a lint blind spot — pre-commit hooks only check staged files, and agents don't run full eslint. Two consecutive sessions with post-push CI lint failures.
- Key decision: Translation detection uses heuristic orphan detection (cross-ref installed apps) because Shopify's Translations API has no creator attribution on Translation objects.
- Migrations: 2 new (add_ghost_text_finding_type, add_ghost_translation_finding_type). Optional scope `read_translations` registered.

## Retro: 2026-03-22 (session 15 — scanner expansion + UI overhaul)

- Tasks completed: 3 beads closed (GC-xn0 JSON-LD, GC-8la prettier hook, GC-zse permission audit epic), 2 new beads created (GC-xn0, GC-icb)
- Agents dispatched: ~12 (signature audit, orphan filter, hreflang, duplicate meta, JSON-LD, tile redesign, sort+PageFly, various UI fixes)
- New learnings: 1 implementer entry (multiline regex offset-to-line helper)
- Test growth: 657 → 715 (+58 tests, 8 finding types now)
- Commits: 23 (11 feat, 10 fix, 2 chore/refactor)
- Fix rate: 43% — mostly UI iteration with live feedback, not bugs. One real debugging cycle (View button: 3 attempts).
- Key insight: Live user testing in dev store drove 3 new scanner finding types (hreflang, duplicate meta, JSON-LD). Testing revealed modern Shopify apps use clean-uninstall patterns (Theme App Extensions auto-cleaned) — orphaned code skews toward older apps and direct theme edits like PageFly.
- Key pattern: "Skip Liquid template tags" heuristic for JSON-LD detection cleanly separates native theme JSON-LD from app-injected orphans — native Dawn blocks always use `{{` variables.
- Key bug: `app.scans.tsx` was an unintended layout route (React Router v7 flat file convention) — renaming to `app.scans._index.tsx` fixed View button. Shadow DOM theory was wrong.
- Key UI lesson: Never put inline `style` on Polaris `<s-*>` Web Components — wrap in plain `<div>` instead.

## Retro: 2026-03-11 (session 8 — CI cleanup + infra backlog)

- Tasks completed: 4 beads closed (f49 Date bug, snq comment fix, e3v test gap, bvh GitHub repo)
- Agents dispatched: 1 implementer (bulk any elimination — 114 errors across 19 files)
- New learnings: 3 workflow patterns added to MEMORY.md
- Test growth: 473 → 473 (unchanged — all changes were lint/format fixes)
- Commits on main: 5 (1 chore + 3 fix + 1 chore formatting)
- Fix rate: 60% (3 fix commits out of 5 — expected for a lint cleanup session)
- Files touched: 64 (bulk lint/format sweep)
- Key insight: First push to GitHub exposed ~220 accumulated lint issues (114 `any` errors + 112 import ordering warnings). Running `npm run lint` and `npm run format:check` locally before first push would have caught these.
- Key pattern: ESLint `--fix` handles import ordering but NOT Prettier formatting. Always run both before pushing.
- Key blocker: Railway "Team not found" error when provisioning PostgreSQL — likely a billing/plan issue. Paused for investigation.

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
