# Epic: Permission Audit feature for Ghost Code

**Epic ID**: GC-zse
**Created**: 2026-03-21
**Source**: /blossom
**Goal**: Add a "Permission Audit" tab/section to Ghost Code that shows merchants what permissions every installed app holds, flags over-permissioned or inactive apps, and scores overall permission risk. Designed as self-contained module for potential future extraction to standalone app.

## Key Constraints Discovered

1. **`read_apps` scope is restricted** — requires Shopify Support approval via Partner Dashboard. Cannot just declare it in shopify.app.toml. Security/compliance use case (Disputifier breach reference) is the strongest justification.
2. **API exposes granted scopes, not used scopes** — feature must be positioned as "what each app _can_ access," not what it actually does.
3. **No install date, last-call timestamp, or active/inactive status** in AppInstallation object — must track install date ourselves via webhooks going forward.
4. **Market-research DB has 5,247 apps but NO permission data** — category taxonomy (100 categories) is useful for expected-permission baselines.
5. **Architecture maps cleanly** — self-contained module boundary confirmed (no coupling to Scan/Finding models).

## Spike Findings

### Items

1. **Submit read_apps scope approval request** — restricted scope requires Shopify Support petition with security/compliance justification
   - source: Shopify Partner Dashboard "Access requests"
   - confidence: CONFIRMED
   - priority: P1
   - depends-on: none
   - agent: human (Nathan)

2. **Design for missing AppInstallation fields** — no install date, last API call, active status available from API
   - source: Shopify AppInstallation object docs
   - confidence: CONFIRMED
   - priority: P2
   - depends-on: none
   - agent: designer/architect

3. **Build category-to-expected-permissions mapping** — 100 categories from market-research DB enable category-aware risk scoring
   - source: market-research/data/shopify_apps.db categories table
   - confidence: CONFIRMED
   - priority: P2
   - depends-on: none
   - agent: implementer

4. **Create app enrichment lookup from market-research DB** — 5,247 apps with slug, category, rating, review_count
   - source: market-research/data/shopify_apps.db apps table
   - confidence: CONFIRMED
   - priority: P2
   - depends-on: none
   - agent: implementer

5. **Design and create Prisma models** — InstalledApp, PermissionSnapshot, PermissionAuditRun with cascade deletes
   - source: prisma/schema.prisma
   - confidence: LIKELY
   - priority: P1
   - depends-on: GC-zse.7
   - agent: implementer

6. **Build permission-fetcher service** — follow theme-fetcher.server.ts pattern with GraphQL queries
   - source: app/services/theme-fetcher.server.ts
   - confidence: CONFIRMED
   - priority: P1
   - depends-on: GC-zse.8, GC-zse.12
   - agent: implementer

7. **Design permission risk scoring algorithm** — scope count, sensitivity tier, category mismatch heuristic
   - source: new design
   - confidence: LIKELY
   - priority: P2
   - depends-on: GC-zse.4
   - agent: designer/implementer

8. **Build webhook-based app inventory** — app/installed + app/uninstalled webhooks as fallback/complement
   - source: Shopify webhook docs
   - confidence: CONFIRMED
   - priority: P1
   - depends-on: GC-zse.12
   - agent: implementer

9. **Add Permission Audit nav tab and route shell** — app.permissions.tsx with Polaris Web Components
   - source: app/routes/app.tsx:20-23
   - confidence: CONFIRMED
   - priority: P1
   - depends-on: GC-zse.13, GC-zse.14
   - agent: implementer

10. **Design merchant-guided initial audit flow** — fallback UX for Admin > Settings > Apps
    - source: Shopify Admin UI
    - confidence: CONFIRMED
    - priority: P2
    - depends-on: none
    - agent: designer

11. **Add permissionAudit flag to PlanFeatures** — billing gating
    - source: app/lib/billing.server.ts:11-51
    - confidence: CONFIRMED
    - priority: P2
    - depends-on: GC-zse.11
    - agent: implementer

