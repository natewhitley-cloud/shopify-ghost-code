# Session Handoff: 2026-06-15 (session 9)

`main` @ `09298dc`, **pushed** (origin in sync), tree clean except auto-generated tackline churn. Suite **1503 passing**, tsc clean. Backlog: 69 total, 40 open, 29 closed, 0 in-progress, 0 blocked.

## What Got Done
- **Sprint (3 tasks)** — GC-jjb (`detectGhostSections` comment/conditional skip, `7018917`), GC-9x2 (pinned the clock-flaky month-boundary quota test, `4885f09`), GC-2vs (wrote `.claude/rules/imports.md`, `92e92e1` + `ef15107` example fix). All first-pass clean.
- **QLT-7 + LOG-8** — unified the createScan+inngest.send dispatch trio into `app/services/scan-dispatch.server.ts` (request-context helper) `e23a9f9`. LOG-8 (worker idempotency) turned out **already fixed** in `e4a8476` (PR#4); QLT-7 (route/webhook unification) was the real new work. Suite 1489→1503.
- **CMP-3** — flipped the dead/stale `scheduledScan: false`→`true` for Standard in `billing.server.ts` to match `docs/pricing-and-plans.md` + the weekly-scan cron `09298dc`. Flag is unread → no behavior change.
- **Backlog triage** — inventoried all 65 review-2026-06-12 findings, clustered the ~41 untriaged into C5–C15, filed beads, **deferred C8** (scan-engine refactor) to 2026-09-15.
- **Reconciliation** — closed 5 dupe beads (LOG-5/6/7/8/10, all pre-fixed in unbeaded PRs #3–#7); verified the other 34 via 7 read-only verifier agents; annotated 9 PARTIAL beads with scope-reduction notes. Closed TST-8 as moot (token-encryption deleted).

## Key Decisions
- **Combine QLT-7+LOG-8 in one dispatch** (tightly coupled, same edit) — matches the GC-be2/GC-c09 precedent. LOG-14 kept separate (different code path).
- **Defer C8** (QLT-1/QLT-2/PRF-6 scan-engine refactor) — high regression risk on the 2,232-line credibility core where false-positive fixes live; revisit 2026-09-15 with a golden-fixture net first. (Owner choice.)
- **Split CMP-3** — flag-honesty (done) vs quota-exemption (new bead GC-iji, needs a `Scan.origin` field + product decision). Rejected bundling the behavioral change into the "tiny" fix.
- **Reconcile via read-only verifier fan-out** (owner choice) rather than serial self-verification.

## Patterns & Discoveries
- **Triage trap (root cause of the dupes)**: I filed 41 beads from the review doc cross-referencing only *closed beads* — missed unbeaded direct-PR fixes (#3–#7). The lesson is now a global memory + action bead GC-3ho (promote to a project rule). Session-8 retro flagged the same lesson for *dispatch* but it wasn't applied to *filing*.
- **`scheduledScan` is dead/decorative** — defined in `billing.server.ts` + asserted in tests, but read nowhere in `app/`/`inngest/`. The weekly cron hardcodes `where: { plan: PLANS.STANDARD }`.
- **Scan-dispatch has two contexts**: request-context → `dispatchScan()` (swallows send errors, watchdog cleans up); Inngest worker → split createScan + `step.sendEvent` into separate steps (already done in `poll-check-shop.ts`).
- **Subagent crash recovery**: an agent died mid-QLT-7 (socket error, no resume available) — recovered by inspecting the partial on-disk state and dispatching a fresh agent to finish. The partial tree was broken (dangling test mocks) — verify partial state with tsc+vitest before building on it.

## In-Progress Work
None. All dispatched work merged + pushed; 0 beads in-progress.

## Resumable Agents
None — all completed or recovered (the one crashed agent's work was finished by a fresh dispatch).

## Open Questions / Owner-Gated (unchanged)
- **CMP-1 (GC-eis, P1)** — contextual optional-scope requests; needs a dev store.
- **URL-1 (GC-25u, P1)** — Managed Pricing link; needs the real app handle from Partner Dashboard.
- **Deploy (GC-664 residual + others)** — owner retries Railway deploy; now also needs `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` set (boot guard), plus the 2 Prisma migrations + `TOKEN_ENCRYPTION_KEY` removal.
- **GC-iji (CMP-3b)** — product decision: should scheduled scans count against the Standard 1/week manual quota? (Impact is ~18h, Sun 6AM→Mon reset.)

## Recommended Next Steps
1. **First, file the backlog-triage rule (GC-3ho)** before more cluster work — it prevents repeating the triage error. Quick `/promote`-style task.
2. **Real Tier 1 remainder is small** (C6 fully done, LOG-6/7/8 were dupes): C5 → **QLT-5** (translation-audit DRY), **PRF-1** (scan concurrency limit), **PRF-8** (cron chunking), **LOG-14** (unknown-script idempotency); C9 → **CMP-2** (plan reconciliation). Sprint these.
3. **`/curate` the implementer learnings** (at 50-line warning cap) before the next sprint.
4. Then Tier 2 (C7 fetcher consolidation — note QLT-3/QLT-4 are PARTIAL, scope-reduced; see bead notes), C11 backend DRY (QLT-8/QLT-10 PARTIAL), etc.

## Risks & Warnings
- **The 40 open beads are now trustworthy** (verified vs `e23a9f9`), BUT 9 are PARTIAL with scope-reduction notes in their bead descriptions — READ the bead notes before working them (QLT-1/3/4/6/8/10, CMP-3b context, OPS-2/9). Don't redo the already-done halves.
- **C8 beads (QLT-1/QLT-2/PRF-6) are deferred** (hidden from `bd ready` until 2026-09-15) — intentional; don't resurface early.
- **Deploy still owner-gated** with the Inngest-keys boot guard (unchanged from session 8).
- Don't "fix" the GDPR 5xx contract (deliberate, documented).
