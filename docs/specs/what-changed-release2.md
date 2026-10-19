# Spec: "What changed" attributed change log (gc-rrh.4) + quiet-month all-clear (gc-qafb)

Status: draft for Nathan. Read against branch `feat/gc-5nok-sidekick` @ 9875f20 (Settings gc-4wvb, plans gc-d0ui). File:line refs are to that branch. Another agent is editing scanner files there now (`graphql-pagination`, `rate-limit-monitor`, `dangling-reference-resolver`, `jsonld-price-audit`). Slice 1 touches `theme-fetcher.server.ts` and `scan-theme.ts`, so it must start only after that work merges.

Decisions honoured as given: paid plans only; own nav page plus one Home line; Free gets one teaser over a blurred example; the email leads with the same block; quiet checks show an all-clear with the number of checks that ran; read-only; conservative attribution ("Not from a known app"); hashes only, no line diffs; malicious and advisory findings are never paywalled. Coordinator additions honoured: (a) the existing Settings summary toggle is reused and relabelled, and controls both the change email and the all-clear; (b) a third Sidekick tool, `get_recent_changes`.

gc-qafb is folded into this build. Its in-app receipt is the Home line's quiet state. Its email reuses the same ledger, consent and send step. Shipping it separately would mean writing the "nothing changed" rules twice.

---

## 0. What exists today (verified)

- **Theme fetch.** `app/services/theme-fetcher.server.ts:55-74`, `THEME_FILES_QUERY`, asks only for `filename` and text `body.content`. Files without text (binary) are reported by name through `onFileWithoutText` (`:258-262`). There is no checksum, size or updatedAt today.
  - I validated the schema with the Shopify validator: `OnlineStoreThemeFile` exposes `checksumMd5`, `size`, `updatedAt` and `contentType` under `read_themes`. These come back for binary files too, at no extra request.
- **Scan pipeline.** `inngest/functions/scan-theme.ts`:
  - `fetch-and-scan` step (`:1020-1381`). Files live only inside this step because of the 4 MB step-output limit. Output is budget-checked at `:1345`.
  - `finalize-scan` (`:2162-2320`): diff, app removals.
  - `emit-scan-signal` (`:2328`).
  - `send-summary-email` (`:2454-2599`): SCHEDULED origin only.
- **Differ.** `app/services/scan-differ.server.ts`:
  - `scanDiffOptions` (`:337`) is the coverage-aware rule: not audited now means never "resolved"; not audited in the baseline means never "new".
  - `diffScans` (`:434`).
  - `restrictToLiveInBoth` (`:374`).
  - The email adds ignores via `computeFindingChanges` (`summary-email.server.ts:168`). Advisories are excluded from email; ignored malicious findings still count.
- **Baselines.**
  - `getPreviousScanForTheme` (`app/models/scan.server.ts:477`): same shop and theme, COMPLETED or PARTIAL, loads findings.
  - `getScanIdsForThemeBetween` (`:495`).
- **Attribution.** `app/services/app-lookup.server.ts`:
  - `identifyAppFromFilename` (`:209`, `filePatterns`).
  - `identifyAppFromSnippetName` (`:145`, exact names; generic names only with `findCorroboratedApps`, which needs file content).
  - `identifyAppFromEmbedHandle` (`:188`, verified handles only).
- **Live app hooks.** `Scan.liveAppHooks` and `appSignatureFingerprints` (schema `:446-459`) drive removal detection (`app-removal.server.ts:270 detectAppRemovals`). `AppRemoval` rows (schema `:288-313`) carry REMOVED, CLEANED and REINSTALLED per scan.
- **Unknown scripts.** `UnknownScript` (schema `:487-506`) stores, per scan: filename, lineNumber, url, domain.
- **Theme info.** `Scan.themeInfo` holds name, version, author and architecture (`app/lib/theme-info.ts:95`).
- **Retention.** Scans are never pruned: no `scan.deleteMany` anywhere. Only OpsEvent has a prune (`ops-event.server.ts:667`).
- **GDPR.** `deleteShopData` (`app/models/shop.server.ts:708-756`) cascades Shop to Scan to children, deletes MerchantAlert and MerchantFeedback explicitly, and deletes OpsEvent by domain, `metadata.shop`, `metadata.shopDomain` and `metadata.shopId`.
- **Home/speed decoupling.** `tests/integration/speed-report-decoupling.test.ts:55-67`. The scan path, `app._index.tsx` and the scan page must not reach any speed module. The one exception is `summary-speed.server.ts`, used by the email.
- **Plans** (`app/lib/billing.server.ts:176-310`):
  - Standard: monthly scheduled scan (1st, 07:20 UTC), `maxThemes: 1`, `scanDiffing: false`, `alertCadence: "monthly"`.
  - Pro: weekly scan (Sunday 06:40 UTC), `autoRescan`, `scanDiffing`, 5 manual scans a day.
  - Scheduled and publish scans always target the MAIN theme (`weekly-scan.ts`, `monthly-scan.ts`, `webhooks.themes.publish.tsx:123-133`).
- **Nav.** `app/routes/app.tsx:134-140`.
- **Settings toggle.** `SummaryEmailsCard`, `app/routes/app.settings.tsx:154-228`, action `:110-140`. Copy is in `app/lib/summary-email-copy.ts`.
- **Sidekick.**
  - `extensions/sidekick-tools/{tools.json,src/index.js,instructions.md}`.
  - Route wrapper: `app/services/sidekick-route.server.ts`, with the `SidekickErrorCode` union at `:25`.
  - Tests: `tests/extensions/sidekick-tools.test.ts` (instructions must stay under 2,048 tokens, `:75`) and `tests/routes/api.sidekick.real-library.test.ts`.

---

## 1. Data model

### 1.1 Two new tables, not a Scan column

The bead says "Scan column". I recommend two child tables of Scan instead:

- Several hot-path reads load whole Scan rows: `getScansForShop` (`scan.server.ts:184-208`), `getScanById`, and `getPreviousScanForTheme` with findings.
- A 100-250 KB JSON column on Scan would be dragged into every Home, history and diff load.
- Child tables also make pruning a plain `deleteMany`.

