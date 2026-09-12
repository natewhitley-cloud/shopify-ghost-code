# Session Handoff: 2026-09-11 — Wave 2 SHIPPED + LIVE

## What shipped (PR #24 → merge `3f25396`, deploy+smoke green, live on prod)

One branch, one deploy (Nathan's call). 13 beads. Full CI + Deploy + smoke gate green; live `/health` ok.

**E2 epic (gc-gis) — false-positive suppression, LIVE, all plans:**

- gc-bn7 E2.1: `IgnoredFinding` model (INSTANCE fingerprint + APP/namespace), migration `20260911130000_add_ignored_finding` (ON DELETE CASCADE + CHECK invariant `(fingerprint IS NOT NULL) <> (appName IS NOT NULL)`), model wrapper `app/models/ignored-finding.server.ts`.
- gc-57t E2.2: single choke point `app/services/finding-aggregation.server.ts` (`filterIgnoredFindings`, `getFilteredFindingSummary`) excludes ignored findings from counts/health-score/lanes/diff/health-delta. Wired at scan-detail, diff, dashboard.
- gc-8qb E2.3: per-finding + app-level ignore actions; `/app/ignored` management view + un-ignore; nav link; tenant-scoped mutations (`getFindingByIdForShop`, `deleteIgnoredFindingForShop`).

**Others:**

- gc-3on E1: theme-editor deep-links (`app/lib/theme-editor-url.ts`, `finding-classification.ts` theme-file vs admin-resource partition + drift-guard test). `target="_top"` breakout matches `app.settings.tsx`.
- gc-aky M2: GHOST_PAGE MEDIUM→LOW (central `severity-classifier.server.ts` DEFAULT_SEVERITY; GHOST_METAFIELD already LOW); verify-before-removing copy (no em-dashes).
- gc-bbb L2: reset `planReconciledAt=null` on reactivate (shop.server.ts + app.tsx reinstall branch).
- gc-cj6 L6: Admin API `2026-04` → `2026-07` (latest stable; 2026-10 is RC). Required transitive `@shopify/shopify-api` 13.0.0→13.1.0 (in-range, lockfile only) to expose `ApiVersion.July26`.
- gc-jpl M9: removed dead exports `getDistinctFileCount`, `countFindingsBySeverity`, `getBillingEventsForShop`, `sortFindingsBySeverity` + orphaned tests.
- gc-7wj L5: `resolvePlanAmount` drift guard in billing.server.ts.
- gc-xbq L17: `SHOPIFY_APP_URL` added to `.env.example`.

## Adversarial audit (Nathan-requested, pre-deploy) — found + fixed 2 CONFIRMED criticals

Dashboard `app/routes/app._index.tsx`: finding-count trend `previousTotal` and health-score trend chart read UNFILTERED counts while the health tile read ignore-FILTERED counts → ignoring findings rendered a phantom "N fewer than last scan" and a chart point contradicting the tile. **Fixed:** unified all three read sites through one `severityForScan` accessor backed by `filteredSeverityByScanId` (built over `severityScanIds` only when the shop has ignores; no-ignores path unchanged, zero added queries). Also filtered the free-tier preview finding; fixed the `deleteShopData` cascade doc comment; fixed stale April26 comment. Re-verified CLOSED by the same auditor, no regression.

## Gate (Node 24 — must use `nvm use 24`, Node 20 fails EBADENGINE)

tsc + eslint + prettier clean; **2515 tests pass**; `npm run build` green.

## STILL OPEN / next

- **gc-lmh M4 — DEFERRED (blocked).** `@react-router/serve` already at latest 7.x; qs/body-parser/morgan advisories live in the express@4 subtree, can't clear within 7.x. Needs react-router **v8** (major) or risky transitive overrides. Mitigated by Railway proxy + HMAC webhooks. Nathan decision pending.
- **gc-7h9 (E1 fast-follow)** — Admin-resource deep-links for GHOST_PAGE/REDIRECT/PRICE/TAG/METAFIELD. NOTE: gc-3on assumed GHOST_TAG was theme code; it is actually a product resource (`products/{id}`), correctly bucketed here.
- **gc-1wf (H5)** — EXCLUDED this session (pre-paid-GTM track). Still the must-fix-before-paid-GTM item (scopes.request flow for Broken Links).
- **gc-1we (H3)** — dead-man's-switch still INERT until Railway cron service wired (unrelated to this batch).

## Notes

- Beads closed locally; `bd dolt push` failed ("no store available" — shared sql-server under castle-builder not running). Re-push when the store is up.
- 3 prior handoff `.md` files remain untracked in `memory/` (not committed with this batch).
