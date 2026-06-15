# Project Memory

## Architecture Quick Ref

- React Router v7 app (official Shopify template via `shopify app init`)
- Polaris Web Components via CDN (`<s-*>` tags), NOT npm React Polaris
- PostgreSQL + Prisma ORM for persistence
- Inngest for async background jobs (theme scanning)
- GraphQL Admin API only (REST blocked since April 2025)
- Session tokens via App Bridge CDN (no OAuth redirect flow)
- Railway hosting (~$10-15/mo)

## Common Issues

- Shopify CLI requires Node.js v20 LTS (project uses .nvmrc to pin)
- `shopify app dev` needs a Shopify Partners account and dev store
- Theme file API is paginated (250 files per page) — always handle pagination
- Rate limiting is cost-based (50 points/sec) — batch GraphQL queries where possible
- Polaris Web Components docs are sparse — check Shopify changelog and GitHub for examples
- `npm run typecheck` (react-router typegen + tsc) is the canonical check and passes clean — prefer it over bare `tsc --noEmit`, which can report stale errors without fresh route typegen. (updated: 2026-06-15, dispatch: retro-session)
- Dependency hazard: bumping `react-router` can pull a DUPLICATE `@shopify/shopify-api` (adapter `shopify-app-react-router` wants ^13, `shopify-app-session-storage-prisma` ^12) → `PrismaSessionStorage` TS2322. Keep both packages on a matching shopify-api major (session-storage-prisma@9 ↔ shopify-api@13). (added: 2026-06-15, dispatch: bead-GC-q4k)

## Agent Selection

- **scaffolder**: Initial project setup, route scaffolding, Prisma schema
- **implementer**: Feature implementation, service logic, scanner engine, UI routes
- **tester**: Test writing, coverage gaps, integration tests
- **reviewer**: Code review, architecture review, pre-merge checks
- **debugger**: Bug investigation, error tracing, performance issues

## Sprint Patterns

- Batching 3-4 related tasks per implementer agent is the sweet spot — single-task dispatch wastes overhead, 4+ risks turn limits. (added: 2026-03-10, dispatch: retro-session)
- Serial dispatch per CLAUDE.md rules avoids API throttling and enables learning carry-forward between batches. (added: 2026-03-10, dispatch: retro-session)
- Audit → sprint pipeline produces zero-rework fix sprints. Audit findings with file:line precision make downstream agents surgical. (added: 2026-03-10, dispatch: retro-session)
- Tester agent dispatched LAST in a sprint covers the final state of all fixes. Integration tests belong at the end. (added: 2026-03-10, dispatch: retro-session)
- ALWAYS independently re-run `npm run typecheck` + `npx vitest run` in the orchestrator before closing a dispatched ticket — do not trust the subagent's "all green" report. This session agents reported passing twice while the committed tree actually had failures (a 9A dep regression surfaced via 1A; a flaky run). Cheap insurance, caught real issues. (added: 2026-06-15, dispatch: retro-session)
- Subagents can die mid-task on API socket errors leaving UNCOMMITTED work in the tree. Recover by assessing `git status` + `git diff`, then finishing the job (a fresh agent reading the diff is more reliable than resuming the crashed one) rather than restarting from scratch. (added: 2026-06-15, dispatch: retro-session)
- When a subagent hits an ambiguous design call (no defensible signal, a product fork), instruct it to STOP and report rather than ship a heuristic. 3A correctly stopped on translations; that surfaced a real product decision. (added: 2026-06-15, dispatch: retro-session)

## Key Decisions

