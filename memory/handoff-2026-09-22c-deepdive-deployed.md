# Session Handoff: 2026-09-22c — Deep-dive review + fixes DEPLOYED

## What Got Done

- Ran `/deep-dive-review` (11 agents) on ghost-code-app: deployed `main` batch + follow-ups branch. Report: `docs/deep-dive-review-2026-09-22.md`. No CRITICAL, zero externally-exploitable vulns.
- Fixed the force-ranked highlights, adversarially audited them, deployed.
- **DEPLOYED to prod** in merge **95386b5** (CI ✓, Deploy ✓ 10m36s, Smoke ✓; `isInternal` migration applied on boot). This merge ALSO shipped the previously-built-but-undeployed follow-ups branch (gc-9ms/4cv/5ha).

Fixes shipped (all verified, 2923 tests green):
- **#1 (HIGH)** circuit breaker `checked >= 3` → `checked >= 1` (trips on 100% churn at ANY base size). Corrects gc-5ha commit 48ba7ea, which claimed to close the small-N gap but left N=1/N=2 exposed.
- **#5** `reconcile_aborted` GDPR residual removed (domains out of durable OpsEvent → operator email only).
- **#3/#4** `sendOpsAlert` failures + unhandled route errors now record durable `api_error` OpsEvents. Adversarial audit caught a shell-render **double-count**; fixed with a `shellFlushed` guard in `entry.server.tsx`, empirically re-verified vs real react-dom.
- **#9/#14** `.graphqlrc.ts` codegen October25→July26; corrected stale `worker_fallback` schema comment.

## Key Decisions

- **Fixed the double-count instead of accepting the reviewer's simplest suggestion.** Reviewer proposed dropping `onError` recording entirely; that would lose post-shell streaming-error coverage. Chose the `shellFlushed` guard = exactly-once for all three error sources (loader/action, shell, post-shell). Rejected: drop-onError (loses coverage), record-in-both (the bug).
- **Reused `api_error` type, did NOT add a new OpsEvent type** for #3/#4 — a new id-keyed type opens redact/prune coverage gaps. Trade: `api_error` is prune-exempt, so this adds unbounded writers (tracked as gc-2sw).
- **Deferred #10 (express bump) rather than forcing it under deploy pressure.** Local Node is v20.20.1; updated deps need ≥22.12 (EBADENGINE) and `npm audit fix` throws on the lockfile. Moderate advisory, no active exploit, 10-install app → not worth lockfile churn next to correctness fixes. → gc-1gv, do on Node 24.
- **Deferred the api_error write-bound (gc-2sw)** rather than reverse the intentional "retain failure history" prune-exemption under deploy pressure.
- **Did NOT bulk-file #6–#19 as beads** — per `.claude/rules/backlog-triage.md` (verify each against current code before filing). They live in the review doc.

## Patterns & Discoveries

- **Adversarial audit is load-bearing.** Two implementing agents disagreed on whether `handleError`/`onError` double-fire; the adversarial reviewer settled it with a runnable react-dom repro (not doc-reading). Always demand empirical proof for framework-callback claims. Reinforces [[feedback-verify-audit-fixes-like-original-code]].
- **This app writes GraphQL as plain strings to `admin.graphql()`, not `#graphql`-tagged literals** → codegen finds zero documents and validates nothing against any schema version. So #9's feared "October25-only field slips through" risk was overstated; version alignment is pure hygiene.
- Handoff/commit claims can overstate: gc-5ha's handoff said "small-N breaker gap closed"; the code (`checked >= 3` guard) contradicted it. Trust the code.

## In-Progress / Stale Beads (loose ends)

- **gc-1we (P1, marked in_progress):** external dead-man's-switch Railway cron. Actually DEFERRED this session (user said defer). Code is built/compiled/`build:deadman`, never scheduled. Pickup: create a Railway cron service running `node build/server/deadman-monitor.js` (~10m interval, shares `DATABASE_URL`/`RESEND_API_KEY`/`OPS_ALERT_EMAIL`). Ops task, no code. Consider resetting its status to open since not actively being worked.
- **gc-5ha (P2 bug, OPEN but shipped):** its commits (2881f87/3b3004e/48ba7ea) + this session's #1 correction are LIVE in 95386b5. Bead is stale → verify the reconciler behaves on the next cron run, then CLOSE.

## Uncommitted Changes

- None. Tree clean, all work committed and pushed to `main` (95386b5).

## Open Questions

- **`app/uninstalled` webhook not firing (gc-c9v):** only 1 `shop_uninstalled` event ever recorded — is the webhook mis-registered, or is uninstall traffic genuinely near-zero? The reconciler is the backstop (gc-dyt), now hardened. Decision criteria: watch the next 6am reconciler run + any real uninstall; if reconciler catches uninstalls the webhook missed, the webhook registration is the bug. Ask: nothing external — observe prod.

## Recommended Next Steps

1. **Tomorrow ~6am: verify the reconciler cron run** (gc-c9v/gc-dyt). Confirm it classifies real installs correctly, marks nothing spurious, and would page-not-churn on a mass-churn signal. This is the first real exercise of the #1 circuit-breaker fix. Then close gc-5ha.
2. **Fresh session: triage deep-dive #6–#19** from `docs/deep-dive-review-2026-09-22.md` into beads (verify each against code first per backlog-triage rule). Notable: #7 billing-event null-shop fail-open + dead groupBy, #8 operator-digest e2e test, #6 theme-size ceiling.
3. **On a Node 24 machine: gc-1gv** (express/qs/body-parser/morgan bump) — isolated change, verify build + full suite, deploy alone.
4. Optionally **gc-2sw** (bound api_error writes) if the digest shows any api_error volume.

## Risks & Warnings

- **The circuit-breaker change is money-adjacent and untested against a real cron run** — it's unit-verified (N=1/N=2 abort tests) but the first live run is tomorrow 6am. If paging silently fails on a persistent single-shop trip, a shop could sit un-marked (mitigated by #3 now recording paging failures durably).
- `api_error` is prune-exempt; a route throwing a bare `Error` (not `Response`) under bot-storm traffic could flood unbounded rows (gc-2sw). Low risk at 10 installs.
- gc-1we in_progress status is misleading — it is deferred, not being worked.
