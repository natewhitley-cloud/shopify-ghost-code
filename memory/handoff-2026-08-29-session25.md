# Handoff — Session 25 (2026-08-29)

## TL;DR
Started with a **dead beads store**; ended with **P0 hardening deployed + verified in prod** (`fa68baa`). Ran a full 11-agent deep-dive review, repopulated the backlog, shipped all 3 P0s, adversarial-audited them (SHIP), and deployed. Next session: build the operator daily digest (`gc-bny`) + uninstall-event logging (`gc-grd`).

---

## Prod state
- **Deployed SHA: `fa68baa`** (main, pushed to origin). Verified live via `/health/deep` new shape.
- Post-deploy checks all green: `/health` ok, `/health/deep` `status:ok inngestOk:true`, `PUT /api/inngest` → **HTTP 200** (signing key valid), `OpsEvent` migration applied ("schema up to date").
- App URL: `https://app.alpenglowsoftware.com`. Railway project `ghost-code` / service `shopify-ghost-code` (GitHub-connected auto-deploy on push to main).

## What shipped in this deploy (the P0 batch)
1. **Scan-pool DoS fix** (`app/services/scan-pool.server.ts`) — worker failure retries once in-pool then re-throws; `scanThemeFiles` no longer imported here so inline main-thread execution is structurally impossible. `scan-theme.ts` marks the scan FAILED on the throw.
2. **ReDoS-hardened detectors + 1MB file cap** (`scan-engine.server.ts`) — `extractTags` isolates tag text linearly before attribute regexes; `MAX_SCANNABLE_FILE_BYTES = 1_000_000`, skips surfaced via `skippedFiles`. Detection unchanged (339 detector tests pass + 25 new golden-file tests on real Dawn markup).
3. **Email failure-alerting** (`app/services/ops-alert.server.ts`, ported from ClearSignal) — `notifyFunctionFailure` now emails via Resend. Inert unless env vars set (they are — see below).
4. **Cron dead-man's-switch + functional health** — `inngest/lib/heartbeat.ts` `withCronHeartbeat` wraps all 5 crons; `/health/deep` `inngestOk = envOk && no overdue crons` (cold-start-safe + fail-open); new `OpsEvent` table + `app/models/ops-event.server.ts`.

## Railway env (LIVE, shared with ClearSignal)
- `OPS_ALERT_EMAIL = natewhitley@gmail.com`, `RESEND_API_KEY = re_E…` (same key as ClearSignal).
- **GOTCHA: rotating the Resend key breaks BOTH apps** until each is updated — same shared-secret pattern as the Inngest key.

---

## Beads / backlog
- **Store was DEAD** — all pre-session-25 `GC-*` beads are WIPED and unrecoverable. Root cause: `dolt.auto-commit` was OFF (issues lived only in the working set; an Aug-28 schema migration reset it) + the migration dropped the `issue_prefix` config row. FIXED: `bd config set dolt.auto-commit on` (verify with a `bd create` → `dolt_log` shows `bd: create <id>`) + restored `issue_prefix=gc`. Detail in global memory `beads-dolt-autocommit-off-loses-data.md`.
- **New backlog** = deep-dive epic `gc-06e` (+ children) and standalone `gc-bny` / `gc-grd`. Run `bd list --status open --limit 50`.
- Full review report: **`docs/deep-dive-review-2026-08-29.md`** (force-ranked, verify-pass notes, roadmap reconciliation).

### Open beads that matter next
- **`gc-bny` (P1) — operator daily digest.** Fully specced in the bead. ONE daily Inngest email via the ops-alert/Resend channel. Section A (business): installs total-minus-dev / new / uninstalls, plan mix + BillingEvent changes, MRR + net change, scans per store + total + status, findings detected + top types, signature flywheel, activation. Section B (ops health): runs completed/failed/partial, function-failure count (from `countOpsEvents('function_failure', …)` — already in place), webhook failures, worker fallbacks, alerting self-check via `getOpsAlertConfigStatus()`. Dev-store exclusion via `OPERATOR_EXCLUDE_SHOPS`. Real-time alerts stay a SEPARATE instant stream (already live). Port ClearSignal's `app/inngest/operator-digest.ts` pattern.
- **`gc-grd` (P2) — uninstall-event logging.** Prerequisite for the digest's uninstall count AND fixes the compliance hard-delete finding: on `app/uninstalled`, record an uninstall event + clear session token but DEFER the full data wipe to `shop/redact` (48h grace).
- **`gc-06e.18` (P1) — wire `PUT /api/inngest` (200=ok/401=bad) into `scripts/smoke.mjs`** as an automatic post-deploy signing-key gate. Manual PUT passed 200 this deploy, but the cold-start-safe `/health/deep` can't catch a stale-but-present key at the smoke-gate instant.
- `gc-06e.17` (P2) OpsEvent retention prune (heartbeats grow ~55k rows/yr; add daily prune to snapshot-metrics). `gc-06e.19` (P3) surface >1MB skips to merchant + exclude from diff-resolved.
- Deep-dive P1/P2 (unstarted): react-router ≥7.18.2 CVE bump, merchant notifications, CDN TLD false-positive (`shopifycdn.com` vs `.net`), per-finding dismissal, scan-engine perf hotspots, Health Score Trend Chart enable-or-cut decision, SignatureSubmission moderation route, remediation guidance, confidence badge, multi-theme gating. All in the report + `gc-06e.*`.

---

## Git state
- `main` @ `fa68baa` pushed to origin. Local main also has a docs/handoff commit on top (NOT pushed — docs only; push triggers a no-op redeploy, do it whenever).
- Merged P0 branches deleted (were `gc-06e.1-ops-alert-email`, `gc-06e.1-heartbeat-health`, `gc-06e.2-scan-pool-dos`, `gc-06e.3-reference-theme-tests`, `gc-06e-p0-integration` — all in main's history).
- `docs/community-response-drafts.md` is a pre-existing untracked draft (not mine; left alone).

## Doc hygiene owed (see `gc-06e.16`)
`docs/product-strategy.md` is ~5 months stale — flip v1.3/v1.4 to Shipped; counts drifted (finding types 20→26, signatures 94→~114).

## Resume
`bd list --status open --limit 50` → start with `gc-grd` (uninstall logging, unblocks the digest's uninstall line) then `gc-bny` (digest). Verify prod still healthy: `curl -s app.alpenglowsoftware.com/health` and `PUT /api/inngest` (expect 200).
