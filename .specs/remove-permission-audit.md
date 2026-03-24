# Spec: Remove Permission Audit Feature

**Status:** READY FOR REVIEW
**Created:** 2026-03-23
**Author:** Claude Opus 4.6 (user-initiated)

---

## Problem Statement

Remove Permission Audit feature entirely from Ghost Code app. The feature is dead — appInstallations query is restricted to Shopify-internal apps, no third-party scope exists. Need to remove all Permission Audit code: routes, services, models, tests, nav links, billing config flags, and any related DB tables/migrations. Goal is a clean codebase with no dead feature code before app store submission.

---

## Context & Constraints

### Current State

The Permission Audit feature was built as a secondary feature for Ghost Code that would scan a merchant's installed apps and audit their OAuth scopes for risk. It was feature-gated via `permissionAuditEnabled` in the billing config (currently set to `true` for all plan tiers).

The feature is fundamentally broken: the `appInstallations` GraphQL query it relies on is restricted to Shopify-internal apps. No `read_apps` scope exists for third-party apps to request. The `currentAppInstallation` fallback only returns Ghost Code itself, making the feature useless.

### Feature Surface Area

The Permission Audit feature spans 9 source files, 7 test files, 3 Prisma models, 2 enums, billing config flags, a nav link, and references in `shopify.app.toml`.

**Source files (9 — all exclusively used by Permission Audit):**

- `app/routes/app.permissions.tsx` — list route (installed apps + risk scores)
- `app/routes/app.permissions.$appId.tsx` — detail route (per-app scope breakdown)
- `app/services/permission-fetcher.server.ts` — GraphQL fetcher + sync logic
- `app/services/permission-scorer.server.ts` — risk scoring algorithm
- `app/services/app-enrichment.server.ts` — app category/rating enrichment
- `app/models/installed-app.server.ts` — data access layer for InstalledApp
- `app/lib/risk-display.ts` — risk level display helpers (tone, label)
- `app/lib/sensitive-scope-alerts.server.ts` — PII/modification scope alerts
- `app/data/category-permissions.server.ts` — expected scopes per app category

**Test files (8):**

- `tests/routes/app.permissions.test.ts`
- `tests/routes/app.permissions.detail.test.ts`
- `tests/services/permission-fetcher.server.test.ts`
- `tests/services/permission-scorer.server.test.ts`
- `tests/services/app-enrichment.server.test.ts`
- `tests/lib/risk-display.test.ts`
- `tests/lib/sensitive-scope-alerts.test.ts`
- `tests/models/installed-app.server.test.ts`

**Prisma models (3) + enums (2):**

- `InstalledApp` — tracks third-party apps on a store
- `PermissionSnapshot` — historical scope snapshots per audit run
- `PermissionAuditRun` — audit execution records
- `AppPresence` enum — INSTALLED/REMOVED status
- `AuditRunStatus` enum — PENDING/IN_PROGRESS/COMPLETED/FAILED

**Cross-cutting references:**

- `app/lib/billing.server.ts` — `permissionAuditEnabled` flag in `PlanFeatures` type and all plan branches
- `app/routes/app.tsx` — conditional nav link for Permission Audit + `permissionAuditEnabled` in loader return
- `app/models/shop.server.ts` — GDPR `deleteShopData()` function explicitly deletes `permissionSnapshot`, `installedApp`, and `permissionAuditRun` records (lines 98-102)
- `shopify.app.toml` — comment referencing Permission Audit in `optional_scopes`
- `tests/mocks/prisma.ts` — `installedApp`, `permissionSnapshot`, and `permissionAuditRun` mock model entries (both top-level and inside `$transaction` callback)
- `tests/routes/app._index.test.ts` — `permissionAuditEnabled: false` in mock plan features
- `tests/routes/app.settings.test.ts` — `permissionAuditEnabled: false` in mock plan features
- `prisma/schema.prisma` — Shop model has `installedApps` and `permissionAuditRuns` relations

### Constraints

- **Pre-app-store-submission**: The codebase must be clean of dead feature code before submitting to Shopify App Store review.
- **Single init migration**: The database schema uses a single initial migration (`20260321000000_init`). The Permission Audit tables were created in this migration alongside core tables.
- **No production data**: The app has not been deployed to production merchants, so no data migration is needed for existing Permission Audit records.
- **Prisma mock structure**: The `tests/mocks/prisma.ts` file has an `installedApp` entry that must be removed.