```prisma
// Per-scan theme file manifest (gc-rrh.4). Hashes only, never file content.
// Written inside fetch-and-scan (files are in memory only there). Only the
// newest MANIFEST_KEEP_PER_THEME manifests per (shop, theme) are kept: a
// manifest is needed only as the next scan's baseline; history lives in
// ScanChangeSet. Holds no personal data; cascades Shop -> Scan -> here.
model ScanManifest {
  scanId     String   @id
  scan       Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  shopId     String   // denormalised for prune queries (plain id; cascade is via Scan)
  themeId    String
  version    Int      @default(1)   // entry encoding version
  fileCount  Int
  // Sorted by path. Each entry is a tuple:
  // [path, md5 | null, size, updatedAtEpochSec | null, ownerApp | null]
  entries    Json
  // Phase-2 input captured now (see 2.9): app blocks referenced by JSON
  // templates / section groups / settings_data, [{ handle, block, file }].
  appBlocks  Json?
  createdAt  DateTime @default(now())

  @@index([shopId, themeId, createdAt])
}

// What changed at one check, computed once at scan time (gc-rrh.4).
// Typed rows, no copy: copy is rendered at read time (app/lib/change-log-copy.ts)
// so wording can change without a data migration. Filenames, app names and
// hostnames only, never code. Kept as long as the Scan (scans are not pruned);
// cascades Shop -> Scan -> here.
model ScanChangeSet {
  scanId           String   @id
  scan             Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  shopId           String
  themeId          String
  baselineScanId   String?  // plain id, no FK (baseline manifests are pruned)
  // "baseline" (no comparable manifest) | "compared" | "theme_switch"
  kind             String
  // "weekly" | "monthly" | "publish" | "manual", from Scan.origin + plan at compute time
  checkKind        String
  onPublishedTheme Boolean
  themeName        String?  // denormalised from themeInfo for the page / email
  themeVersion     String?
  changeCount      Int      @default(0)
  worthALookCount  Int      @default(0)
  checksRan        Int      @default(0)
  counts           Json     // ChangeCounts (see 2.6)
  rows             Json     // ChangeRow[] (see 2.5), capped
  footnotes        Json     // uncounted noise summary (see 2.8)
  version          Int      @default(1)
  createdAt        DateTime @default(now())

  @@index([shopId, onPublishedTheme, createdAt])
}
```

Add back-relations `manifest ScanManifest?` and `changeSet ScanChangeSet?` on `Scan` (schema `:474-476`). These are optional relations, so no existing `include` changes.

Also:

- `MerchantAlert.kind String @default("summary")`, with values `"summary"` or `"all_clear"` (gc-qafb, see 6.3). The existing `@@unique([shopId, scanId])` stays.
- Shop stamps for the Free teaser funnel: `changesTeaserShownAt`, `changesTeaserClickedAt`, `changesTeaserConvertedAt` (all `DateTime?`, set once via `claimShopStamp`). This is the same pattern as `speedTeaser*` (schema `:155-157`).

### 1.2 Size per scan

| Theme | Raw JSON | Stored (jsonb, TOAST pglz) |
|---|---|---|
| 300 files | ~28 KB | ~20 KB |
| 1,000 files | ~95 KB | ~60-70 KB |
| 2,500 files (large app-heavy theme) | ~240 KB | ~150-170 KB |

- An entry is about 95 bytes: path ~35, md5 32, size ~6, epoch 10, app ~8, JSON overhead ~12.
- Hashes don't compress; paths compress well.
- Because only the newest 2 manifests are kept per (shop, theme) (see 1.4), storage is bounded at about 0.3 MB per scanned theme, whatever the scan count.
- ScanChangeSet is capped at 50 rows and 10 files per row. Typical size is 1-5 KB, with a ~25 KB ceiling. One row per successful scan; a Pro shop with 5 manual scans a day is still under 2 MB a year.

### 1.3 Where and which themes

- **Computed** in `fetch-and-scan` right after `fetchThemeFiles` (`scan-theme.ts:1039`).
  - Add an `onFileMeta` callback to `fetchThemeFiles` that receives `{ filename, checksumMd5, size, updatedAt }` for every node, text or binary. Add the four fields to `THEME_FILES_QUERY` (`theme-fetcher.server.ts:55-74`). No new request, no new scope.
  - Persist with `upsertScanManifest(scanId, …)` inside the step, the way `createScanDomains` already persists inside it. A retry re-runs the step, and the upsert keeps it idempotent.
  - Do not return the manifest across the step boundary. Return only `manifestFileCount` and `manifestBytes`.
- **Owner app per file** is computed in the same step, while content is in memory: `identifyAppFromFilename(path)`, otherwise `identifyAppFromSnippetName(basename)` for `snippets/` and `sections/` files, using `findCorroboratedApps(files)` for generic names. Never content-based.
- **Published flag.** Inside the same step, call `fetchMainTheme(admin)` (one cheap query) and return `isPublishedTheme: main?.id === themeId`.
- **Which themes:** every successful scan of any theme gets a manifest and a change set. It costs almost nothing, and Pro can scan unpublished themes. The v1 page, Home line, email and Sidekick read only `onPublishedTheme = true` change sets. Unpublished-theme history is deferred (10.2).

### 1.4 Retention and pruning

- `MANIFEST_KEEP_PER_THEME = 2`. After the change set is written (step `compute-changes`, see 2.1), delete the shop+theme's ScanManifest rows older than the 2 newest. This is one `deleteMany` with `scanId notIn (newest 2)`.
- No cron is needed. A deleted theme keeps at most 2 manifests until redact.
- Keeping 2 rather than 1 means a FAILED or replayed compute step can recompute against the same baseline.
- ScanChangeSet follows Scan, which is never pruned. If scan pruning is ever added, it cascades.

### 1.5 Migration (self-migrating deploys, reversible)

