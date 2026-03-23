# Spec: Unknown Finding Feedback Loop

**Status:** READY FOR REVIEW
**Created:** 2026-03-23
**Author:** Claude Opus 4.6 (user-initiated)

---

## Problem Statement

When a scan finds unattributed ghost code (findings without a matched app signature), let merchants report which app left it. Store submissions for manual curation into the signature DB. This is the flywheel that makes every scan improve future scans. Key questions: data model for submissions, UI placement (scan detail page? inline per finding?), what fields to collect, and how to review submissions (admin view vs DB queries for now). No external Shopify APIs needed -- this is all internal.

---

## Context & Constraints

### Current State

The unknown finding feedback loop is **already substantially implemented**. The following components are in place:

1. **Data model**: `UnknownScript` and `SignatureSubmission` Prisma models exist in `prisma/schema.prisma` (lines 75-99). Migration already applied (`20260322000000_add_unknown_scripts`).
2. **Collection**: The scan engine (`app/services/scan-engine.server.ts`) collects unrecognized external scripts and stylesheets via `collectUnknownScripts()` and `collectUnknownStylesheets()`. These are returned alongside findings in `ScanResult.unknownScripts`.
3. **Persistence**: The Inngest `scan-theme` function (`inngest/functions/scan-theme.ts`, line 74) calls `createUnknownScripts()` after scan completion.
4. **Model layer**: `app/models/unknown-script.server.ts` provides `createUnknownScripts()`, `getUnknownScriptsForScan()`, and `submitSignatureSuggestion()`.
5. **UI**: The scan detail page (`app/routes/app.scans.$scanId.tsx`) renders an "Unrecognized Scripts" section at the bottom of completed scan pages (lines 1104-1153), with inline forms per unknown script for merchants to submit app name suggestions.
6. **Action handler**: The route's `action()` function (lines 291-306) handles form submissions, calling `submitSignatureSuggestion()`.
7. **Tests**: `tests/services/unknown-scripts.test.ts` covers `collectUnknownScripts` and `collectUnknownStylesheets` (14 tests). Route tests in `tests/routes/app.scans.$scanId.test.ts` cover the action handler.

### What is NOT Built

The missing piece is the **curation side** -- the workflow for reviewing merchant submissions and promoting validated ones into the signature DB (`app/data/app-signatures.server.ts`). Currently:

- There is no admin/internal view to list, review, or act on `SignatureSubmission` records.
- There is no aggregation query to surface high-confidence submissions (e.g., multiple merchants suggesting the same app name for the same URL domain).
- There is no mechanism to promote a validated submission into the `APP_SIGNATURES` array.
- There is no feedback to merchants about whether their submission was used (not a v1 requirement, but worth noting).

### Constraints

- **No external APIs needed** -- this is purely internal data collection and curation.
- **Plan gating**: Unknown scripts are only shown to paid plan users (`canViewDetails` check in loader, line 264-265). This is correct -- free-tier users cannot see finding details.
- **Scope**: Only external scripts and stylesheets are currently collected as "unknown." Other unattributed finding types (snippets, sections, hreflang, JSON-LD, text) with `appName: null` are NOT surfaced in the feedback loop. This is intentional -- external URLs have the most signal value for signature creation.
- **Solo-dev operation**: The curation workflow should be lightweight. DB queries are acceptable for MVP; a full admin UI is not needed yet.
- **Signature DB is static code**: `app/data/app-signatures.server.ts` is a TypeScript file with a hardcoded array. Promoting a submission means adding code, not inserting a DB row. Curation cannot be fully automated.

---

## Prior Art

### Existing Patterns in the Codebase

1. **`AppSignature` type** (`app/data/app-signatures.server.ts`): Defines the structure a curated submission must conform to: `appName`, `cdnDomains`, `scriptPatterns`, `snippetNames`, `cssPatterns`, plus optional `hrefLangPatterns`, `jsonLdPatterns`, `textPatterns`, `isTracker`.

2. **Lookup functions** (`app/services/app-lookup.server.ts`): `identifyAppFromUrl()` and `identifyAppFromCode()` are called during scanning to check if a URL matches a known signature. A promoted submission creates a new entry that these functions will match on future scans.

3. **`UnknownExternalResource` type** (`app/services/scan-engine.server.ts`, lines 45-51): Captures `filename`, `lineNumber`, `url`, `resourceType` ("script" | "stylesheet"), and `codeSnippet`. This mirrors the `UnknownScript` Prisma model.

