# Session Handoff: 2026-07-02 (session 19)

Built and shipped an automated **post-deploy smoke gate** end-to-end, and investigated
(and refuted) a suspected auth bug. Origin: `main` is even with `origin/main` once the
retro-history + this handoff are committed. One untracked file by design:
`docs/backlog-live-168-2026-07-01.json` (168-world beads backup — do NOT delete/commit
without a lineage decision).

## What Got Done
- **Tier-3 post-deploy smoke gate — shipped, verified GREEN in real CI, now BLOCKING.**
  - `app/routes/health.deep.tsx` — token-gated `/health/deep` (db, inngest keys,
    un-refreshable expired offline sessions, stuck PENDING scans; 503 on degraded).
  - `scripts/smoke.mjs` — dependency-free; polls `/health` then asserts `/health/deep`.
  - `.github/workflows/deploy.yml` — separate `smoke` job (`needs: deploy`, ubuntu-latest,
    setup-node), **blocking** (no `continue-on-error`).
  - Commits: f331cb2 (probe+smoke), 1a444c4 (BEAD-3 sessions-check fix), a63d567 (CI
    node-container fix), 16a1317 (BEAD-4 blocking gate) + 3 docs/1 build.
- **Secrets configured myself** via `gh` + `railway` (no prod restart — used `--skip-deploys`):
  GitHub `HEALTH_CHECK_TOKEN` + `SMOKE_BASE_URL`; Railway env `HEALTH_CHECK_TOKEN`.
- **GC-07t investigated** — root-caused as by-design + self-healing (BEAD-2). No live bug.
- **Also shipped earlier:** a192a5d (dropped pnpm-only `shamefully-hoist` from `.npmrc`).
- Retro done (memory + retro-history updated). BEAD-3 + BEAD-4 done-in-commits.

## Key Decisions
- **Smoke sessions-check counts only `refreshToken: null` expired offline sessions**, not all
  expired. Rejected the naive "all expired" check because expiring offline tokens are
  self-healing by design → it false-degraded perpetually. Mirrors `SafeSessionStorage`'s guard.
- **Grace-window direction kept as `expires < now − 5min`** (a probe-tuning choice), not an
  exact mirror of `SafeSessionStorage.isExpired(5min)`. The `refreshToken: null` filter is the
  real discriminator; direction is immaterial (0 either way today).
- **Smoke split into its own `smoke` job** on ubuntu-latest. Forced by: the `deploy` job's
  `container: ghcr.io/railwayapp/cli` has NO Node → `node scripts/smoke.mjs` failed
  `node: not found`, masked by `continue-on-error` (false green — it had never actually run).
- **Flipped BEAD-4 to blocking now** (owner call) rather than waiting for extra green deploys,
  since it had already run verified-green in CI once.
- **Kept beads frozen** — all outputs captured as BEAD-1..4 in `memory/pending-beads-2026-07-01.md`,
  not `bd`.

## Patterns & Discoveries (durable — also in global memory)
- **`continue-on-error` masks a step that never ran → false green.** Confirm a soft-launched
  CI step actually EXECUTES via `gh run view <id> --log`, not the checkmark.
- **A job with a custom `container:` lacks the runner's default toolchain (no Node).** Node
  steps need their own `ubuntu-latest` job with `actions/setup-node`.
- **Don't diagnose auth from the Session table.** Offline tokens expire by design
  (`expiringOfflineAccessTokens: true`) and auto-refresh (all sessions carry `refreshToken`);
  expired rows are the normal resting state. Read Railway logs for real auth incidents.
- **Health checks must mirror the exact guard condition, not a superset** (else false-positive noise).
- Read a Railway env secret back without printing it: `railway variables … --json | python3 …`.
- `zsh` gotcha: `status` is a read-only var — don't use it as a loop variable in bash blocks.

## Mental Model
The manual `e2e-test-checklist.md` (~35 rows) collapses onto a tier map (delivered in-session):
most rows are Tier-1 logic (integration/route tests, much already exists), a cluster is Tier-2
component-render, the auth/scan-health rows are now **Tier-3 (the smoke gate, shipped)**, and only
~5 irreducible rows need a real Shopify dev store (Tier-5). The gate now auto-verifies the two
things that actually broke on 2026-07-01 (auth-session validity + scans-can-run) on every deploy.

## In-Progress Work
None. No code in flight.

## Uncommitted Changes
- `memory/team/retro-history.md` (session-19 retro entry) + this handoff — committed together at
  session close. `docs/backlog-live-168-2026-07-01.json` stays untracked by design.

## Blocked Work (all on the beads-lineage decision — carried from S17/S18)
- File/close BEAD-1..4 into `bd`; close GC-qk3/GC-kde/GC-rcj; harvest the 11 product items.

## Open Questions / Decisions Needed
1. **Beads lineage reconciliation** (carried): snapshot-86 canonical + harvest 11 open product
   items + drop Wix/closed + **add git-tracked JSONL export** (NOT a Dolt remote — see BEAD infra
   note in pending-beads). Criteria: confirm the 11 are still-wanted. Blocks all bead mutations.
2. **Auto-rollback vs alert-only** for the smoke gate: it currently red-alerts a bad deploy but
   does NOT roll back (deploy job already ran). Decide if a rollback follow-up is wanted. Criteria:
   how bad a few-minutes-degraded window is for a live app. Ask: owner.

## Recommended Next Steps
1. **Watch the next deploy's `smoke` job** stay green (it's blocking now) — one free confidence pass.
2. **`/tend` (curate)** — implementer 50 / tester 49, both at cap, no new entries; overdue since S17.
3. **Reconcile beads lineage + add git-tracked JSONL export** — unblocks BEAD-1..4 and closing
   GC-qk3/kde/rcj. Treat `bd` output as untrusted until done.
4. **BEAD-1 SEO/listing pass** — the actionable live-merchant work (tagline "remove"→"fix", keyword
   swap, SEO-title verify, decide the name rename). Highest product leverage now that the app is live.
5. **Optional Tier-1 test sweep** (from the checklist tier-map) to retire more manual rows.

## Risks & Warnings
- **Smoke gate is now BLOCKING** — a genuinely degraded `/health/deep` will turn the Deploy workflow
  red (alert, not rollback). Expected; it's the point.
- **Smoke can race the rollout** — runs after `railway up`; may hit the old container mid-cutover.
  If flaps appear, add a build/version marker to `/health/deep` and assert it before checking.
- **Beads DB still frozen/untrusted** (168-world) — no create/close/snapshot until reconciled.
- **Local `.env` → prod DB** over public proxy; migrations hit prod. No migrations this session.
- `docs/backlog-live-168-2026-07-01.json` untracked + lossy (no labels/close_reason).
