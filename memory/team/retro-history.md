# Retrospective History

## Retro: 2026-06-15 (session 7 — deploy unblock + Cluster 2 & 1 review remediation)

- Tasks completed: merged PR #1 (prior session's top-10 work); fixed deploy blocker (PR #2, dead better-sqlite3 native build); Cluster 2 scan-integrity (PRs #3-#6: LOG-5/7/8/6/10); Cluster 1 detector false-positives via /sprint (PR #7: LOG-11/12). 7 PRs merged this session. Suite 1367 → 1442.
- Dispatch: serial Agent dispatches for Cluster 2 (one finding/PR, orchestrator reviewed each diff + CI before merge); /sprint team loop for Cluster 1 (implementer → reviewer → implementer fix).
- Commits on main: 10 fix, 2 chore, 1 refactor. Genuine rework: 1 (Cluster 1 BLOCKING-1), caught by the team reviewer BEFORE merge — never reached main.
- Key insight: the /sprint adversarial reviewer caught a self-inflicted false-positive regression (per-line→full-content regex conversion made `\s*` match `\n`, double-counting multi-line `{% render %}` tags). Live-executing the regexes found it. This is the exact failure the cluster targets — the review loop paid for itself.
- Key insight: subagent telemetry can under-report (a fix dispatch showed "1 tool use" for real multi-file work). ALWAYS verify branch state with git grep before trusting an agent's completion report.
- Honest gap found in retro: LOG-11 only converted 5 of 8 named detectors; Sections/Canonical/Ajax still per-line → filed GC follow-up bead.
- Deploy still pending owner: retry Railway build; 2 migrations auto-apply; remove TOKEN_ENCRYPTION_KEY.

## Retro: 2026-04-01 (session 31 — Lint fixes + pre-push hook)

- Tasks completed: 0 beads (quick-fix session)
- Commits: 2 (1 fix, 1 chore), 6 files touched
- Tests: 1308 (unchanged)
- Key insight: lint-staged only checks staged files — recurring CI lint failures were caused by errors in files committed earlier or via --no-verify. Pre-push hook running full lint + typecheck closes this gap.
- Process note: Short, focused session — identified root cause, fixed all 10 issues, added structural prevention, committed, pushed, verified. No scope drift.

## Retro: 2026-04-01 (session 30 — Handoff review + tester curation)

- Tasks completed: 0 beads (maintenance session)
- Tester learnings curated: 50 → 35 lines (6 archived, 1 was incorrect — stale $transaction mock)
- Portfolio memory updated: Bot Analytics (App 2) submitted for review
- All agent learnings healthy (28-40 lines, all under warning threshold)
- Key catch: /curate identified an actively wrong tester entry that would have caused broken mocks on next dispatch

## Retro: 2026-04-01 (session 29 — Learnings curation + P4 sprint + admin metrics dashboard)

- Tasks completed: 6 beads closed (1 P2 feature: admin metrics dashboard, 4 P4 refactors from review, 1 P4 doc)
- Agents dispatched: 5 implementer (serialized worktree)
- New learnings: 1 implementer entry, 2 MEMORY.md workflow entries
- Implementer learnings curated: 62 → 40 lines (22 archived)
- Test growth: 1249 → 1308 (+59 tests, 56 files)
- Commits: 8 (1 feat, 1 fix, 4 refactor, 1 perf, 1 chore)
- Fix rate: 12.5% (1 intentional lint fix)
- Key insight: /curate before sprint produces leaner agent context and zero-rework dispatches.
- Key feature: Admin metrics dashboard — new Prisma model, model layer, admin-gated route, Inngest daily cron, 51 new tests.
- Key near-miss: `git add -A` staged worktree dirs — caught and reset before push.
- Team health: implementer at 40 lines (healthy after curation), tester at 49 lines (approaching warning, has stale entry)

## Retro: 2026-03-31 (session 28 — Features + full codebase review + fixes)

- Tasks completed: 14 beads closed (2 features, 2 stale housekeeping, 1 critical fix, 4 warning fixes, 5 P3 fixes). 16 beads created from review.
- Agents dispatched: 5 implementer (serialized worktree) + 1 /review (inline)
- New learnings: 3 implementer entries, 4 MEMORY.md entries
- Test growth: 1194 → 1249 (+55 tests, 52 files)
- Commits: 8 (2 feat, 1 merge, 1 test, 1 CI fix, 3 fix)
- Fix rate: 0% on feature work, 100% intentional on fix commits
- Key insight: Full codebase /review → bead creation → sprint fix pipeline: 16 findings surfaced, 14 fixed in one session. Batching fix beads then dispatching implementer with the full list is efficient.
- Key discovery: Shopify Partner Dashboard locks listing content during app review.
- Key process issue: Worktree agents sometimes don't commit — changes appear as uncommitted diffs. Orchestrator must verify worktree commit status before merging.
- Team health: implementer at 62 lines (2 over cap, needs /curate next session)