4. **`useFetcher` pattern for inline forms**: The `UnknownScriptRow` component (lines 333-396) uses React Router's `useFetcher` for independent form submission per row -- each row has its own submit state. This is the established pattern for inline mutations on this page.

5. **Loader/action pattern**: All data fetching happens in `loader()`, all mutations in `action()`. The submission action already follows this convention.

---

## Proposed Approach

Since the merchant-facing feedback loop (collection, persistence, UI, submission) is already built, this spec covers the **curation pipeline** -- the internal tooling needed to review submissions and promote them into signatures.

### Approach: DB Query Scripts + Documentation

The curation workflow is:

1. **Aggregation queries** -- Add model functions to surface actionable submissions:
   - List all submissions grouped by URL domain, ordered by submission count (most-submitted domains first).
   - Show the suggested app names per domain with frequency counts.
   - Filter to unreviewed submissions (not yet promoted to signatures).

2. **Review status tracking** -- Add a `status` field to `SignatureSubmission` to mark records as `PENDING`, `ACCEPTED`, or `REJECTED`. This prevents re-reviewing the same submissions and tracks curation throughput.

3. **Curation script** -- A CLI-invocable script (or Prisma query helpers) that:
   - Runs the aggregation query.
   - Outputs a formatted report of high-confidence submissions (2+ merchants agreeing on the same domain/app name).
   - Provides guidance on what to add to `APP_SIGNATURES`.

4. **No admin UI for now** -- Per the problem statement, DB queries are sufficient. An admin route can be added later if submission volume justifies it.

### Component Changes

| Component | Change | Status |
|---|---|---|
| `prisma/schema.prisma` | Add `status` enum + field to `SignatureSubmission` | New |
| `app/models/unknown-script.server.ts` | Add aggregation/listing queries | New |
| `scripts/review-submissions.ts` | CLI script for curation review | New |
| `app/routes/app.scans.$scanId.tsx` | No changes needed | Already built |
| `app/services/scan-engine.server.ts` | No changes needed | Already built |
| `inngest/functions/scan-theme.ts` | No changes needed | Already built |

---

## API / Interface Contract

### New Model Functions (`app/models/unknown-script.server.ts`)

```typescript
/**
 * List submissions grouped by URL domain with frequency counts.
 * Returns domains with the most submissions first.
 */
export async function getSubmissionsByDomain(options?: {
  status?: SubmissionStatus;
  minCount?: number;
}): Promise<Array<{
  domain: string;
  submissionCount: number;
  suggestedNames: Array<{ name: string; count: number }>;
  sampleUrls: string[];
}>>;

/**
 * Update the status of a submission (ACCEPTED, REJECTED).
 */
export async function updateSubmissionStatus(
  submissionId: string,
  status: "ACCEPTED" | "REJECTED"
): Promise<SignatureSubmission>;

/**
 * Batch-update status for all submissions matching a URL domain.
 * Used after promoting a domain to the signature DB.
 */
export async function acceptSubmissionsForDomain(
  domain: string
): Promise<{ count: number }>;

/**
 * Get total submission counts for dashboard metrics.
 */
export async function getSubmissionStats(): Promise<{
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
}>;
```

### CLI Script (`scripts/review-submissions.ts`)

```
npx tsx scripts/review-submissions.ts [--min-count=2] [--status=PENDING]
```

Output: formatted table of submission aggregations with recommended signature additions.

### No New Routes or Endpoints

The merchant-facing UI and action handler are already built. No new routes are added in this spec.

---

## Data Model Changes

### New Enum: `SubmissionStatus`

```prisma
enum SubmissionStatus {
  PENDING
  ACCEPTED
  REJECTED
}
```

### Modified Model: `SignatureSubmission`

```prisma
model SignatureSubmission {
  id               String           @id @default(cuid())
  unknownScriptId  String
  unknownScript    UnknownScript    @relation(fields: [unknownScriptId], references: [id], onDelete: Cascade)
  shopId           String
  suggestedAppName String
  status           SubmissionStatus @default(PENDING)   // NEW
  reviewedAt       DateTime?                             // NEW
  createdAt        DateTime         @default(now())

  @@index([unknownScriptId])
  @@index([status])                                      // NEW
}
```

### Migration

