# Session Handoff: 2026-07-01 (session 17)

Origin synced (`main` == `origin/main`), no stashes. One untracked file by design:
`docs/backlog-live-168-2026-07-01.json` (live-DB backup — do NOT delete or commit
without a lineage decision).

## What Got Done
- **GC-qk3 (P3, shipped `2c125b6`)** — dashboard loader batched: new `getSeverityCountsForScans(scanIds[])` (single `groupBy(['scanId','severity'])`) replaces up to 9 `getFindingSummary` calls (~18 aggregation queries → 1). `getFindingSummary` left intact — scan-detail page still needs its `byType` axis.
- **GC-kde (P3, shipped `402f7d2`)** — dashboard theme reads cached: new `app/lib/ttl-cache.server.ts` (generic, injectable clock) + `app/services/theme-cache.server.ts` (per-shop 60s TTL). Loader read path only; action's theme-validation and poll cron stay on raw fetchers (fresh).
- Both pushed. 1711 tests green, tsc clean.
- Session-17 retro committed (`98dc4c8`): implementer +1, tester +1 learnings; retro-history updated.

## Key Decisions
- **GC-kde cache = in-memory TTL (Option A), not DB-persisted (B).** Rejected B because it needs an additive prod migration (per the standing local-.env→prod-DB risk) and still needs a TTL for draft themes — marginal gain for real cost. In-memory: a miss just re-fetches, zero correctness risk.
- **Cache only the dashboard read path.** Deliberately left the action's themeId-validation (security) and the cron's `updatedAt` read (freshness) on the raw fetchers.
- **Two commits, hunk-split the shared loader file.** Filtered the diff by `@@` hunk via awk → `git apply --cached` for commit 1, then `git add -A` for commit 2. Clean per-bead attribution.
- **Did NOT close GC-qk3/GC-kde in beads, did NOT refresh the snapshot, did NOT file action-item beads** — because the beads DB is in an anomalous lineage (below). Work is recorded in commit messages instead.

## Patterns & Discoveries
- eslint here sorts **sibling (`./`) before parent (`../`)** imports — contradicts `.claude/rules/imports.md` (says one alphabetical group). Doc is wrong; linter wins. Cost 2 pre-commit bounces this session.
- Subagents ran `tsc` + `prettier` but not `eslint` before reporting done → those bounces. Process fix added to tester learnings: run `npx eslint --max-warnings 0 <files>` before "done."

## THE INCIDENT — beads DB divergence (read before touching beads)
Mid-session the live Dolt beads DB was **swapped to a disjoint 168-issue dataset**
(Wix research epic GC-87c.*, Partner Dashboard tasks, Prisma-7 upgrade). Every
session-16 bead (GC-qk3, GC-kde, GC-d4f, GC-8uw, GC-07t, GC-jlk) **vanished from the
live DB in all statuses**. The git-tracked `docs/backlog-snapshot.json` (86 issues)
still holds the session-16 world and is the only intact backup.

Neither dataset is a strict superset — a blind restore either direction loses data.
Preserved both non-destructively:
- 86-world: `docs/backlog-snapshot.json` (git-tracked, untouched)
- 168-world: `docs/backlog-live-168-2026-07-01.json` (new, untracked — note: `bd list
  --all --json` omits `labels`/`close_reason`/`closed_at`, adds `parent`/`dependencies`/`notes`;
  NOT byte-identical to the snapshot generator)
Likely trigger (unconfirmed): beads git-hooks (`.beads/hooks/` post-checkout/post-merge)
resyncing during husky/lint-staged `git stash`+pop cycles on commit.
Full detail in global memory: `ghost-code-beads-db-diverged-from-snapshot.md`.

## In-Progress Work
None in flight. No resumable agents (both dispatches completed).

## Open Questions / Decisions Needed
1. **Beads lineage reconciliation** (`.beads/` Dolt DB vs `docs/backlog-snapshot.json`):
   which is canonical, and how to merge? Options: (A) snapshot canonical → restore, lose
   168-world Wix/Partner beads unless merged; (B) live-DB canonical → session-16 beads
   live only in commits; (C) manual merge of both exports. Criteria: which set reflects the
   work you actually intend to continue. Blocks closing GC-qk3/GC-kde.
2. **Push code to origin?** — DONE (already pushed).

## Recommended Next Steps
1. **Reconcile the beads lineage** (question 1). Until then, treat `bd` output as untrusted.
   Compare `docs/backlog-snapshot.json` (86) vs `docs/backlog-live-168-2026-07-01.json` (168).
2. **Give beads a Dolt remote** — root cause of today's scare (gitignored local DB, snapshot-only
   backup). Highest-leverage durable fix (~P2).
3. **`/tend` (curate + promote)** — implementer 50 / tester 49 lines, both at/over the 50 warning.
   GC-q7a tracks tester curate; implementer now also a candidate.
4. **Fix `.claude/rules/imports.md`** to state sibling-before-parent ordering (or reconfigure eslint).
5. Once lineage is settled: **close GC-qk3 + GC-kde** (done in `2c125b6` / `402f7d2`).

## Risks & Warnings
- **Beads DB is untrustworthy until reconciled.** Don't `bd close`/create/snapshot-refresh until
  the canonical lineage is chosen — you'll cement a wrong state or lose data.
- Local `.env` → prod DB over public proxy; migrations hit prod. Additive only. (Both this
  session's changes are code-only, no migration.)
- `docs/backlog-live-168-2026-07-01.json` is untracked and lossy (no labels/close_reason) — a
  full-fidelity backup of the 168-world needs the original snapshot-generator script, not `bd list`.
