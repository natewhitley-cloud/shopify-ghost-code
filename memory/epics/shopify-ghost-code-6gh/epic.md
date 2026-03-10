# Epic: Ghost Code MVP

**Epic ID**: shopify-ghost-code-6gh
**Created**: 2026-03-09
**Source**: /blossom
**Goal**: Ship Ghost Code v1.0 to the Shopify App Store. Scans merchant themes for orphaned code from uninstalled apps. Stack: React Router v7, Polaris Web Components, GraphQL, PostgreSQL/Prisma, Inngest, Railway.

## Task IDs

| BD ID | Title | Priority | Status | Agent |
|-------|-------|----------|--------|-------|
| .6 | Scaffold Shopify app with React Router v7 template | P0 | open | scaffolder |
| .7 | Configure PostgreSQL + Prisma schema | P0 | open | scaffolder |
| .8 | Create data access layer in app/models/ | P0 | open | implementer |
| .9 | Configure shopify.app.toml + .env.example | P0 | open | scaffolder |
| .10 | Set up Inngest client, event types, and serve endpoint | P0 | open | scaffolder |
| .11 | Build theme file fetching service | P0 | open | implementer |
| .12 | Build ghost code detection engine | P0 | open | implementer |
| .13 | Create known app signature database | P0 | open | implementer |
| .14 | Create scan theme Inngest step function | P0 | open | implementer |
| .15 | Create dashboard route with Polaris Web Components | P0 | open | implementer |
| .16 | Create onboarding/first-run route | P0 | open | implementer |
| .17 | Create scan list/history route | P0 | open | implementer |
| .18 | Create scan detail route with findings table | P0 | open | implementer |
| .19 | Create scan trigger action + progress flow | P0 | open | implementer |
| .20 | Implement 3 GDPR webhook endpoints | P0 | open | implementer |
| .21 | Implement app/uninstalled webhook with data cleanup | P0 | open | implementer |
| .22 | Define billing plans + billing.require() guards | P0 | open | implementer |
| .23 | Implement feature gating by plan tier | P0 | open | implementer |
| .24 | Create settings route | P1 | open | implementer |
| .25 | Verify session tokens + configure CSP headers | P1 | open | reviewer |
| .26 | Build file reference analyzer | P1 | open | implementer |
| .27 | Build scan diffing engine | P1 | open | implementer |
| .28 | Wire theme change webhooks for auto-rescan | P1 | open | implementer |
| .29 | Wire app/installed webhook for auto-first-scan | P1 | open | implementer |
| .30 | Add error boundaries to all routes | P1 | open | implementer |
| .31 | Add database indexes for query performance | P1 | open | implementer |
| .32 | Set up billing test mode for development | P1 | open | implementer |
| .33 | Set up Vitest with Shopify/Prisma/Inngest mocks | P1 | open | tester |
| .34 | Write unit tests for scan engine + severity classifier | P1 | open | tester |
| .35 | Write integration tests for Inngest scan function | P1 | open | tester |
| .36 | Create Railway deployment config + health check | P1 | open | scaffolder |
| .37 | Create GitHub Actions CI/CD pipeline | P1 | open | scaffolder |
| .38 | Configure ESLint + Prettier + TypeScript strict | P2 | open | scaffolder |
| .39 | Create app review submission package | P2 | open | reviewer |
| .40 | Run performance + compatibility audit | P2 | open | tester |
| .41 | Implement daily polling fallback + Inngest monitoring | P2 | open | implementer |

## Critical Path

.6 (scaffold) → .7 (Prisma schema) → .8 (data access layer) → .12 (scan engine) → .14 (Inngest step function) → .16 (onboarding route) — 6 tasks deep

## Parallel Opportunities

**After scaffold (.6) completes, 7 tasks unblock in parallel:**
- .7 (Prisma), .9 (config), .10 (Inngest), .20 (GDPR), .22 (billing), .25 (session/CSP), .33 (Vitest), .36 (Railway), .38 (ESLint)

**After data access (.8) completes, 8 tasks unblock:**
- .11 (fetcher), .12 (engine), .13 (signatures), .15 (dashboard), .17 (scan list), .18 (scan detail), .21 (uninstall), .24 (settings), .27 (diffing)

## Execution Waves

- **Wave 1**: .6 (scaffold) — single blocker, everything else depends on it
- **Wave 2**: .7, .9, .10, .20, .22, .33, .36, .38 — scaffold children (8 parallel)
- **Wave 3**: .8, .23, .25, .28, .29, .31, .37 — config/schema children (7 parallel)
- **Wave 4**: .11, .12, .13, .15, .17, .18, .21, .24, .27, .32, .39 — services + routes (11 parallel)
- **Wave 5**: .14, .26, .30, .34, .40 — integration layer (5 parallel)
- **Wave 6**: .16, .19, .35, .41 — final wiring (4 parallel)
