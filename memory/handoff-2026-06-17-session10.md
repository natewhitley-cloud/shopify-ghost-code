# Session Handoff: 2026-06-17 (session 10)

`main` @ `08bc015`, **pushed** (origin in sync). Suite **1543 passing**, tsc clean, tree clean except auto-generated tackline churn. Backlog: 72 total, 35 open, 37 closed, 0 in-progress, 0 blocked.

## What Got Done
Executed the 3 priority items from the session-9 handoff, in order:
- **GC-3ho** — wrote `.claude/rules/backlog-triage.md` (verify each finding vs CURRENT code + full git history, not just doc + closed beads). `8e99251`.
- **`/curate` implementer learnings** — 50→33 lines; archived 17 off-sprint entries (7 deferred-C8 detector, 6 UI, 4 done/general) to `archive.md` (all retrievable). `1315c98`.
- **Tier-1 sprint (5/5 beads, serialized)**:
  - **GC-ba7 (QLT-5)** — extracted `persistAuditFindings` helper in `scan-theme.ts`; both call sites (`runAuditStep` + translation-audit) reuse it; both log `event` strings preserved byte-for-byte. `fc9c7e0`.
  - **GC-mus (LOG-14)** — `createUnknownScripts` made idempotent via `$transaction` deleteMany→createMany. `1a7e0a9`.
  - **GC-9vu (PRF-8)** — cron fan-out chunked at 500 via new shared `inngest/lib/fan-out.ts`, per-chunk named steps; both coordinators (weekly-scan, poll-theme-changes) unified. `e3dba66`. (Crash-recovered — see Risks.)
  - **GC-oa5 (PRF-1)** — added `concurrency: { limit: 5 }` to `scanTheme`. CPU-offload half split to new bead **GC-8uw**. `91ee098`.
  - **GC-fur (CMP-2)** — lazy on-load plan reconciliation (Option A): `Shop.planReconciledAt` migration, `billing-reconciler.server.ts` querying `currentAppInstallation.activeSubscriptions`, 6h freshness guard in `app.tsx` loader, shared `resolvePlanFromSubscription` extracted to `billing.server.ts`. `08bc015`.
- **Backlog hygiene** — closed stale session-9 handoff bead **GC-nww** (all its next-items done).

## Key Decisions
- **PRF-1 split (Option 1A)** — ship the cheap/safe concurrency limit now; defer the CPU-offload (move `scanThemeFiles` off the web event loop) to **GC-8uw**, to be decided with a perf baseline + the deploy-topology work. Rejected B (worker_threads) and C (separate worker process) as too heavy/infra-entangled for a P3. Mirrors session-9's CMP-3 split.
- **CMP-2 reconciliation (Option 1A: lazy on-load)** — self-heals on the natural access path, bounded cost via freshness guard, catches BOTH drift directions including under-grant (paid in Shopify, Free in DB from a missed upgrade webhook). Rejected B (cron — misses non-cron-cohort shops, eventual-only) and C (webhook-only verify — doesn't fix missed delivery).
- **CMP-2: drift correction records NO BillingEvent** (log only) — reconciliation is internal data-integrity repair; recording it would pollute conversion/churn analytics and risk double-count if the missed webhook later arrives.
- **Curate: aggressive 17-entry prune** — tuned learnings hard to the worker/billing sprint; everything retrievable from archive.

## Patterns & Discoveries
- **`FanOutStep` structural type gotcha** — Inngest's `step.run<T>` returns `Promise<Jsonify<Awaited<T>>>`, NOT `Promise<T>`; the test mock returns plain `unknown`. A helper that wraps `step` and ignores the return must type `run` as `(id, fn: () => Promise<unknown>) => unknown` to satisfy both real step + mock. (Cost a tsc failure in the GC-9vu crash.)
- **Inngest function config is testable** via the SDK's `InngestFunction.opts` property — used to assert `scanTheme.opts.concurrency === { limit: 5 }` (poll-check-shop's test mocks createFunction and can't do this).
- **`currentAppInstallation.activeSubscriptions` is a plain list field**, not a connection — no pagination needed.
- **SignatureSubmission → UnknownScript FK is `onDelete: Cascade`** (schema.prisma) — deleteMany in createUnknownScripts is safe because submissions are a later merchant action; scanId is per-scan so re-scans don't collide.

## In-Progress Work
None. All dispatched work merged + pushed; 0 beads in-progress.

## Uncommitted Changes
None of substance — only auto-generated `.claude/tackline/memory/sessions/*` churn (left unstaged all session, as in session 9).

## Resumable Agents
None — all completed. The one GC-9vu agent that crashed on a socket error was recovered by a fresh dispatch (its partial on-disk state was verified, the tsc error fixed, and it finished).

## Open Questions / Owner-Gated (carried from session 9, unchanged)
- **CMP-1 (GC-eis, P1)** — contextual optional-scope requests; needs a dev store.
- **URL-1 (GC-25u, P1)** — Managed Pricing link; needs the real app handle from Partner Dashboard.
- **GC-8uw (PRF-1b, P2)** — B (worker_threads) vs C (separate Inngest worker process) for CPU-offload. Criteria: a perf baseline (scan wall-time + event-loop lag under concurrent scans) + the deploy topology decision. Decide WITH the Railway deploy, not before.
- **Deploy** — still owner-gated: Railway env + `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` (boot guard) + pending migrations + `TOKEN_ENCRYPTION_KEY` removal.

## Recommended Next Steps
1. **`/status` first**, then `/advise` — backlog shifted (5 closed, 1 new).
2. **Tier-2 cluster work** now that Tier-1 is clear. Strong P2 candidates in `bd ready`: **QLT-3 (GC-e3s)** + **QLT-4 (GC-gc4)** — GraphQL cursor-pagination + rate-limit handling duplicated across fetchers (note: these are PARTIAL/scope-reduced — READ the bead notes first); **PRF-3 (GC-bk7)** THROTTLED handling; **PRF-2 (GC-6vv)** scan-detail pagination; **QLT-6 (GC-hlm)** shared.ts token-system bypass.
3. **GC-gmt** (P2 bug) — `detectGhostSnippets` conditional-depth gap; small, in the detector area (verify it's not part of the deferred C8 cluster before working).

## Risks & Warnings
- ⚠️ **The CMP-2 migration was applied to the LIVE Railway DB** during `prisma migrate dev` (only DB in `.env`). Additive nullable column (`Shop.planReconciledAt`) — non-destructive + reversible (single DROP COLUMN), migration file committed. But prod schema is now ahead of any formal deploy. Persisted to global memory ([[prisma-migrate-dev-hits-live-db]]). For future DB work: additive/reversible only, or set up a shadow DB; gate destructive migrations behind the owner deploy.
- **9 PARTIAL beads** (QLT-1/3/4/6/8/10, CMP-3b/GC-iji, OPS-2/9) still carry scope-reduction notes in their descriptions — READ before working.
- **C8 beads (QLT-1/QLT-2/PRF-6)** remain deferred (hidden from `bd ready` until 2026-09-15) — don't resurface early. The 7 archived detector learnings relate to this cluster.
- **Subagent socket crashes recur** — the GC-9vu agent died mid-run (same mode as session-9 QLT-7). Recovery playbook: verify partial on-disk state with tsc+vitest BEFORE building on it, then finish via fresh dispatch.
- Don't "fix" the GDPR 5xx contract (deliberate, documented).