A new Prisma migration adds:
1. `SubmissionStatus` enum (`PENDING`, `ACCEPTED`, `REJECTED`).
2. `status` column on `SignatureSubmission` with default `PENDING`.
3. `reviewedAt` nullable timestamp column.
4. Index on `status` for efficient filtering.

The migration is backward-compatible -- existing rows get `PENDING` as default. No data migration needed.

---

## Migration / Rollout Plan

1. **Prisma migration**: `npx prisma migrate dev --name add_submission_status` -- adds `status` and `reviewedAt` fields. All existing rows default to `PENDING`. No downtime.
2. **Deploy model functions and CLI script**: Standard deployment. No feature flags needed -- these are internal-only tools.
3. **No UI changes**: The merchant-facing submission flow is already live. Adding status tracking is invisible to merchants.
4. **Backward compatibility**: The existing `submitSignatureSuggestion()` function does not set `status` -- it will use the schema default (`PENDING`). No callers need updating.

---

## Non-Requirements

- **No admin UI route** -- DB queries and CLI script are sufficient for solo-dev curation at current scale. Revisit if submission volume exceeds ~50/month.
- **No automated signature promotion** -- Promoting a submission means editing `app-signatures.server.ts` (TypeScript code). This remains a manual step. No code generation or auto-commit tooling.
- **No merchant notification** -- Merchants are not notified when their submission is accepted/rejected or when a new signature is added. The "thank you" message on submission is sufficient for now.
- **No submission rate limiting** -- A merchant can submit one suggestion per unknown script. The UI disables the form after submission (`isSubmitted` check). No server-side rate limiting needed at current scale.
- **No expansion to other finding types** -- Only external scripts/stylesheets are collected as "unknown." Expanding to snippets, sections, hreflang, etc. is a separate feature.
- **No duplicate detection across scans** -- The same unknown URL may appear in multiple scans from different merchants. Aggregation queries group by domain, which handles this naturally. No deduplication at the `UnknownScript` level.
- **No Shopify App Store lookup** -- No attempt to validate merchant-submitted app names against the Shopify App Store API. Validation is human-only.

---

## Acceptance Criteria

- [ ] `SubmissionStatus` enum and `status`/`reviewedAt` fields exist on `SignatureSubmission` model.
- [ ] Prisma migration applies cleanly; existing rows default to `PENDING`.
- [ ] `getSubmissionsByDomain()` returns submissions grouped by URL domain with frequency counts and suggested app names.
- [ ] `getSubmissionsByDomain({ status: "PENDING" })` filters to only unreviewed submissions.
- [ ] `updateSubmissionStatus()` sets status and `reviewedAt` timestamp.
- [ ] `acceptSubmissionsForDomain()` batch-updates all submissions for a domain to `ACCEPTED`.
- [ ] `getSubmissionStats()` returns correct counts by status.
- [ ] `scripts/review-submissions.ts` runs via `npx tsx` and outputs a formatted report of pending submissions grouped by domain.
- [ ] CLI script respects `--min-count` flag to filter to high-confidence submissions.
- [ ] Unit tests cover all new model functions (happy path + edge cases: no submissions, single submission, multiple merchants same domain).
- [ ] Existing submission flow (`submitSignatureSuggestion()`) continues to work without changes -- new rows default to `PENDING`.
- [ ] Existing scan detail page unknown scripts section renders correctly (no regressions).

---

## Open Questions

1. **Should we add a `notes` field to `SignatureSubmission` for the reviewer?** During curation, the reviewer might want to annotate why a submission was accepted/rejected (e.g., "confirmed via CDN domain ownership lookup"). This is low-effort to add but may be premature. **Recommendation:** Skip for now; add if needed after first curation pass.

2. **Should the CLI script output a ready-to-paste `AppSignature` entry?** When a domain is validated, the reviewer needs to construct an `AppSignature` object for `app-signatures.server.ts`. The script could generate a template. **Recommendation:** Yes, include a template in the output -- reduces friction for the manual step.

3. **GDPR cascade path -- verified.** The `shop/redact` webhook calls `deleteShopData()` which deletes scans via `db.scan.deleteMany()`. Prisma cascades: Scan -> UnknownScript (`onDelete: Cascade`) -> SignatureSubmission (`onDelete: Cascade`). The cascade path is correct. Note: `SignatureSubmission.shopId` is a plain string (not a FK to Shop), so querying "all submissions by shop" requires joining through Scan -> UnknownScript. This is acceptable for the curation workflow since aggregation is by URL domain, not by shop.

---
