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
- ~50 pre-existing TS errors from Polaris Web Components (no JSX types for `<s-*>`) and test mock casts. Not blocking — tests pass cleanly.

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

## Key Decisions

- Team assembled via /assemble. 5 members: scaffolder, implementer, tester, reviewer, debugger.
- Structured JSON logging via app/lib/logger.server.ts (replaces bare console.* in webhooks). (added: 2026-03-10)
- Atomic TOCTOU guard in createScan + idempotent completeScanWithFindings — application-level, not DB constraint. (added: 2026-03-10)

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
