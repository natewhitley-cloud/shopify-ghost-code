# Scan Observability & Signal Capture

> **Status:** spec (2026-09-16)
> **Motivation:** the scan pipeline computes rich signal every run and then throws
> almost all of it away (logs only). Telemetry today has a business-health layer
> (`MetricSnapshot`, digest) and an ops-health layer (`OpsEvent`), but no
> **product / scan-quality** layer. This spec adds three signals to close that gap.
> **Scope:** additive, reversible, no behavior change to existing detection or findings.

## Background: the three discard points this closes

1. **Third-party domain long tail.** The unknown-script collectors (`collectUnknownScripts` /
   `collectUnknownStylesheets`, `scan-engine.server.ts:1568-1652`) keep only fully-unknown
   external URLs as `UnknownScript` rows; everything matched-to-an-app, benign-library, or
   Shopify-first-party is dropped. The preconnect / dns-prefetch / font / AJAX detectors
   (`scan-engine.server.ts:2588-2816`) compute every referenced host and forget the ones that
   do not resolve to a known app. The full set of third-party hosts a theme talks to is a
   proprietary dataset (signature-flywheel feedstock + market intel) and is currently discarded.
2. **Per-detector hit counts + theme shape.** `fileCount`, `benignLibrarySkips`, skipped-file
   sizes, and the per-detector finding histogram are all computed and logged, never persisted
   (`scan-theme.ts:249-254`, `:294-301`, `scan-engine.server.ts:152-156`). We cannot answer
   "which of our 33 detectors have ever fired on a real store?"
3. **Resolution / recurrence.** `scan-differ.server.ts` already classifies findings as
   new/resolved/unchanged for the scan-detail UI, but the result is never persisted as a metric.
   Whether findings actually get *fixed* between scans is the single best proof the product
   delivers value, and it is not captured.

---

## Feature 1 — Third-party domain graph

### Data model
New table `ScanDomain` (one row per `(scanId, domain)`, deduped across sources):

```prisma
model ScanDomain {
  id        String   @id @default(cuid())
  scanId    String
  scan      Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  domain    String                 // hostname, e.g. "cdn.example.com"
  sources   String[] @default([])  // which surfaces referenced it: script|stylesheet|preconnect|dns_prefetch|font|ajax
  refCount  Int      @default(0)    // total references across the theme
  matched   Boolean  @default(false)// true if `domain` resolved to a known app signature
  appName   String?                 // set when matched
  benign    Boolean  @default(false)// true if a known benign public CDN / web-font host
  createdAt DateTime @default(now())

  @@index([scanId])
  @@index([domain])              // cross-scan market-intel / flywheel queries
}
```
Add `scanDomains ScanDomain[]` to the `Scan` model relation list.

**Excluded:** Shopify first-party hosts (`isShopifyDomain`) are NOT persisted — noise. We keep
every *non-Shopify* host and classify it (`matched` app / `benign` lib / neither = flywheel
candidate).

### Collection
Add `collectThirdPartyDomains(file: ThemeFile): ThirdPartyDomainRef[]` in `scan-engine.server.ts`.
- Reuse the existing helpers to stay DRY: `hostnameFromUrl`, `isShopifyDomain`, `isBenignLibrary`,
  `identifyAppFromUrl` / `identifyAppFromCode`, `isSharedCdnDomain`. Do NOT duplicate the domain
  logic — thread through the same predicates the collectors/detectors already use.
- Walk each file for: `<script src>`, `<link rel=stylesheet href>`, `<link rel=preconnect|dns-prefetch href>`,
  `@font-face` src URLs, and fetch/XHR/AJAX URL literals — the same surfaces the existing
  detectors read (`:2588-2816`). Classify each host, skip Shopify, and accumulate per host:
  sources set, refCount, matched+appName, benign.
- Aggregate across all files inside the worker pass (`scanThemeFiles`, ~`:2885`), returned
  alongside `findings`/`unknownScripts` as a small `thirdPartyDomains` array (deduped by domain;
  bounded by distinct-host count, safely crosses the Inngest step boundary).

### Persistence
In `scan-theme.ts` core step, after `createUnknownScripts` (`:320`), persist via a new
`createScanDomains(scanId, domains)` model fn (`app/models/scan-domain.server.ts`,
delete-then-insert idempotency mirroring `createUnknownScripts`). Non-blocking / informational,
same as unknown scripts. Return the `thirdPartyDomainCount` scalar in the step result for Feature 2.

---

## Feature 2 — Per-scan signal OpsEvent (no schema change)

Emit exactly one `OpsEvent` per completed scan into the existing best-effort sink
(`recordOpsEvent`, `ops-event.server.ts`). No migration.