- Team assembled via /assemble. 5 members: scaffolder, implementer, tester, reviewer, debugger.
- Structured JSON logging via app/lib/logger.server.ts (replaces bare console.\* in webhooks). (added: 2026-03-10)
- Atomic TOCTOU guard in createScan + idempotent persistence — application-level, not DB constraint. (added: 2026-03-10)
- Scan completion model (LOG-4, 2026-06-15): `saveThemeFindings` persists findings + stays IN_PROGRESS; `finalizeScan` sets the terminal status ONLY after all audit steps. `ScanStatus.PARTIAL` = core scan OK but ≥1 optional audit skipped for missing scope; `Scan.skippedCategories` drives PARTIAL and makes the differ exclude un-audited categories from "resolved" (prevents false-resolved). `completeScanWithFindings` no longer exists. (added: 2026-06-15, dispatch: bead-GC-fp2)
- Scope checks go through `app/lib/scope-check.server.ts` (`probeScope`): ACCESS_DENIED → skip cleanly; transient/throttle/network → throw `TransientScopeCheckError` → Inngest retry → scan FAILED (never silently false-clean). (added: 2026-06-15, dispatch: bead-GC-i8c)
- Scan lifecycle (Cluster 2, 2026-06-15): theme-fetcher THROWS on null themeData (not break) so a soft-failure → FAILED not false-clean; scan-theme has a zero-file sanity guard (0 files + prior findings → fail). Stale-scan watchdog uses per-status thresholds — PENDING off `createdAt` (15m), IN_PROGRESS off `startedAt` (30m, `createdAt` fallback). `finalizeScan` is a race-safe conditional `updateMany(where status=IN_PROGRESS)` — refuses to resurrect a watchdog-expired/terminal scan, returns `{finalized:false}` + warns (no throw). poll-check-shop uses `getLatestSuccessfulScanForTheme` (COMPLETED/PARTIAL only) for staleness so a FAILED scan no longer suppresses re-scans; dispatch split into memoized create-scan + idempotent step.sendEvent. (added: 2026-06-15, dispatch: bead-GC-fp2)
- Diff fingerprint (LOG-10): `fingerprintFinding` hashes filename+findingType+NORMALIZED matched line (via `normalizeForFingerprint(snippet, lineNumber)`), NOT the raw multi-line snippet — adjacent-line edits and volatile bulk-redirect counts no longer cause false resolved+new churn. Full snippet still stored for display. (added: 2026-06-15, dispatch: bead-GC-b34)
- Detector matching (LOG-11/12): HTML-tag detectors match FULL file.content + `lineNumberAtOffset` (catches prettier-wrapped multi-line tags), not per-line. When two patterns match the same token (`RENDER_RE` tag-form + bare line-form in `{% liquid %}` blocks), dedup by OFFSET RANGE. Comment-skip via shared `buildCommentSkipLines(content)`; DUPLICATE_META is conditional+comment aware + allow-lists repeatable OG props. (added: 2026-06-15, dispatch: bead-GC-b34)
- LOG-11 COMPLETE (GC-9vj, 2026-06-15): the last 3 per-line detectors — `detectGhostSections`/`detectGhostCanonical`/`detectGhostAjax` — are now full-content too. NO double-count trap existed in any (single-regex, or mutually-exclusive patterns; verified via `node -e`), so no offset-dedup was needed. Remaining gap → GC-jjb: `detectGhostSections` lacks comment/conditional skip (a section tag inside `{% comment %}` is flagged — pre-existing, not a regression). (added: 2026-06-15, dispatch: bead-GC-9vj)
- Observability (Cluster 3, 2026-06-15): (OPS-3/SEC-3) `inngest/client.ts` fails fast at boot in production if `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` missing (dev-permissive); `serve()` in `api.inngest.ts` passes explicit `signingKey`. (OPS-4) `app/entry.server.tsx` exports `handleError` → forwards loader/action errors to Sentry (skips aborted requests); `onError` forwards render errors; Sentry `release` = `RAILWAY_GIT_COMMIT_SHA`. (OPS-8) `/health` runs `SELECT 1` with a 2s timeout → 503 on DB unreachability. (added: 2026-06-15, dispatch: bead-GC-be2/GC-c09)
- GDPR webhook failure contract (TST-5, 2026-06-15): `shop/redact` + `app/uninstalled` INTENTIONALLY do NOT wrap `deleteShopData` in try/catch — a transient DB error propagates as 5xx so Shopify RETRIES (correct: never falsely confirm a deletion that didn't happen). This is a deliberate contract; the tests assert the 5xx-propagation + invalid-HMAC paths. Do NOT "fix" it to swallow-and-200 without revisiting the contract. (added: 2026-06-15, dispatch: bead-GC-s14)
- GHOST_TRANSLATION orphan detection is INFEASIBLE (Shopify exposes no translation provenance; disabled-locale translations are auto-deleted; native keys aren't app-owned). Kept as LOW-severity informational "review these" — do NOT re-attempt orphan detection. (added: 2026-06-15, dispatch: bead-GC-y92)
- GHOST_PRICE requires corroborating orphan evidence (discount-app-specific metafield, e.g. Bold `inventory.ShappifySale`) — compare-at>price alone is a normal sale, never flag it bare. (added: 2026-06-15, dispatch: bead-GC-wsn)

## Shopify Platform Facts

- App review requires: 3 GDPR webhooks, privacy policy URL, Billing API for paid features
- `read_themes` scope grants access to theme files (Liquid, CSS, JS, JSON)
- Dev stores have unlimited test charges (use `test: true` in Billing mutations)
- App Bridge CDN handles auth automatically in embedded app context
- Shopify manages subscription cancellation, not the app. Link merchants to Shopify Admin billing settings.

## Project Stats (Session 5)

- 64/79 beads closed (81%)
- 397 tests across 20 test files
- 48 commits on main
- All P0, P1 (fixable), P2 complete. Remaining: 2 P1 (blocked on deploy), 7 P3, 2 P2 manual, epic
