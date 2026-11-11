# Handoff: gc-tib Clean copy build (2026-11-10 / 11)

## RESUME HERE
- **Why we're building:** Shopify replied on the write_themes exemption (ticket 71890683, Cy D., 2026-11-10). They want a screencast or screenshots of the app using the scopes. Nathan chose to build the feature first, then send a real dev-store demo. He will NOT create a dev-store app for now ("figure out a way"), so the demo makes the copy through the Shopify CLI, signed in as store staff.
- **Branch:** `feat/gc-tib-clean-copy`, worktree `~/shopify/gc-tib`, HEAD = this handoff commit on top of `ca6f240`. **NOT pushed. No deploys (Nathan, 2026-11-10).** Push to main = prod deploy.
- **No .env in the worktree, on purpose:** the repo .env points at the PROD DB.
- **Audit state:** round 1 (2 HIGH, 11 MED) is all fixed in ca6f240. Round 2 found no HIGH, so the audit loop is done. Open items are beads gc-tib.13-.18: 1 MEDIUM, 4 LOW, 1 probe.
- **Next session, in order:**
  1. Fix gc-tib.13 (MEDIUM) plus the cheap LOWs gc-tib.14, .15, .16. These are copy/state fixes in `app/lib/clean-copy-view.ts`, `app/routes/app.clean-copy.$runId.tsx` and `app/services/clean-copy.server.ts`. Each fix gets a regression test, then the full gate.
  2. Move the demo scripts from `.cache/demo/` (gitignored) to `scripts/demo/` and commit them. Files: `cli-admin.ts`, `run-demo.ts`, `scan-local.ts`, `dry-run.ts`. Add a small test of the CLI adapter's write guard.
  3. Re-run the demo on the fixed code:
     ```
     DATABASE_URL=postgresql://nathanwhitley@localhost:5432/ghostcode_cleancopy_demo CLEAN_COPY_ENABLED=true DEMO_STORE=nw-dev-store-2.myshopify.com npx vite-node --config vitest.config.ts .cache/demo/run-demo.ts
     ```
     This creates one more unpublished copy on nw-dev-store-2. Then re-render the screens:
     ```
     cd ~/shopify/gc-preview-harness/cleancopy && ~/shopify/gc-tib/node_modules/.bin/vitest run --config vitest.config.ts && CHROMIUM_PATH=... node shoot.mjs
     ```
     Polish nits:
     - "Open in code editor" renders as a default blue underlined link.
     - The copy name ends in a run-id suffix ("test-data - clean copy ffewpawe").
  4. Draft the reply to ticket 71890683, for Nathan to review and send:
     - the screenshot sequence: prod GhostCode scan results, the Clean copy select page, the result page, then Shopify admin (theme library, preview, code editor, live theme untouched)
     - a plain statement that the write step in the recording ran through a dev harness using staff CLI credentials, because the app record can't call themeDuplicate/themeFilesUpsert before approval; production makes exactly those two calls with write_themes
     - Nathan captures the admin screenshots himself.

## Done means (whole gc-tib)
- [x] Slices 1-5 built, gate green (12,106 tests + lint/format/typecheck/build at ca6f240).
- [x] Slice 6: legal drafts done. Product-strategy doc updated (5641cff).
- [x] Batch adversarial audit: round 1 fixed, round 2 has no HIGH.
- [ ] Round-2 MEDIUM gc-tib.13 fixed.
- [ ] Demo screenshots on the fixed code + reply to Shopify drafted (gc-tib.7).
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