## Retro: 2026-03-28 (session 24 — Monitoring sprint + managed pricing + E2E testing)

- Tasks completed: 8 beads closed (5 monitoring + 1 downgrade billing + 1 managed pricing refactor + 1 auto-rescan bug fix)
- Agents dispatched: 9 (2 scaffolder, 4 implementer, 3 tester) — all serialized
- New learnings: 12 across 3 members + 5 MEMORY.md entries
- Test growth: 1050 → 1100 (+50 tests, 48 files)
- Commits: 11 (3 feat, 2 fix, 1 refactor, 3 docs, 2 agent)
- Fix rate: 18% (2 fix commits out of 11 — both real bugs found during E2E)
- Key insight: E2E testing on dev store caught 3 bugs that unit tests couldn't: Managed Pricing incompatibility with billing.request(), CSV export losing auth in iframe, auto-rescan using stale theme ID. Always E2E before submission.
- Key pivot: Discovered Managed Pricing is active (Partner Dashboard pricing set) — removed all in-app billing.request() calls and reworked settings page to be informational only. Cross-portfolio learning stored for bot-analytics + ember.
- Key bug: themes/publish webhook payload.id references a theme the GraphQL files API rejects when publishing a different theme. Fixed by using fetchMainTheme() instead.
- Observability stack: Sentry scaffold, scan failure rate cron, BillingEvent DB, rate limit alerting, Inngest failure middleware.
- Submission status: Screenshots + feature media uploaded. Only screencast URL remains.
- Team health: implementer at 58 lines (approaching 60-line cap, needs /curate next session).

## Retro: 2026-03-28 (session 23 — Signatures + code review + fixes + test coverage)

- Tasks completed: 12 beads closed (1 feature: 6 signatures, 6 bugs, 5 test tasks; 1 already covered)
- Agents dispatched: 8 (5 implementer, 2 tester, 1 explorer pair)
- New learnings: 3 durable learnings added to MEMORY.md
- Test growth: 1026 → 1050 (+24 tests)
- Fix rate: 0% — zero rework commits, all agent output correct on first pass
- Key insight: /review → sprint pipeline on a mature codebase produces surgical fixes. 11 beads completed in ~45 min serialized dispatch. Market research cross-referenced with signature DB identified highest-value gaps (SEO apps, ShopLift).
- Key decision: Billing isTest switched from NODE_ENV to dedicated SHOPIFY_BILLING_TEST env var for explicit control.
- Monitoring backlog: 5 observability beads deferred (Sentry, scan failure rate, billing metrics, rate limit alerting, Inngest notifications).

## Retro: 2026-03-24 (session 21 — File cleanup + v1.4 GHOST_FONT/GHOST_AJAX)

- Tasks completed: Uncommitted file cleanup (3 commits), v1.4 detectors (1 commit)
- Agents dispatched: 1 implementer (GHOST_FONT + GHOST_AJAX)
- Test delta: 998 → 1026 (+28 tests)
- Commits: 4 (3 docs/chore, 1 feat)
- Lines added: ~1100 net
- Key insight: Housekeeping commits should be done periodically, not accumulated across 5+ sessions. 14 modified/untracked files creates merge risk.
- Key pattern: Single subagent dispatch for paired detectors (FONT + AJAX) worked cleanly — both operate on `<head>`/`<script>` content with identical patterns.
- Scanner now at 22 finding types, 96+ signatures, 1026 tests. v1.4 performance tier complete.

## Retro: 2026-03-23 (session 19 — Permission Audit removal)

- Tasks completed: 1 bead closed (GC-iw0 Permission Audit removal)
- Agents dispatched: 2 (1 implementer, 1 scaffolder) — serial, no worktree
- New learnings: 1 implementer entry (grep inngest/ during feature removal)
- Test delta: 833 → 705 (-128 tests removed with feature)
- Commits: 2 (1 fix scope gate, 1 refactor full removal)
- Lines removed: 5,471
- Key insight: `appInstallations` GraphQL query is restricted to Shopify-internal apps — no third-party scope exists. Third feature killed by API restrictions (after Ember + Tax Integrity Monitor). New portfolio-level memory created to enforce query-level feasibility testing before feature work.
- Key pattern: `/spec` → `/sprint` pipeline for surgical removal worked cleanly. Spec identified 17 files + 8 cross-cutting refs; agents caught 2 additional refs via grep sweep.
- Bonus: After removal, pivoted to Unknown Finding Feedback Loop curation pipeline (GC-e8u). 2 more agents (scaffolder + implementer), +20 tests, CLI review script. All v1.1 roadmap items now shipped.
- Extended session: Killed orphaned webhook detection (same API isolation blocker). Ran opportunity scan across all existing research — identified 9 new features. Feasibility-checked 3 scope-dependent items (read_products, read_content confirmed; read_metafields partially feasible). 9 new beads created.
- Ongoing issue: Third consecutive session with post-push CI lint failures from agent code. Need eslint pre-commit hook.

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

