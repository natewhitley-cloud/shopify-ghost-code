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

## Agent Selection

- **scaffolder**: Initial project setup, route scaffolding, Prisma schema
- **implementer**: Feature implementation, service logic, scanner engine
- **tester**: Test writing, coverage gaps, test infrastructure
- **reviewer**: Code review, architecture review, pre-merge checks
- **debugger**: Bug investigation, error tracing, performance issues

## Key Decisions

- (pending: team not yet assembled via agent-generator)

## Shopify Platform Facts

- App review requires: 3 GDPR webhooks, privacy policy URL, Billing API for paid features
- `read_themes` scope grants access to theme files (Liquid, CSS, JS, JSON)
- Dev stores have unlimited test charges (use `test: true` in Billing mutations)
- App Bridge CDN handles auth automatically in embedded app context