- `eventType = "scan_signal"`, `key = scanId`.
- `metadata` (Json):
  ```
  { shopId, scanId, plan, themeId,
    fileCount, scannableFileCount, skippedFileCount,
    benignLibrarySkips, unknownScriptCount, thirdPartyDomainCount,
    detectorHits: { <FindingType>: count, ... },   // authoritative, from DB groupBy
    findingCount, durationMs }
  ```
- **Where:** the `finalize-scan` step (`scan-theme.ts:752`), AFTER `finalizeScan` sets
  `completedAt`, so all audit-step findings are already persisted and timing is known.
- `detectorHits`: `db.finding.groupBy({ by: ["findingType"], where: { scanId }, _count: true })`
  — one cheap scan-scoped query; authoritative over the per-step logged counts.
- Theme-shape scalars (`fileCount`, `scannableFileCount`, `skippedFileCount`,
  `benignLibrarySkips`, `unknownScriptCount`, `thirdPartyDomainCount`): thread from the core
  step's return (`:335-349`) — all tiny scalars. `scannableFileCount` is new: add
  `files.filter(isScannableFile).length` in the core step.
- `durationMs`: `completedAt - startedAt` read back from the finalized scan.
- Best-effort: wrap so a signal-write failure NEVER fails the scan (match `recordOpsEvent`
  semantics — it already never throws, but the groupBy query must be guarded too).

---

## Feature 3 — Resolution tracking + digest rollup

### Data model
Add three counts to `Scan` (same migration as Feature 1):
```prisma
newFindingCount       Int @default(0)
resolvedFindingCount  Int @default(0)
persistedFindingCount Int @default(0)   // unchanged / carried forward
```
Default 0 backfills all legacy rows correctly (no diff was ever computed for them).

### Computation — REUSE the differ, do not reinvent
In the `finalize-scan` step:
1. Fetch the previous completed scan for this theme: `getPreviousScanForTheme(shopId, themeId, currentScan.createdAt)` (`scan.server.ts:303`).
2. Diff current vs previous findings with `scan-differ.server.ts` — passing the SAME
   `skippedCategories` + `skippedFiles` exclusions this scan recorded, so scope-skipped
   categories and oversized files are NOT miscounted as "resolved" (LOG-4). This is the whole
   reason to reuse the differ rather than a naive set-difference.
3. Persist `{ newFindingCount, resolvedFindingCount, persistedFindingCount }` via `finalizeScan`
   (extend its params; `scan.server.ts:249`). First-ever scan for a theme → new = findingCount,
   resolved = 0, persisted = 0 (no prior baseline).

### Digest rollup
In `operator-digest.ts`, add a `RESOLUTION (last 24h)` section over completed scans in the
window: total resolved, total new, and net (resolved − new). Pull from the new `Scan` columns
(no new query shape beyond the existing 24h scan fetch — extend the `select`). Purpose: a
daily read on whether merchants are actually fixing what we surface.

**Out of scope (follow-up bead):** a 30d `avgResolvedPerScan` field on `MetricSnapshot`. Keep v1
to per-scan columns + the 24h digest rollup.

---

## Migration

ONE hand-written additive migration folder (convention: `prisma/migrations/<ts>_add_scan_signals/migration.sql`),
following the existing style (rollback comment block; see
`20260830140000_add_unknown_script_domain`). Do NOT run `prisma migrate dev` — it hits the live
DB (known hazard). Contents:
- `CREATE TABLE "ScanDomain"` + its two indexes.
- `ALTER TABLE "Scan" ADD COLUMN "newFindingCount" INTEGER NOT NULL DEFAULT 0` (× 3 columns).
All additive + reversible; legacy rows default correctly. Applied in prod on deploy via
`npx prisma migrate deploy` (railway `preDeployCommand`).

## Testing (gate = CI: lint, format:check, typecheck, vitest)

- **Feature 1:** unit-test `collectThirdPartyDomains` — Shopify hosts excluded; matched app
  host has `matched=true`+`appName`; benign lib has `benign=true`; unknown host survives;
  sources set + refCount aggregate across multiple references and multiple files; malformed
  URLs skipped.
- **Feature 2:** test the metadata assembly — detectorHits histogram from a findings set;
  scalars threaded correctly; a groupBy/emit failure does not throw out of finalize.
- **Feature 3:** test the diff→counts path with a mocked previous scan: new/resolved/persisted
  computed via the differ; scope-skipped category NOT counted resolved; first-scan baseline
  (no prior) → all-new; digest section sums the columns.
- DB is mocked in tests (dummy `DATABASE_URL`, `tests/setup.ts`); follow existing `tests/mocks`
  patterns. Match `.claude/rules/imports.md` ordering (`npx eslint --fix` is authoritative).

## Non-goals
- No change to detection logic, finding types, plan gating, or existing UI.
- No GraphQL cost/throttle or per-file timing capture (not computed today; separate effort).
- No new merchant-facing surface. All three signals are operator/analytics-side.