## Retro: 2026-06-15 (session 6 — top-10 remediation from full code review)

- Tasks completed: 6/7 actionable top-10 fixes (9A, 1A, 6A, 5A, 2A, 3A, 8A); 4A deferred to a focused dev-store session by owner choice.
- Dispatch: ad-hoc Agent dispatches (not /sprint team), serial; two review workflows (76 agents) produced the source findings.
- Commits: 9 on branch `code-review-2026-06-12` (7 fix, 2 docs/deps). Test suite 1308 → 1367 passing, typecheck clean throughout.
- Fix rate within session: one dep-bump (9A) introduced a duplicate-shopify-api regression caught during 1A verification and fixed (df8a0ae) — net positive (caught before merge).
- Key insight: independent orchestrator verification (re-run typecheck + vitest before closing) caught TWO false "all green" agent reports. Non-negotiable going forward.
- Key insight: a subagent died mid-task (socket error) with uncommitted work; a fresh agent reading the diff finished it cleanly (58 test reconciliations).
- Key product finding: GHOST_TRANSLATION orphan detection is infeasible; owner chose informational reframe. GHOST_PRICE now needs real orphan evidence. These materially improve scanner credibility.
- Deferred/open: 4A (GC-eis, needs dev store), 7A (GC-25u, needs app handle), 10A (GC-664, needs Railway), esbuild (GC-e8a), test flakiness (GC-9x2).

## Retro: 2026-06-15 (session 8 — GC-9vj + Cluster 3 observability + Cluster 4 test backfill)