---

## Prior Art

This is a feature removal, not a feature addition. The relevant prior art is the codebase's existing patterns:

- **Route structure**: React Router v7 flat file routes in `app/routes/`. Removing `app.permissions.tsx` and `app.permissions.$appId.tsx` removes the routes cleanly — no router config file to update.
- **Billing config pattern**: `app/lib/billing.server.ts` uses a `PlanFeatures` type with boolean flags. The `permissionAuditEnabled` flag is the only Permission Audit reference in billing.
- **Nav link pattern**: `app/routes/app.tsx` conditionally renders the Permission Audit nav link based on the feature flag. This is the only nav reference.
- **Prisma migration pattern**: The project uses `prisma migrate dev` for schema changes. A new migration will be needed to drop the 3 tables, 2 enums, and the Shop relation columns.

---

## Proposed Approach

### Strategy: Surgical Removal

Remove all Permission Audit code in a single coordinated change. The approach is straightforward because:

1. All 9 source files are exclusively consumed by Permission Audit routes (no shared dependencies with core scanner features)
2. No production data exists that needs preservation
3. The feature was cleanly isolated behind a feature flag

### Execution Order

1. **Delete source files** (9 files) — routes, services, models, lib, data
2. **Delete test files** (8 files) — all corresponding test files
3. **Remove cross-cutting references**:
   - Remove `permissionAuditEnabled` from `PlanFeatures` type and all plan branches in `billing.server.ts`
   - Remove conditional nav link from `app.tsx` layout
   - Remove `permissionAuditEnabled` from `app.tsx` loader return value
   - Remove `permissionSnapshot`, `installedApp`, and `permissionAuditRun` deletion lines from `deleteShopData()` in `app/models/shop.server.ts` (and update the deletion order comment)
   - Clean `shopify.app.toml` comment about Permission Audit
   - Remove `installedApp` from `tests/mocks/prisma.ts`
   - Remove `permissionAuditEnabled` from mock plan features in `app._index.test.ts` and `app.settings.test.ts`
4. **Update Prisma schema**: Remove `InstalledApp`, `PermissionSnapshot`, `PermissionAuditRun` models; remove `AppPresence` and `AuditRunStatus` enums; remove `installedApps` and `permissionAuditRuns` relations from `Shop` model
5. **Create Prisma migration**: `npx prisma migrate dev --name remove-permission-audit` to generate DROP TABLE/ENUM SQL
6. **Regenerate Prisma client**: `npx prisma generate`
7. **Verify**: Run `npx tsc --noEmit` (no type errors), `npx vitest` (all tests pass), grep for orphaned references

---

## API / Interface Contract

This is a removal — no new public surfaces are created.

**Removed routes:**

- `GET /app/permissions` — Permission Audit list page (was served by `app.permissions.tsx` loader + component)
- `GET /app/permissions/:appId` — Permission Audit detail page (was served by `app.permissions.$appId.tsx` loader + component)

**Modified route:**

- `GET /app` (layout) — `app.tsx` loader no longer returns `permissionAuditEnabled`; nav no longer renders Permission Audit link

**No API endpoints, webhooks, or Inngest functions are affected** — Permission Audit had no background job integration.

---

## Data Model Changes

### Removed Models

| Model                | Tables Dropped       | Indexes Dropped                                                                                |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `InstalledApp`       | `InstalledApp`       | `InstalledApp_shopId_idx`, `InstalledApp_presence_idx`, `InstalledApp_shopId_shopifyAppId_key` |
| `PermissionSnapshot` | `PermissionSnapshot` | `PermissionSnapshot_installedAppId_idx`, `PermissionSnapshot_auditRunId_idx`                   |
| `PermissionAuditRun` | `PermissionAuditRun` | `PermissionAuditRun_shopId_createdAt_idx`                                                      |

### Removed Enums

| Enum             | Values                                  |
| ---------------- | --------------------------------------- |
| `AppPresence`    | INSTALLED, REMOVED                      |
| `AuditRunStatus` | PENDING, IN_PROGRESS, COMPLETED, FAILED |

### Modified Models

| Model  | Change                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------- |
| `Shop` | Remove `installedApps InstalledApp[]` and `permissionAuditRuns PermissionAuditRun[]` relations |

