# Session Handoff: 2026-09-11 — Deep-dive review remediation shipped to prod

## What Got Done

- Ran the multi-agent **deep-dive review** of ghost-code-app → 5 HIGH, 16 MED, 18 LOW, 10 enhancements. Report committed at `docs/deep-dive-review-2026-09-11.md`.
- Shipped **4 HIGH findings + 1 audit follow-up to prod** via PR #22 (merge `0fdc27d`), deploy + post-deploy smoke gate GREEN, `/health` ok. 2446 tests.
  - **H1 (gc-3yi)** `fix(scanner)` — page dangling-refs now use an exact per-handle lookup (mirrors products/collections) instead of a 250-capped page list. Kills a **live Standard+ false positive** ("no longer exists (verified via Admin API)") + a case-mismatch FP. Then widened all three EXISTS queries `first:2`→`first:5` so an exact handle can't be crowded out by fuzzy near-matches.
  - **H2 (gc-h9k)** `fix(gdpr)` — `shop/redact` (`deleteShopData`) now purges OpsEvent rows carrying the shop domain (key / metadata.shop / metadata.shopDomain) inside the atomic transaction. Closes a GDPR erasure gap.
  - **H4+H6 (gc-9vc)** `chore(observability)` — removed the **inert Sentry** integration entirely (lib + inngest sentryMiddleware + all call sites + `@sentry/node` dep + lockfile + `.env.example`). Directive: observability self-hosted. `handleError` now `console.error`s (prod error visibility improved vs the old no-op).
  - **H3 (gc-1we)** `feat(worker)` — external Railway-cron dead-man's-switch (`app/services/deadman-monitor.ts`), evaluates `getStaleCrons` + pages via Resend, **independent of Inngest**. Bundled via `build:deadman`. Hardened: realpath entrypoint guard + 30s watchdog. **Ships LIVE-INERT** (nothing invokes it until the Railway cron service is created).
- **Adversarial audit**: 4 parallel read-only skeptics (one per workstream) → **zero confirmed blockers**. Residuals hardened (symlink guard, watchdog, .env.example, H2 honesty comment) or deferred.

## Key Decisions

- **Sentry: remove entirely** (not keep-for-self-hosted-GlitchTip). Reasoning: it was fully no-op, error capture already flows to OpsEvent + structured logs, and standing up GlitchTip is solo-operator ops overhead. Re-add later if richer error UI is ever wanted.
- **H3 monitor mechanism: Railway native cron** (not GitHub Actions — burns Actions minutes; not third-party uptime — not self-hosted). Reads the heartbeat table independent of Inngest; if Railway is down the app is down anyway.
- **H1 fix: per-handle exact lookup** (not the "propagate hasNextPage + mark truncated" fallback). Reasoning: fully eliminates both the >250 FP and the case bug and is DRY-consistent with the product/collection path; the fallback would suppress the whole page category on large stores (false negatives for the content-heavy target segment). Confirmed via shopify-admin skill that `pages(query:"handle:...")` is supported in API 2026-04.
- **H2 fix: hard-delete** OpsEvent rows (not anonymize-in-place). Reviewer-expected; digest-safe because shop/redact fires ~48h post-uninstall (outside the 24h uninstall window).
- **Batch-and-push-once**: all 6 commits accumulated on one branch, one CI run on the branch, then merged to main (one deploy). Per batch-deploy hygiene.

## Patterns & Discoveries

- Sentry footprint was **larger than the review implied** — also a full `sentryMiddleware` in `inngest/`. `tsc` would have broken if only `sentry.server.ts` were deleted.
- `first:2` fuzzy-match crowding risk is **pre-existing and shared** across product/collection (already live) + the new page path — not introduced by H1.
- The Prisma `metadata: { path: ["shop"], equals: domain }` JSON filter is correct for the Postgres provider (string-array path form; nulls/missing-key rows correctly don't match). Mock-based tests won't catch a wrong-but-typechecking filter.
- CI (`ci.yml`) runs lint + format:check + typecheck + test but **NOT `npm run build`** — the esbuild bundling of worker/deadman entrypoints is only exercised by the Docker build at deploy time (pre-existing accepted gap; a bundling error fails the Deploy job, late but not silent).

## In-Progress Work

- **gc-1we** (P1, in_progress): H3 code is LIVE-INERT on prod. **Remaining (dashboard, not code)**: create a Railway cron service — same repo image, start command `node build/server/deadman-monitor.js`, schedule `*/10 * * * *`, share env `DATABASE_URL` + `RESEND_API_KEY` + `OPS_ALERT_EMAIL`. Then verify a run logs `deadman-monitor: all crons healthy`. To e2e-test the alert, a cron must actually go stale (prod-only).

## Uncommitted Changes

- `memory/handoff-2026-09-11-gc-m4h-shipped-live.md` — prior-session note, intentionally left untracked (beads DB holds its summary).

## Resumable Agents

- None. All dispatched agents (2 impl, 1 hardening, 4 audit, 1 gc-3yi) completed.

## Open Questions / Deferred

- **Remaining review findings not yet actioned** (all in `docs/deep-dive-review-2026-09-11.md`):
  - **H5** — optional scopes declared but never `scopes.request()`ed. Needs a **prod behavior check**: are Standard+ product/collection/translation/redirect/live-price audits returning PARTIAL/ACCESS_DENIED on every scan? If yes, confirmed-live; fix = add a scopes.request settings control or remove the scopes from optional_scopes. (Decision criteria: is any merchant on a paid plan yet?)
  - MEDIUMs worth a next batch: M8 dead `APP_SUBSCRIPTIONS_UPDATE` route (+ M7 its stale integration test), M3 Node 20 EOL base image → bump to 22/24, M5 operator-alert email dedup/throttle, M6 shop/redact failure-path test + mock `ops-event` in tests, M2 detectors flag still-installed apps' pages/metafields.

## Recommended Next Steps

1. **Wire the Railway cron for gc-1we** (dashboard steps above), verify `/health/deep` + a healthy log line. This is the last-mile that makes H3 actually protective. Remember: Railway var/config-change redeploys **skip the GitHub smoke gate** — verify `/health` manually.
2. **Prod-verify H5** (optional scopes) — decides whether it's latent or already silently degrading paid-plan audits.
3. Next remediation batch: **M8+M7** (delete dead billing webhook route + repoint its test), then **M3** (Node 20 EOL bump) — both low-risk, high-hygiene.

## Risks & Warnings

- **H1 is raw-affecting on the LIVE detector** (Standard+). It _reduces_ false positives, but it's the one change that alters real findings. Kill switch remains `DANGLING_REFERENCE_LIVE_ENABLED=false`.
- The **dead-man's-switch is NOT yet protective** until the Railway cron is created — the very Inngest-outage blind spot it targets is still open until then.
- No schema migrations shipped this batch (deploy was clean); future H2-adjacent work touching OpsEvent should preserve the erasure purge.
