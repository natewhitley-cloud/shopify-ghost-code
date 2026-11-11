# Handoff: gc-tib Clean copy build (2026-11-10 / 11)

## RESUME HERE (updated 2026-11-11 session 2)
- **2026-11-11 (session 5): approval-day checklist + item-4 cleanup.** `docs/runbooks/gc-tib-approval-day.md` (679c49e): legal publish -> deploy dark -> approval -> optional scope + `shopify app deploy` -> (DECISION: per-shop allowlist before the global flag, recommended) -> dev-store live run incl. gc-tib.17 probe -> Canvas checks -> launch copy. Closed gc-tib.21 (scan page uses checkCleanCopyFreshness + offerableCleanCopyFiles shared with the select page), gc-tib.11 (span guard: Liquid strings + attribute values are text; r2 HARD LIMIT: an ambiguous tag makes the rest of the file non-code), gc-tib.8 (real-Postgres lock test via `scripts/test-pg-lock.sh`), gc-e28n, gc-tib.7. Audits: feature r1 (2 MED fixed), span r1 (1 HIGH + 3 MED fixed), span r2 (3 HIGH fixed via hard limit, 4031e69); span r3 audit pending at time of writing. Remaining LOWs: gc-pb12. Expiring tokens for FraudPilot/IntakePilot NOT checked (Nathan: live sessions ongoing). Still NOT pushed.
- **2026-11-11 (session 4): gc-tib.20 DONE + gc-tib.12 DOWNGRADED (Nathan approved).** 2091d86 + 2e1a257. Scan + select pages show "View result" lines for the newest run and the newest older don't-publish copy; the result page reads the copy and records `FixRun.copyGoneAt` once deleted (NEW additive migration 20261111120000_gc_tib_fix_run_copy_gone, applies on deploy). Canvas hint on NO_MAIN_THEME + scan no-published-theme error/Home text. gc-tib.12 now P2 launch follow-up (live Canvas checks A-C after approval). Audit r1: 0 HIGH, 2 MED fixed, LOWs fixed or beaded (gc-e28n). Gate 12,192 green. Still NOT pushed.
- **2026-11-11: ticket 71890683 reply SENT by Nathan** (screenshots: 1-select, 2-result, 3-admin-themes in ~/shopify/gc-preview-harness/cleancopy/png/). Waiting on Shopify's write_themes decision. Still NOT pushed; open decisions: gc-tib.12 downgrade, gc-tib.20 UX.
- **Why we're building:** Shopify replied on the write_themes exemption (ticket 71890683, Cy D., 2026-11-10). They want a screencast or screenshots of the app using the scopes. The demo makes the copy through the Shopify CLI, signed in as store staff (no dev-store app, per Nathan).
- **Branch:** `feat/gc-tib-clean-copy`, worktree `~/shopify/gc-tib`. **NOT pushed. No deploys (Nathan, 2026-11-10).** Push to main = prod deploy.
- **No .env in the worktree, on purpose:** the repo .env points at the PROD DB.
- **This session (all committed, gate green: 12,128 tests + lint/format/typecheck/build):**
  - ec5e562: gc-tib.13-.16 fixed (banners follow the live theme; only a MAIN copy counts as published; any failure after a landed write flags do-not-publish). Beads closed.
  - 58499be: demo scripts now in `scripts/demo/` (cli-admin, run-demo, scan-local, dry-run) + `tests/scripts/demo-cli-admin.test.ts` (CLI write guard). Harness now imports `scripts/demo/cli-admin`.
  - d1e3ab1: editor links use `<s-link>`.
  - Demo re-run on fixed code: 13/13 removed into unpublished copy "test-data - clean copy pa4zrdal" (153007784113); live theme pulled before/after, byte-identical (291 files). Screenshots re-rendered in `~/shopify/gc-preview-harness/cleancopy/png/`.
  - Ticket reply DRAFT: `memory/shopify-ticket-71890683-reply-draft.md` (Nathan reviews, takes admin screenshots 4-7, sends).
  - Audit r3 (this batch): no HIGH, no MEDIUM; 8 LOWs, all fixed in the r3 commit (finding 5 moot: getTheme cannot return USER_ERROR). Gate green: 12,131 tests.