- One migration, `2026102x120000_add_change_log`: create the two tables and indexes, `ALTER TABLE "MerchantAlert" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'summary'`, and add the three Shop teaser columns.
- No backfill. Existing shops' first post-deploy scan is a baseline.
- Rollback SQL goes in the header comment, as in `20261018120000_add_theme_health`: `DROP TABLE "ScanChangeSet"; DROP TABLE "ScanManifest"; ALTER TABLE "MerchantAlert" DROP COLUMN "kind"; ALTER TABLE "Shop" DROP COLUMN …`.
- Add a migration test `tests/migrations/add-change-log.test.ts`, following `add-theme-health.test.ts`.

### 1.6 GDPR

- Both tables cascade Shop to Scan to row. Neither holds personal data (paths, hashes, app names, public hostnames).
- `MerchantAlert` is already deleted explicitly.
- Update the cascade map comment in `deleteShopData` (`shop.server.ts:689-696`) to list ScanManifest and ScanChangeSet. No new delete clause is needed.
- No new OpsEvent type (section 8), so the memory note "new-opsevent-type-needs-redact-and-prune-coverage" has nothing new to cover. If an implementer adds one anyway, the same change must add its identifier to the `deleteShopData` OR clause and decide on pruning.
- Test: extend the existing `deleteShopData` integration test to seed a manifest and a change set and assert both are gone.

---

## 2. Change computation

### 2.1 Where it runs

Add a new step, `compute-changes`, between `finalize-scan` and `emit-scan-signal` (`scan-theme.ts:2320/2328`):

- It runs only when `finalized?.finalized` is true; finalize returns that, so pass it out of the step.
- It never throws: on error it logs, records a `function_failure` under a constant key `CHANGE_LOG_FAILURE_KEY` (mirroring `APP_REMOVALS_FAILURE_KEY`), and the scan stays finalized.
- It must run after `finalize-scan` so the AppRemoval rows for this scan exist.
- The pure logic lives in a new `app/services/change-log.server.ts`. The model is `app/models/scan-change.server.ts`.
- Neither may import any speed module. They are added to `SCAN_ENTRY_POINTS` in the decoupling test.

### 2.2 The comparable baseline

- **Same theme:** the latest successful earlier scan of the same `themeId` that still has a manifest of the same `version`, giving `kind = "compared"`.
- **Published theme changed:** if the current scan is `onPublishedTheme` and the latest earlier `onPublishedTheme` change set has a different `themeId` with a surviving manifest, then `kind = "theme_switch"`. Compare the manifests across themes (hashes make this valid), and diff findings across themes with the same guards. AppRemoval detection stays per theme and adds nothing here.
- **Neither:** `kind = "baseline"`. This covers the first scan, legacy scans and a pruned baseline.
- **Coverage on file changes:** a manifest is all or nothing. A theme that is too large fails the scan, so there is no partial manifest. If either side's `md5` is null for a path, compare `size` + `updatedAt`.

### 2.3 Inputs

- Current and baseline manifests.
- Current and baseline findings, `liveFindingTypes` and coverage.
- Ignores (`getIgnoredFindingsForShop`).
- AppRemoval rows detected or changed on this scan (`getAppRemovalsDetectedOnScan`, plus CLEANED rows with `stateChangedScanId = scanId`).
- `liveAppHooks` and `appSignatureFingerprints` for both scans.
- UnknownScript rows for both scans.
- `themeInfo` for both scans.

### 2.4 File classification (noise control)

`app/lib/theme-file-kind.ts` (pure):

- **code:** `layout/*`, `snippets/*`, `sections/*.liquid`, `blocks/*.liquid`, `templates/*.liquid`, `assets/*.{js,css,liquid,scss.liquid}`, `config/settings_schema.json`.
- **editor data:** `config/settings_data.json`, `templates/**/*.json`, `sections/*.json` (section groups). The theme editor rewrites these on every save.
- **locales:** `locales/*.json` (Translate & Adapt and editor saves).
- **static:** other `assets/*` (images, fonts).

Editor data and locales are never counted as changes. They go into `footnotes` (see 2.8). Their effects that matter (an app embed or block switched off) show up through hook and app rows instead.

### 2.5 Row types and grouping (one row per cause)

The diff between manifests gives added, removed, changed and renamed files. A renamed file is a removed and an added file with the same md5. Rows are then built in this order, and each file is consumed by the first row that claims it:

| Row `type` | Cause | Claims | Lane |
|---|---|---|---|
| `security` | new `MALICIOUS_SCRIPT` or `APP_INCIDENT_ADVISORY` finding (new by the guarded diff) | its file | security (always worth a look) |
| `app_inactive` | AppRemoval REMOVED detected on this scan; carries `leftoverCount`, link to `/app/scans/{scanId}?app={name}` | files whose ownerApp = app | lane of the app's leftover findings (`computeLaneSummary`) |
| `app_cleaned` | AppRemoval turned CLEANED on this scan | removed files owned by app | housekeeping ("Fixed") |
| `app_added` | a hook for app X appears (embed or scriptTag source observed in both scans, absent before, present now) **and** the app's signature fingerprint is equal in both scans; or added code files whose ownerApp is X when the baseline had no X-owned files | X-owned added files | lane from X's signature (`isTracker` = "Still tracking you", else Speed) |
| `app_files` | changed, added or removed code files owned by X where X already had files | X-owned files | housekeeping |
| `theme_published` | `kind = theme_switch`; carries old and new name+version from themeInfo and file counts | all remaining code files | customers-see-it |
| `theme_update` | same theme, `themeInfo.version` differs | all remaining code files | customers-see-it |
| `unknown_script` | an UnknownScript `(domain, filename)` in the current scan not in the baseline, **and** its file is added or changed in the manifest diff, **and** the domain is not matched or benign in ScanDomain | none (annotates) | unknown |
| `file_edit` | remaining changed, added or removed code file, ownerApp null; `noIssuesInNewVersion` = no current non-ignored findings in that file | that file | housekeeping |
| `files_edit_group` | more than 3 `file_edit` candidates collapse into one row (paths listed up to 10 + `moreFiles`) | those files | housekeeping |
| `findings_new` | new findings (guarded diff) not already attached to a row above; theme-file findings only when their file changed; store-data findings (products, redirects, pages, storefront) grouped by lane | none | finding's lane |
| `findings_fixed` | resolved findings not attached above; same file-changed guard; store-data fixes grouped | none | housekeeping ("Fixed") |