- Tasks completed: 6/6 (100%) — GC-9vj (LOG-11 finish), GC-be2 (OPS-3/SEC-3), GC-c09 (OPS-4/OPS-8), GC-s14 (TST-5), GC-wex (TST-3), GC-f6w (TST-4). All merged to main @ 97ced6b, pushed.
- Dispatch: /sprint team, SERIAL (per project orchestrator rule), 6 implementing agents + 1 reviewer verify pass. Inline verification (git + targeted vitest/tsc) for low-risk items instead of dispatching reviewer — saved context budget.
- Commits: 13 (6 impl + 6 merge-commits + 1 chore-learnings). Test suite 1442 → 1486 (+44). tsc clean throughout.
- Fix rate (rework): 0% — every task passed first-pass; every review/verification passed. No corrections.
- New learnings: 11 across 4 members (implementer +4, tester +5, reviewer +1, debugger +1). 1 cross-agent note (debugger→tester boot-guard test technique) delivered + used same session. 0 pruned (all files <50 lines).
- Key insight: orchestrator-side scoping verification BEFORE dispatch prevented redundant work (TST-2 already done via 6A → dropped) and a dead-file chase (review's `token-encryption.server.ts` exemplar was deleted in 8A → steered debugger to the live `shopify.server.ts` pattern). Verify each item against live code, don't trust the handoff/review doc verbatim.
- Key insight: reviewer's "live-execute the regex with node -e, don't read it" learning held — independently reproduced GC-9vj's no-double-count claim rather than accepting it.
- Recurring friction: pre-commit `eslint import/order` rejected the tester's first commit (reorder-and-recommit). Bit an agent again → promotion candidate to a project rule.
- Open follow-up: GC-jjb (detectGhostSections comment-skip parity). Owner-blocked unchanged: deploy retry, 4A (dev store), 7A (app handle).

## Retro: 2026-06-15 (session 9)
- Tasks completed: 8 commits (2 fix, 2 docs, 2 chore, 1 test, 1 refactor); 11 beads closed (3 sprint, QLT-7, 5 pre-done dupes, CMP-3, 1 moot).
- Fix rate: 25% — normal; low rework. One subagent crashed mid-task (socket error) — recovered by dispatching a fresh agent to finish from the partial on-disk state.
- New learnings: implementer +3, tester +2, reviewer +1; 1 global memory (verify-findings-against-code-before-filing-beads).
- Backlog: filed ~43 new beads from review-2026-06-12 (clusters C5-C15, C8 deferred); reconciled 34 via 7 read-only verifiers (none fully done beyond the 5 dupes; 9 PARTIAL scope-reduced).
- KEY INSIGHT (repeat of session-8 lesson, now at triage scale): filed 41 beads off the stale review doc cross-referencing only CLOSED BEADS — missed a batch of unbeaded direct-PR fixes (#3-#7: LOG-5/6/7/8/10). The session-8 retro already said "verify against live code, not the handoff/review doc" but it was applied to dispatch, NOT to bead-filing. Promote to a rule.
- WIN: read-only verifier fan-out (7 agents, one per cluster) reconciled a large filed set fast with concrete evidence; trust their evidence (one correctly reported a fix already existed — I wrongly doubted it first).
- WIN: CMP-3 — checked docs/pricing-and-plans.md before a billing change; found the flag was dead/stale, not a behavioral bug. The project rule (review pricing doc before plan-gating changes) paid off.
- implementer learnings at 50 lines (warning threshold) — run /curate next session.

## Retro: 2026-07-01 (session 12)
- Tasks completed: 7 beads closed (GC-gmt/fjg/2tq/iji bugs + GC-403 handoff), 7 PRs merged (#8-#14)
- New learnings: 0 to team files (bugs dispatched via general-purpose agents, not /sprint)
- Pruned/archived: 0 (all 5 learnings files under 50-line cap)
- Key insight: general-purpose agent dispatches bypass the team-learning loop — durable learnings from the 4 bug agents lived only in PR bodies. Captured as a feedback memory + proven offline prisma-migrate-diff recipe for the live-DB constraint.

## Retro: 2026-07-01 (session 13 — owner manual steps + cluster-15 pickups)
- Tasks completed: 3 beads closed (GC-25u pricing-link, GC-vu9 protocol-relative scanner bug, GC-zkv finding-sort tests); 2 PRs merged (#15, #16); GC-o1a handoff closed; GC-664 deferred (owner call)
- New learnings: 2 to debugger (protocol-relative `new URL()` drop; verify scope names vs docs), 1 to tester (coverage.include broadened) — harvested manually from general-purpose dispatches
- Pruned/archived: 0 (tester at 48 lines — flag for /curate next session)
- Key insight: the session-12 handoff's "CRITICAL pending migration" was already false — deploys are self-migrating (Docker CMD runs `prisma migrate deploy` on boot). Verify handoff risk claims against reality (`prisma migrate status`, prod introspection) before acting. Two general-purpose dispatch loops again bypassed the team-learning loop (recurring — see harvest-learnings memory).

## Retro: 2026-07-01 (session 14 — GC-a5o deploy hardening)
- Tasks completed: 1 bead closed (GC-a5o / OPS-6); 1 PR merged (#17, main @ 358f79d)
- New learnings: 2 to scaffolder (migrate deploy → Railway preDeployCommand not boot; removing boot-time prisma generate requires copying both .prisma AND @prisma/client) — harvested manually from a general-purpose dispatch (recurring gap — see harvest-learnings memory)
- Pruned/archived: 0 (tester still at 48 lines — /curate still pending)
- Key insight: deploys are now pre-deploy-migrating, not boot-migrating (GC-a5o inverted the session-13 model). The deploy that introduces preDeployCommand is itself its maiden run, so land such changes when `prisma migrate status` shows nothing pending. External /health can't distinguish deploys (old container answers 200 on new-deploy failure) — Railway dashboard is the source of truth.

## Retro: 2026-07-01 (session 15 — remaining deploy cluster + SIGTERM)
- Tasks completed: 5 beads closed (GC-8gh SIGTERM graceful shutdown; GC-2d8 non-root USER + Dockerfile HEALTHCHECK; GC-29h .dockerignore hygiene; GC-irz index migration; GC-u9e review-CTA deep-link). 6 commits pushed to main (92aebb2..8c82cca), direct-to-main (no PRs).
- Dispatch: /sprint with real team roles — scaffolder (GC-8gh/2d8/29h/irz), implementer (GC-u9e). FIRST session in 4 to route through the team-learning loop instead of general-purpose. 3 learnings persisted via the proper path (2 scaffolder, 1 implementer).
- Commits: 4 fix, 1 perf, 1 chore. Zero rework/corrections — every change landed first try, all hooks green.
- Key insight: GC-irz's "drop unused Finding.severity index" was a review-doc mis-diagnosis — the index is load-bearing (WHERE + groupBy + orderBy in finding.server.ts). The "verify before drop" gate caught it. Backlog-triage rule (verify vs current code) paid off again.
- Key insight: recurring "general-purpose bypasses learning loop" gap (flagged S12/S13/S14) RESOLVED by using /sprint. Now the confirmed default path for team-owned work.
- Owner-gated deploy verifications accumulating: GC-bo4 (S14 preDeployCommand maiden run) + GC-8gh SIGTERM drain + GC-irz index migration all await one Railway dashboard pass on next deploy.
- tester learnings still at 48 lines — flagged for /curate a 4th retro running; filed as a tracked bead this time (GC-q7a).