- **Session 3 (2026-11-11, all committed, gate green: 12,142 tests):**
  - gc-tib.19 filed: LAUNCH COPY SWEEP (every 'read-only / never edits' claim on site, guides, llms.txt, in-app settings, listing; ship on launch day only).
  - 1b040f3 gc-tib.10: scan-page count uses one shared `findingBlockReason` (preflight + select page + count); button only on the latest successful scan before a theme publish.
  - gc-tib.9 decided (Nathan delegated): keep the newest-20 prune. Real gap filed as gc-tib.20 (no way back to a run result / don't-publish warning) = PRE-LAUNCH, needs Nathan's UX call.
  - gc-5p4g + gc-i29e closed: prod read-only check, 11/11 offline sessions expiring with refresh tokens; tripwire test d942551. Library gotcha in memory (flag doesn't migrate old tokens).
  - gc-dg5e closed: Canvas addendum 5512c55. No API marker; AGENTS.md is NOT a Canvas signal (Horizon ships it). RECOMMENDATION on gc-tib.12 pending Nathan: downgrade release blocker to launch follow-up.
  - Audit r4 (5cd3859..HEAD): no HIGH/MED; 6 LOWs fixed in 932551b; finding 4 remainder = gc-tib.21.
  1. Nathan: admin screenshots + send the reply.
  2. Theme library on nw-dev-store-2 now holds 3 GhostCode copies (probe 153006309553, ffewpawe 153006604465, pa4zrdal 153007784113). Nathan deletes the old two whenever; keep pa4zrdal for the screenshots.
  3. Nathan decides: gc-tib.12 downgrade (spike addendum end), gc-tib.20 UX.
  4. Remaining beads: gc-tib.17 (Admin API probe after approval), gc-tib.18, .8, .11, .21 (LOWs), gc-tib.6 legal publish before deploy, gc-tib.19 launch copy.
  5. Copy-name run-id suffix nit: kept on purpose (it is the adoption key for crash-retry).

## Done means (whole gc-tib)
- [x] Slices 1-5 built, gate green (12,106 tests + lint/format/typecheck/build at ca6f240).
- [x] Slice 6: legal drafts done. Product-strategy doc updated (5641cff).
- [x] Batch adversarial audit: round 1 fixed, round 2 has no HIGH.
- [x] Round-2 MEDIUM gc-tib.13 fixed (ec5e562), plus LOWs .14-.16.
- [x] Demo screenshots on the fixed code + reply to Shopify drafted (gc-tib.7); [ ] Nathan sends it.
- [ ] Waiting on approval/later decisions: write_themes added to shopify.app.toml optional_scopes (only after approval); legal published; Canvas detection gc-tib.12 (release blocker); CLEAN_COPY_ENABLED turned on; deploy.

## Commits on the branch (oldest first)
- c11caae: slices 1+2, removal spans + splice engine
- 8d8fe93: slice 3, Finding span columns + FixRun/FixItem; migration 20261110200000 (only adds; authored offline)
- 2e1fdb3: slice 4, orchestrator + adapter + Inngest `clean-copy` + flag CLEAN_COPY_ENABLED; migration 20261110210000 (FixItem.findingType)
- 5641cff: docs/product-strategy.md (D8)
- 8fdc268, ae2c0c6: slice 5 spec + acceptance tests (+ my fix to one of my own tests)
- d4c0636: slice 5 UI. Selection route is `app.scans.$scanId_.clean-copy.tsx`: the trailing underscore is needed because the dotted name nests under a parent with no Outlet. Status route is `app.clean-copy.$runId.tsx`; scan-page entry button.
- ca6f240: audit round-1 fixes

## Modified / new files (vs origin/main)
- **App:**
  - `app/lib/removal-span.ts`, `app/lib/theme-splice.ts`, `app/lib/clean-copy-view.ts`
  - `app/services/clean-copy.server.ts`, `app/services/clean-copy-admin.server.ts`
  - `app/models/fix-run.server.ts`, `app/models/finding.server.ts` (span fields)
  - `app/services/scan-engine.server.ts` (span persistence)
  - `app/services/soft-launch-flags.server.ts`
  - `app/routes/app.scans.$scanId.tsx` (entry), the two new routes, `app/routes/api.inngest.ts`
  - `inngest/events.ts`, `inngest/functions/clean-copy.ts`
- **Schema:** `prisma/schema.prisma`, 2 migrations
- **Docs:** `docs/specs/gc-tib-clean-copy-ui.md`, `docs/product-strategy.md`
- **Tests:** tests under tests/lib, services, models, inngest, routes, integration (fix-run-gdpr)

## Other places
- **Legal drafts:** `~/shopify/dis-ghostcode-clean-copy`, branch `ghostcode-clean-copy-legal`, commits 6c404f5 + 32f3728. NOT pushed (push = publish). The date is the `[EFFECTIVE DATE]` placeholder. See `CLEAN-COPY-CHANGES.md` there.
  - **DEPLOY ORDER:** spans are stored on EVERY scan, so privacy "Scan results" must be published BEFORE this branch deploys, even with the flag off.
- **Local demo DB:** `ghostcode_cleancopy_demo` on local Postgres 16, all migrations applied.
- **Dev store nw-dev-store-2:**
  - Live theme "test-data" (149633761457) has 13 seeded removable leftovers.
  - Copies left in the library: "GhostCode probe (safe to delete)" 153006309553, and "test-data - clean copy ffewpawe" 153006604465.
  - The live theme was verified byte-identical after every run.
- **Harness:** `~/shopify/gc-preview-harness/cleancopy/`. It runs the REAL loaders against the demo DB and mocks only auth plus the adapter, which goes through the CLI. The guard helpers are passed into `createCliCleanCopyAdmin`, which avoids a mock import cycle.
- **Throwaway audit repros:** `.cache/audit-logic`, `.cache/audit-sec`, `.cache/audit-r2` (gitignored).

## Open beads
- gc-tib.6: legal publish, deploy order
- gc-tib.7: demo + Shopify reply
- gc-tib.8-.11: round-1 LOWs, deferred
- gc-tib.12: RELEASE BLOCKER, Canvas detection; the `canvasThemeRefusal` hook is a no-op until gc-dg5e
- gc-tib.13-.18: round 2

## Unverified Shopify behaviours (slice 7 / Admin API only)
1. checksumMd5 == md5(utf8 body)
2. themeDuplicate keeps checksums
3. themes(names:) exact match; name max length (assumed 50)
4. upsert job id + job(id){done}
5. processing flags and duration after a duplicate
6. error at the 20-theme cap
7. MAIN updatedAt on file edits, and whether a duplicate bumps it (gc-tib.17)
8. whether upsert rejects invalid Liquid
9. ACCESS_DENIED shape

The CLI path can't observe checksums or updatedAt.