- New and fixed findings whose file is claimed by a row attach to that row (`findingCount`, `findingTypes`), as in the mockup's "No issues found in the new version".
- Unknown scripts attach to the row that claimed their file. If no row claimed it (a page-builder file, say), they become their own row.
- Every row carries a stable `key` such as `app_inactive:PushOwl` or `file_edit:sections/header.liquid`. Rows from several checks can be merged by key (email and Standard monthly groups).

Row TypeScript shape (exported from `app/lib/change-log.ts`, client-safe):

```ts
export type ChangeRow = {
  key: string;
  type: ChangeRowType;
  app: string | null;                 // signature appName only
  lane: LaneKey | "unknown" | "security";
  worthALook: boolean;
  files: { path: string; status: "added" | "changed" | "removed" | "renamed"; changedAt: number | null }[]; // max 10
  moreFiles: number;
  host?: string; scriptFile?: string; line?: number;   // unknown_script
  leftoverCount?: number; findingCount?: number; findingTypes?: string[];
  noIssuesInNewVersion?: boolean;
  theme?: { name: string | null; version: string | null; previousName: string | null; previousVersion: string | null; filesChanged: number };
  scanId: string;                     // for links
};
```

### 2.6 Counts, verdict, "worth a look"

- `changeCount` = number of rows, excluding footnotes.
- `ChangeCounts = { appsAdded, appsInactive, appsCleaned, unknownScripts, filesChanged, themeUpdates, findingsNew, findingsFixed, security }`.
- A row is **worth a look** exactly when one of these holds:
  1. type `security`;
  2. `app_inactive` with `leftoverCount > 0`;
  3. `unknown_script` (a new unrecognised host in a changed code file);
  4. any row carrying a new HIGH-severity, non-ignored finding.

  (Phase 2 adds: app blocks missing after a publish.)
- Nothing else is ever worth a look: not app added, app file updates, unattributed edits with no new findings, fixes, or speed.
- **Verdict** (`app/lib/change-log-copy.ts`):
  - baseline: "GhostCode started tracking changes on {date}. Changes show from your next {cadence} check."
  - 0 changes: "No changes since your last check."
  - n changes, k worth a look: "{n} change(s) since your last check, {k} worth a look".
  - n changes, nothing worth a look: "{n} change(s) since your last check, nothing that needs you".
- **Tiles:** at most 4, the first non-zero in this fixed order: security, apps no longer active, apps added, speed delta (page only, see 4.4), unknown scripts, theme update or files changed, fixed. Speed is never counted in `changeCount`, so Home, page and email show the same number (see 5 and Q4).
- **`checksRan`** = the number of FindingType values the scan actually audited: `liveFindingTypes` minus `unauditedCategories(scan)` (`scan-differ.server.ts:191`). This is the "31 checks" in the all-clear row.

### 2.7 Coverage and false-positive guards (reuse the differ semantics)

- **Finding diff** = the exact `computeFindingChanges` recipe: `filterIgnoredExceptMalicious`, `scanDiffOptions`, `restrictToLiveInBoth`. Refactor it so `diffForChangeLog` returns lists, not counts; the email keeps its counts from the same function.
  - A scope grant, a newly live detector or a capped walk is never a change.
  - Unversioned scans (no `liveFindingTypes`): the finding rows are skipped and file rows still compute.
- **File-changed guard.** A new or fixed theme-file finding counts only if its file's hash changed (or the file was added or removed). This removes detector-logic changes in untouched files, which the in-app diff route still shows.
- **App added** requires equal signature fingerprints for that app in both scans (as `detectAppRemovals` does) and an observed hook source on both sides (non-null). An embed handle not on the verified `embedHandles` list never names an app (memory: active-app false positives). Owner-app tagging is filename or snippet-name only, never content.
- **Signature changes** never create rows: a file whose hash is equal is not a change, whatever its new ownerApp.
- **Unknown scripts** need a changed file, so a host newly flagged by a detector or signature change in an untouched file is not "new".

### 2.8 Noise footnotes (shown, not counted)

`footnotes = { editorDataFiles: n, localeFiles: n, pageBuilderFiles: { app, n }[] }`. Rendered as one muted line under the check: "Theme editor settings were saved (3 files). Not counted as changes."

Page-builder churn: EComposer, PageFly, GemPages and Shogun rewrite their own section files on every page save. Add `contentBuilder?: true` to `AppSignature` (`app/data/app-signatures.server.ts:25`). For those apps:

- `app_files` changes on a file the app already owned, while the app has a live embed hook, become a footnote instead of a row;
- added or removed builder files still count.

Without this, EComposer stores would never have a quiet week.

### 2.9 App blocks missing after a theme publish