12. **Build Permission Audit detail view** — app.permissions.$appId.tsx
    - source: app/routes/app.scans.$scanId.tsx pattern
    - confidence: CONFIRMED
    - priority: P2
    - depends-on: GC-zse.11, GC-zse.5
    - agent: implementer

13. **Write tests for Permission Audit** — services, routes, models
    - source: tests/ directory structure
    - confidence: CONFIRMED
    - priority: P2
    - depends-on: GC-zse.13, GC-zse.11, GC-zse.12
    - agent: implementer

## Priority Order

1. GC-zse.8 — Submit read_apps scope approval (P1, human, no deps)
2. GC-zse.7 — Design for missing AppInstallation fields (P2, no deps)
3. GC-zse.4 — Build category-to-expected-permissions mapping (P2, no deps)
4. GC-zse.5 — Create app enrichment lookup (P2, no deps)
5. GC-zse.10 — Design merchant-guided initial audit flow (P2, no deps)
6. GC-zse.12 — Design and create Prisma models (P1, deps: .7)
7. GC-zse.14 — Design permission risk scoring algorithm (P2, deps: .4)
8. GC-zse.13 — Build permission-fetcher service (P1, deps: .8, .12)
9. GC-zse.9 — Build webhook-based app inventory (P1, deps: .12)
10. GC-zse.11 — Add Permission Audit nav tab and route shell (P1, deps: .13, .14)
11. GC-zse.15 — Add permissionAudit flag to billing (P2, deps: .11)
12. GC-zse.16 — Build detail view (P2, deps: .11, .5)
13. GC-zse.17 — Write tests (P2, deps: .13, .11, .12)

## Task IDs

| BD ID     | Title                                                | Priority | Status | Assigned Agent       |
| --------- | ---------------------------------------------------- | -------- | ------ | -------------------- |
| GC-zse.8  | Submit read_apps scope approval request              | P1       | open   | human (Nathan)       |
| GC-zse.7  | Design for missing AppInstallation fields            | P2       | open   | designer/architect   |
| GC-zse.4  | Build category-to-expected-permissions mapping       | P2       | open   | implementer          |
| GC-zse.5  | Create app enrichment lookup from market-research DB | P2       | open   | implementer          |
| GC-zse.10 | Design merchant-guided initial audit flow            | P2       | open   | designer             |
| GC-zse.12 | Design and create Prisma models                      | P1       | open   | implementer          |
| GC-zse.14 | Design permission risk scoring algorithm             | P2       | open   | designer/implementer |
| GC-zse.13 | Build permission-fetcher service                     | P1       | open   | implementer          |
| GC-zse.9  | Build webhook-based app inventory                    | P1       | open   | implementer          |
| GC-zse.11 | Add Permission Audit nav tab and route shell         | P1       | open   | implementer          |
| GC-zse.15 | Add permissionAudit flag to PlanFeatures             | P2       | open   | implementer          |
| GC-zse.16 | Build Permission Audit detail view                   | P2       | open   | implementer          |
| GC-zse.17 | Write tests for Permission Audit                     | P2       | open   | implementer          |

## Critical Path

GC-zse.8 (scope approval) → GC-zse.7 (missing fields) → GC-zse.12 (Prisma models) → GC-zse.13 (permission-fetcher) → GC-zse.11 (route shell) → GC-zse.16 (detail view) / GC-zse.17 (tests)

## Parallel Opportunities

- Wave 1 (no deps): GC-zse.8, GC-zse.7, GC-zse.4, GC-zse.5, GC-zse.10
- Wave 2 (after wave 1): GC-zse.12, GC-zse.14
- Wave 3 (after wave 2): GC-zse.13, GC-zse.9
- Wave 4 (after wave 3): GC-zse.11
- Wave 5 (after wave 4): GC-zse.15, GC-zse.16, GC-zse.17