### Migration

A new Prisma migration will drop foreign keys, tables, and enums in dependency order:

1. Drop `PermissionSnapshot` (depends on both `InstalledApp` and `PermissionAuditRun`)
2. Drop `InstalledApp` (depends on `Shop`)
3. Drop `PermissionAuditRun` (depends on `Shop`)
4. Drop `AppPresence` enum
5. Drop `AuditRunStatus` enum

---

## Migration / Rollout Plan

### Pre-production context

The app has not shipped to production. No merchant data exists in Permission Audit tables. The migration is purely destructive (DROP TABLE) with no data preservation concerns.

### Deployment steps

1. Apply the Prisma migration to the development database: `npx prisma migrate dev --name remove-permission-audit`
2. On Railway (staging/production): the migration runs automatically on deploy via Prisma's migration engine
3. No feature flag rollout needed — the feature flag (`permissionAuditEnabled`) is being removed entirely
4. No backward compatibility concerns — no external consumers of Permission Audit routes exist

### Rollback strategy

If needed, revert the git commit. The migration is destructive but the tables contain no production data, so re-running `prisma migrate dev` after revert restores the schema.

---

## Non-Requirements

- **Preserving Permission Audit data**: No production data exists. No export or archival needed.
- **Replacing Permission Audit with an alternative feature**: This spec only covers removal. Any future permission-related feature would be a separate spec.
- **Removing the `read_translations` optional scope from `shopify.app.toml`**: This scope is listed in `optional_scopes` and is not tied to Permission Audit (it may serve other purposes). Only the Permission Audit comment next to it should be cleaned up.
- **Updating memory/session handoff docs**: These are historical records and should not be modified.
- **Updating `docs/product-strategy.md` or `docs/e2e-test-checklist.md`**: These contain references to Permission Audit but are documentation/planning artifacts. They can be updated separately if desired, but are not blocking for a clean codebase.

---

## Acceptance Criteria

- [ ] All 9 Permission Audit source files are deleted (routes, services, models, lib, data)
- [ ] All 8 Permission Audit test files are deleted
- [ ] `permissionAuditEnabled` is removed from `PlanFeatures` type in `app/lib/billing.server.ts`
- [ ] `permissionAuditEnabled` is removed from all plan tier return values in `getPlanFeatures()`
- [ ] Permission Audit nav link is removed from `app/routes/app.tsx`
- [ ] `permissionAuditEnabled` is removed from `app.tsx` loader data
- [ ] Permission Audit deletion lines are removed from `deleteShopData()` in `app/models/shop.server.ts`
- [ ] `installedApp`, `permissionSnapshot`, and `permissionAuditRun` mocks are removed from `tests/mocks/prisma.ts` (both top-level and `$transaction` callback)
- [ ] `permissionAuditEnabled` references are removed from `tests/routes/app._index.test.ts` and `tests/routes/app.settings.test.ts`
- [ ] `InstalledApp`, `PermissionSnapshot`, and `PermissionAuditRun` models are removed from `prisma/schema.prisma`
- [ ] `AppPresence` and `AuditRunStatus` enums are removed from `prisma/schema.prisma`
- [ ] `installedApps` and `permissionAuditRuns` relations are removed from `Shop` model
- [ ] Permission Audit comment is removed from `shopify.app.toml`
- [ ] A Prisma migration exists that drops the 3 tables and 2 enums
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] `npx vitest` passes with zero failures
- [ ] `grep -r "permissionAudit\|InstalledApp\|PermissionSnapshot\|PermissionAuditRun\|permission-fetcher\|permission-scorer\|app-enrichment\|category-permissions\|risk-display\|sensitive-scope-alerts\|installed-app\.server" app/ tests/` returns no matches (excluding node_modules)

---

## Open Questions

1. **Should `read_translations` be removed from `optional_scopes` in `shopify.app.toml`?** The comment says it's for Permission Audit, but the scope itself (`read_translations`) could serve other future features. Current recommendation: remove only the comment, keep the scope. Decision needed from product owner.

2. **Should `docs/product-strategy.md` and `docs/e2e-test-checklist.md` be updated to remove Permission Audit references?** These are planning/documentation artifacts. Recommendation: update as a follow-up, not blocking for this change.

---