- **Feasible:** JSON templates and section groups reference `shopify://apps/<handle>/blocks/<block>/…`.
- **Deferred to phase 2.** Mapping handles to merchant-meaningful names needs verified handles (most aren't on file), and the copy needs its own guard.
- v1 captures the data now (`ScanManifest.appBlocks`, parsed in `fetch-and-scan` from content already in memory), so phase 2 can compare published-before against published-after without waiting for new scans.

### 2.10 First scan and plan changes

- **Baseline check:** a change set with `kind = "baseline"` and no rows. The page and Home show the "started tracking" state. The email omits the lead block (the existing summary is unchanged).
- **Downgrade to Free:** data is kept and the teaser shows. On re-upgrade, history returns.
- **Standard to Pro:** history continues and the cadence label changes.

---

## 3. Attribution rules and fallbacks

- **Precedence:** an app named by AppRemoval or a hook, then ownerApp (filename pattern), then exact snippet or section name (with corroboration rules), then **"Not from a known app"**. Never content-based for a file; content attribution stays with findings, as today.
- **Never** "manual edit", never who edited, never "removed" or "uninstalled". App rows say "is no longer active" (existing gc-frda copy). The mockup's "App removed: PushOwl" chip becomes **"No longer active: PushOwl"**.
- **Theme update and publish** rows are attributed to the theme (name and version from themeInfo). An unknown version prints "a new version".
- **Speed copy** uses the existing "processing time" wording (`app/lib/speed-report.ts:435`), not the mockup's "script time". No checkout-timing claims.
- **Guards:** see 2.7. A unit test asserts that an active-embed app's own-file churn never yields `app_added` or `app_inactive`.

---

## 4. Page: `/app/changes`

### 4.1 Route and loader

`app/routes/app.changes.tsx`:

1. `authenticate.admin`, then `getShopMetadata`, then `getPlanFeatures(shop.plan).changeLog`. This is a new PlanFeatures field: `"none" | "monthly" | "weekly"` for Free, Standard, Pro. `scanDiffing` is unchanged: the per-scan diff route stays Pro-only.
2. Flag `CHANGE_LOG_LIVE_ENABLED` is off: redirect to `/app`.
3. **Free:** return `{ teaser: true }` only, with no further queries. Claim `changesTeaserShownAt` and `recordNudgeShown(NUDGE_KEYS.CHANGES_TEASER)` once.
4. **Paid:**
   - `getChangeSetsForShop(shopId, { onPublishedTheme: true, take: PAGE_SIZE + 1, before })`, selecting only the needed columns. `PAGE_SIZE = 12` checks for Pro, 12 months for Standard.
   - `getCachedMainTheme` (TTL cache; theme id for editor links).
   - Speed join (4.4), only when the speed report is live and the plan has it.
   - Budget: 3 DB queries + 1 cached Admin call.
5. **Pagination:** `?before={scanId}` cursor and a "Show older checks" link (loader/action pattern, no client fetch).
6. **ErrorBoundary:** the shared `AppErrorBoundary`.

**Standard "monthly groups":** checks are grouped by calendar month (UTC) with `mergeChangeSets` (keyed row dedupe, latest state wins). The group header is "October check-in". The bar strip shows one bar per month. **Pro:** one group per check. Check labels:

- "weekly check" (SCHEDULED, Pro)
- "monthly check" (SCHEDULED, Standard)
- "theme published" (AUTO_PUBLISH)
- "scan you ran" (MANUAL)

### 4.2 Components (tokens from `app/styles/shared.ts` only)

- `app/components/ChangeVerdictCard.tsx`: slate band with the verdict and "Checked {date} · {time} UTC", lane-tinted tiles (the `LANE_*` tokens plus `WARN_*` for unknown), the strip chart, and the next-check note. "Next weekly check {date}, plus a rescan whenever you publish a theme." comes from `app/lib/next-check.ts`, derived from `WEEKLY_SCAN_CRON` / `MONTHLY_SCAN_CRON`. "Your store had N quiet checks before this one." is the streak from the loaded sets.
- `app/components/ChangesStripChart.tsx` mirrors `HealthScoreTrendChart.tsx` (SVG, `role="img"` with a summary `aria-label`, the same axis and label styles): stacked by lane, a check mark for quiet checks, the latest highlighted. 9 bars on desktop; on phone (max-width 600px) a CSS class hides all but the last 5.
- `app/components/ChangeTimeline.tsx`: timeline rail, a group per check or month, `ChangeRowView` (lane stripe, cause chip, "Worth a look" chip, sentence, mono file line, lane tag, one action link), the quiet row "No changes. Theme, apps, speed and security checks all match the last check." with "{checksRan} checks", and the footnote line.
- `app/components/ChangesTeaser.tsx` (Free): the approved copy "See what changes in your theme, and why" with the trial CTA (`upgradeCtaLabel`, `trialEligible`), over a static blurred example built from a fixed fixture, never shop data. Blur is CSS `filter`, with `aria-hidden` on the example. `?src=changes_teaser` drives `recordNudgeClicked`.
- **Action links:**
  - app inactive: "See {n} findings" to `/app/scans/{scanId}?app={name}` (the param exists, `app.scans.$scanId.tsx:1236`)
  - unknown script: "Review script" to `/app/scans/{scanId}#unknown-scripts`
  - speed: "Open speed report" to `/app/speed`
  - file edits: "Open in code editor" via `buildThemeEditorUrl(shopDomain, themeId, path)` (`app/lib/theme-editor-url.ts:61`; the `admin.shopify.com/store/{handle}/themes/{id}?key={file}` format), `target="_top"`
  - theme published: "See what moved" to the scan diff route on Pro, or the scan page on Standard

### 4.3 States

- **Loading:** server-rendered, so there is no spinner.
- **Empty:**
  - paid, no change set yet: "GhostCode starts tracking changes at your next check ({next-check date})."
  - baseline only: the verdict card baseline state, no strip.
- **Error:** the ErrorBoundary banner.
- **A scan running:** a note above the card, "A check is running. This page updates when it finishes."

### 4.4 Speed join (page only)

`app/services/change-log-page.server.ts` reads `getRecentSpeedReports` (read-only data module) and computes:

- **The speed tile:** homepage processing-time delta between the newest report and the previous one, shown only when `isMaterialSpeedChange` (`summary-speed.server.ts:88`).
- **Per-app speed:** a report attaches to the latest check at or before its `createdAt`. The weekly speed run (Sunday 08:10) lands on that morning's 06:40 check, as in the mockup. Lines like "adds 210 KB and 0.6 s of processing time on the homepage (speed test, Oct 19)" are added when |delta| is at least 200 ms or 100 KB (`SPEED_ROW_MIN_MS`, `SPEED_ROW_MIN_BYTES`).
- **Standalone material moves with no app row** become an uncounted "Store speed" line.

Add a decoupling assertion that `app.changes.tsx` never reaches `SPEED_ACTIVE_MODULES`.

---

## 5. Home line and nav

**Nav** (`app/routes/app.tsx:134-140`): `<s-link href="/app/changes">What changed</s-link>` after Dashboard, for all plans while the flag is on. Free lands on the teaser.

**Home line** (paid only, flag on): one line in the top card's right column, under "Scanned {theme} on {date}" (`app/routes/app._index.tsx:1808-1815`):

| State | Copy (link to `/app/changes`) |
|---|---|
| compared, n > 0 | "Since your last check: 4 changes, 2 worth a look." See what changed |
| compared, 0 | "Checked Sun, Oct 19: no changes. 3 quiet checks in a row." See history |
| baseline | "Change tracking started Oct 19. Changes show after your next weekly check." |
| none yet / Free | no line |

Loader: one query in the Phase 1 `Promise.all` (`:271-282`), `getRecentChangeSummaries(shopId, take: 26)`, selecting only `changeCount, worthALookCount, kind, createdAt, checkKind`. The streak is consecutive `changeCount = 0` sets. It reads only ScanChangeSet counts, never speed. `app._index.tsx` is already in the decoupling test's entry points, so a stray import would fail CI.

---

## 6. Email

### 6.1 Lead block on the existing summary

In `buildSummaryContent` (`summary-email.server.ts:287`), a new first block after the intro:

- **Heading:**
  - one check in the period: "Since your last check ({date}): {verdict}"
  - several checks: "Since your last email ({n} checks): {verdict}"
- **Counts line:** "1 app added, 1 app no longer active, 1 new unknown script, 1 theme file changed" (non-zero counts only, fixed order). No file names and no code, as the email rules require.
- **Link:** "See what changed in GhostCode", via `buildChangesAdminUrl(shopDomain)`, which mirrors `buildScanAdminUrl` at `merchant-alert.server.ts:140`.
- **Period:** the change sets of every scan in `getScanIdsForThemeBetween(baseline, scan)` (the period the summary already uses), merged by row key (`mergeChangeSets`). Baseline-only periods produce no block.
- `SummaryChanges` gains `changeLog?: { verdict, counts, changeCount, worthALookCount, checks } | null`, loaded by `loadSummaryChangeLog`. It never throws; on error there is no block.
- `hasSummaryChanges` (`:101`) gains `|| (c.changeLog?.changeCount ?? 0) > 0`. An app added or a file change can now send on its own. This intentionally widens gc-ol95, per the decision.
- `buildSummaryHash` (`:206`) adds the sorted row keys.
- Advisories stay out of email counts (gc-14x5). Malicious findings stay in.
- Subject unchanged ("GhostCode digest for {store}").

### 6.2 Settings: one toggle relabelled (coordinator addition 1)

Same `alertsEnabled` toggle and same action intent. Copy in `summary-email-copy.ts`:

- `SUMMARY_CARD_HEADING`: "What changed emails"
- `summaryToggleLabel(cadence)`: "Email me what changed after each {weekly|monthly} check"
- `summaryLiveParagraph`: "After a check that finds changes, we email {who} what changed and which app caused it, plus new or fixed findings{, and noticeable changes in your store speed}. In a calendar month with no changes, we send one short all-clear instead."
- `SUMMARY_SAVED_ON` / `SUMMARY_SAVED_OFF`: "What changed emails are on." / "…are off."
- `SUMMARY_NOT_IN_PLAN`, `SUMMARY_FREE_PARAGRAPH`: "What changed emails are included with Standard (monthly) and Professional (weekly)."
- Home notice and opt-in (`SUMMARY_NOTICE_HEADING`, `summaryNoticeLead`, `SUMMARY_OPTIN_*`): same wording shift. For example: "We'll email {email} what changed after each {cadence} check, and one all-clear in a month with no changes. You can turn this off in Settings."

Layout of the gc-4wvb section card is untouched. Consent and defaults are unchanged: `summaryShopSkipReason` (`:431`), notice-shown or opted-in, legacy paid shops stay opted out until they choose, unsubscribe link and header. Gate the new copy on the flag so the card never promises the all-clear before it ships (honesty rule in the copy module header).

### 6.3 Quiet-month all-clear (gc-qafb)

Rule, evaluated in `send-summary-email` when the outcome would be `nothing_changed` (same gates first: configured, SCHEDULED, shop skip, rate skip):

1. This is the shop's first SCHEDULED check in calendar month M (UTC). The previous scheduled check is in an earlier month: Standard's check on the 1st always is; Pro's first Sunday.
2. The ledger has no `MerchantAlert` (either kind) with `sentAt` in month M-1.
3. The shop held a paid plan with consent for the whole of M-1. Use the existing `everPaidAt`, `summaryNoticeShownAt` / `summaryOptedInAt` and BillingEvent history; if unsure, skip.

If all three hold, send one email:

- subject "All clear: GhostCode checked {store} in {Month}"
- body "GhostCode ran {n} checks on your store in {Month}. Nothing changed in your theme, apps or security checks. Your next {cadence} check is {date}." plus the standard footer and unsubscribe link
- no upsell, no file names

Record it with `kind = "all_clear"` (same unique key). The row also serves as the next summary baseline and the throttle source. `n` = count of M-1 change sets for the published theme. If the check finds changes, the normal summary goes out and no all-clear is needed. This needs no new cron. The worst case is about 7 days' delay for Pro.

New outcome reasons: `all_clear_sent`, `all_clear_not_due`.

---

## 7. Sidekick: `get_recent_changes` (coordinator addition 2)

- `extensions/sidekick-tools/tools.json`, a third entry:
  - name `get_recent_changes`
  - description: "Get what changed in the store's published theme at GhostCode's latest check: the verdict, counts, the changes worth a look with their cause (an app, the theme, or not from a known app), impact area and location, plus a short list of recent checks (date, kind, number of changes or all clear). Read-only."
- `src/index.js`: `shopify.tools.register("get_recent_changes", () => fetchTool("/api/sidekick/recent-changes"))`.
- `instructions.md`: one "When to use" bullet ("what changed in my theme", "did anything change this week", "which app changed my theme") and one guideline: "Report `worthALook` first; never say an app was removed or uninstalled, say it is no longer active; 'Not from a known app' means the cause is unknown, never a person." The test keeps the file under 2,048 tokens: measure it and trim older bullets if needed.
- **Route:** `app/routes/api.sidekick.recent-changes.ts`, a copy of `api.sidekick.latest-scan.ts`, using `respondWithSidekickSummary`. Add `"sidekick_recent_changes_failed"` to `SidekickErrorCode` (`sidekick-route.server.ts:25`).
- **Service:** `app/services/sidekick-changes-summary.server.ts`, with an allow-listed DTO (no ids except in `url`, no code, no hrefs, no speed: `get_speed_summary` covers speed and this keeps the tool off the speed modules):

```ts
type SidekickRecentChanges =
  | { status: "ok"; url: string;
      latestCheck: { checkedAt: string; kind: "weekly"|"monthly"|"publish"|"manual";
                     verdict: string; changes: number; worthALook: number; checksRan: number;
                     counts: Record<string, number> /* non-zero only */ };
      worthALook: { cause: string; impact: string; location: string; description: string }[]; // max 5
      otherChanges: { cause: string; description: string }[];                                  // max 5
      moreNotListed: boolean;
      recentChecks: { date: string; kind: string; changes: number | null; allClear: boolean }[] } // max 8
  | { status: "no_data"; message: string; url: string }          // no change set yet / baseline only
  | { status: "not_available_on_plan"; message: "Change history is not available on this store's GhostCode plan." };
```

- The description strings come from `change-log-copy.ts` (the same sentences as the page), with every string capped at 200 characters.
- Free gets the neutral message: no plan names, no upgrade wording (App Store 2.2.8/2.2.9).
- Flag off returns `no_data`.

**Tests:**

- extension static test (tools.json and register list in sync, under 20 tools, instructions under 2,048 tokens);
- service unit tests (Free, baseline, quiet, mixed);
- real-library route test (`tests/routes/api.sidekick.real-library.test.ts` pattern);
- a size test: the JSON of the largest fixture is under 8,000 characters (well below 4,000 tokens).

**Docs:** `docs/privacy-sidekick-draft.md` gains "recent changes: dates, counts, app names, theme file paths and public script hostnames; never code."

---

## 8. Telemetry (no new OpsEvent type)

- **Free teaser:** `NUDGE_KEYS.CHANGES_TEASER = "changes_teaser"` (`nudge-telemetry.server.ts:37`), plus the three Shop stamps. Domain-keyed, so `deleteShopData`'s `key: domain` and the 90-day nudge prune already cover it. Converted = an upgrade by a shop that saw it, wired where `speedTeaserConvertedAt` is.
- **Page use:** the existing `page_visit` (path `/app/changes`). Same coverage. The digest must stay pinned to the filtered shop set (memory: domain-keyed streams must honour `isInternal`).
- **Pipeline health:** additive `scan_signal.metadata.changes = { kind, changeCount, worthALookCount, manifestFiles, manifestBytes, computeMs }`. `emit-scan-signal` reads it with one select. Covered by the existing `metadata.shopId` redact clause; no prune, as today.
- **Email:** outcome reasons in logs, ledger `kind`.

---

## 9. Test plan

**Fixture.** `tests/fixtures/change-log-scans.ts` holds two real-shaped Dawn-like scans of the same theme (~120 manifest entries each, taken from `tests/fixtures/reference-themes.ts` paths). Between them:

- Judge.me added (embed hook plus 3 files);
- PushOwl no longer active with 2 leftovers (AppRemoval REMOVED);
- a new `cdn.trustbadge.io` UnknownScript in a changed `layout/theme.liquid`;
- `sections/header.liquid` edited with no findings;
- `settings_data.json` and 2 templates resaved;
- a locale resave;
- an EComposer (contentBuilder) file rewrite;
- a detector-only new finding in an unchanged file;
- a newly live type.

A third scan is the theme-switch case (new themeId, themeInfo version 15.2.0 to 15.3.0).

**Unit**

- `theme-file-kind`: classification.
- `buildManifest`: sorting, null md5, rename detection.
- `diffManifests`.
- `computeChangeSet`: every row type, claim order, caps, footnotes, counts, worth-a-look rule, verdict strings, the >3 file group, baseline, theme switch.
- `mergeChangeSets`: key dedupe across checks.
- `change-log-copy`: no em dashes, "GhostCode", no "removed" or "uninstalled" (a source-hygiene style assertion).
- `next-check`.
- Summary email lead block, hash, `hasSummaryChanges`, all-clear eligibility (month edges, UTC, already sent, consent mid-month).

**A/B proofs** (revert the guard, the test must fail):

1. new finding in an unchanged file;
2. newly live FindingType;
3. app hook appears with a changed signature fingerprint;
4. unverified embed handle;
5. editor-data-only changes give 0 changes;
6. contentBuilder churn not counted;
7. unknown script in an unchanged file;
8. Free loader returns no shop data.

**Integration**

- `scan-theme` step test: manifest persisted in `fetch-and-scan` (retry upserts), `compute-changes` writes the set and prunes to 2, and a compute failure leaves the scan COMPLETED.
- `app.changes` loader for Free, Standard (month groups), Pro, pagination and flag off.
- Home loader line states.
- Settings copy and toggle.
- `deleteShopData` removes the new rows.
- Migration test.
- Decoupling test: add `change-log.server.ts`, `scan-change.server.ts` and `sidekick-changes-summary.server.ts` to the scan entry points, and `app.changes.tsx` to a "never reaches the active speed modules" list.

**Render tests** (`renderToStaticMarkup`):

- ChangeVerdictCard (compared, quiet, baseline);
- ChangesStripChart (aria-label, 5-bar phone class);
- ChangeTimeline (each row type, footnote, quiet row);
- ChangesTeaser;
- email HTML snapshot (block present or absent).

**Rendered preview before deploy:**

- Add `changes.preview.test.tsx` to `~/shopify/gc-preview-harness`: real loader and components with mocked I/O, states Pro mixed, Pro quiet, Standard month groups, Free teaser, baseline. Shoot 1280 and 390 wide.
- Run with `REPO=/Users/nathanwhitley/shopify/<branch> ./run.sh`.
- Check every PNG's modified time, then publish the same Artifact as the mockup round, with screenshots next to the approved mockup, for Nathan's sign-off before deploy.

---

## 10. Phasing

### 10.1 v1 (one feature branch, deploys in two steps)

- **Deploy A (dark data):** slices 1-2. Manifests and change sets are recorded from the first scan after deploy, with `CHANGE_LOG_LIVE_ENABLED` off. This gives 1-2 weeks of real history for Pro (one month-plus for Standard) before launch, and real data to calibrate the noise rules (from `scan_signal.changes`).
- **Deploy B (UI):** slices 3-6. Page, nav, Home line, email lead block plus all-clear, Settings relabel and the Sidekick tool. Flip the flag after the preview sign-off.

### 10.2 Deferred

- App blocks missing after a publish (data captured in v1).
- Change history for unpublished themes, with a theme picker (Pro).
- Line-level diffs.
- A row for a check that failed ("This check could not finish").
- A speed lane that counts toward changes.
- Pre-publish theme check (R7).

### 10.3 Risks

- **Noise:** editor and page-builder churn wipes out quiet weeks. Mitigated by footnotes plus `contentBuilder`; calibrate on the dark-data week.
- **Two scanner-file conflicts** with the parallel agent: start slice 1 after that branch merges.
- **Listing drift:** Standard gains a feature the Partner Dashboard bullets don't mention (`plan-tiles` test, `docs/pricing-and-plans.md:130`).
- **Email volume rises:** "any change" now sends. It is still at most one per plan window (throttle unchanged).

---

## 11. Slices and file ownership (sequential agents)

| # | Slice | Effort | Files |
|---|---|---|---|
| 1 | Manifest data layer | M | `prisma/schema.prisma`, `prisma/migrations/…_add_change_log/`, `tests/migrations/add-change-log.test.ts`, `app/services/theme-fetcher.server.ts` (query + `onFileMeta`), `app/lib/theme-file-kind.ts`, `app/lib/theme-manifest.ts` (build/diff, pure), `app/models/scan-manifest.server.ts` (upsert, latest-for-theme, prune), `inngest/functions/scan-theme.ts` (`fetch-and-scan` only: build, persist, `isPublishedTheme`, `appBlocks`), `app/models/shop.server.ts` (cascade comment), `app/data/app-signatures.server.ts` (`contentBuilder` on the page-builder entries), tests |
| 2 | Change computation | L | `app/lib/change-log.ts` (types, `mergeChangeSets`), `app/services/change-log.server.ts`, `app/models/scan-change.server.ts`, `app/services/summary-email.server.ts` (refactor `computeFindingChanges` to share list output), `inngest/functions/scan-theme.ts` (`compute-changes` step + scan_signal metadata), `tests/fixtures/change-log-scans.ts`, unit + step tests, decoupling test entries |
| 3 | Page + nav + teaser | L | `app/routes/app.changes.tsx`, `app/services/change-log-page.server.ts`, `app/lib/change-log-copy.ts`, `app/lib/next-check.ts`, `app/components/{ChangeVerdictCard,ChangesStripChart,ChangeTimeline,ChangesTeaser}.tsx`, `app/routes/app.tsx`, `app/lib/billing.server.ts` (`changeLog` feature), `app/services/nudge-telemetry.server.ts`, conversion stamp site, flag in `soft-launch-flags.server.ts` (or the speed flag's module pattern), tests, preview harness file |
| 4 | Home line | S | `app/routes/app._index.tsx` (loader query + one JSX line), `app/models/scan-change.server.ts` (`getRecentChangeSummaries`), `tests/routes/app._index.*` |
| 5 | Email block + all-clear + Settings copy | M | `app/services/summary-email.server.ts`, `app/services/merchant-alert.server.ts` (`buildChangesAdminUrl`), `app/models/merchant-alert.server.ts` (`kind`), `inngest/functions/scan-theme.ts` (`send-summary-email` step), `app/lib/summary-email-copy.ts`, `app/routes/app.settings.tsx` (copy only), Home notice/opt-in render sites, tests |
| 6 | Sidekick tool | M | `extensions/sidekick-tools/{tools.json,src/index.js,instructions.md}`, `app/routes/api.sidekick.recent-changes.ts`, `app/services/sidekick-changes-summary.server.ts`, `app/services/sidekick-route.server.ts` (error code), `tests/extensions/sidekick-tools.test.ts`, `tests/routes/api.sidekick.*`, `docs/privacy-sidekick-draft.md` |
| 7 | Docs | S | `docs/pricing-and-plans.md` (change log, all-clear, gc-ol95 rule change), `docs/research/theme-health-reposition.md` (commit the research per the bead comment), `docs/product-strategy.md` positioning line |

Order: 1, 2, (deploy A), 3, 4, 5, 6, 7, (preview sign-off), deploy B. Slices 1, 2 and 5 all touch `scan-theme.ts` in different steps, so they must stay sequential.

---

## Open questions for Nathan

1. **Listing bullets.** Standard now gets "What changed" (monthly). Do you want to update the Partner Dashboard plan card bullets (and `PLAN_LISTING_BULLETS`) in the same release, or keep the listing unchanged for now?
2. **Page-builder churn.** I propose page-builder apps rewriting their own files (EComposer, PageFly, GemPages, Shogun) are shown as an uncounted footnote, so those stores can still have quiet weeks. OK, or count them as Housekeeping changes?
3. **Dark data first.** OK to ship the manifest and change-set capture dark one deploy ahead of the UI, so launch has real history?
4. **Speed and the count.** Speed shows as a consequence (tile and per-app lines) but is not counted in "N changes", so Home, page and email match. Confirm, or should a material speed move count as a change on the page and in email only?

---

### Critical Files for Implementation
- /Users/nathanwhitley/shopify/gc-5nok/inngest/functions/scan-theme.ts
- /Users/nathanwhitley/shopify/gc-5nok/app/services/theme-fetcher.server.ts
- /Users/nathanwhitley/shopify/gc-5nok/prisma/schema.prisma
- /Users/nathanwhitley/shopify/gc-5nok/app/services/summary-email.server.ts
- /Users/nathanwhitley/shopify/gc-5nok/app/services/scan-differ.server.ts