# Team Decisions

## Architecture
- React Router v7 (not Remix) — official Shopify template as of 2025
- Polaris Web Components via CDN (`<s-*>` tags) — not npm React Polaris
- GraphQL Admin API only — REST blocked since April 2025
- PostgreSQL via Prisma — SQLite for local dev only
- Inngest for background jobs — simpler than BullMQ for App 1's scan workload
- Railway for hosting — web + worker processes, managed Postgres + Redis

## Conventions
- Layer boundaries: Routes → Services → Models → Prisma (never reverse)
- Server-only files use `.server.ts` suffix
- File naming: kebab-case (e.g., `scan-engine.server.ts`)
- Route naming: `app/routes/app.<name>.tsx` for admin routes, `app/routes/webhooks.<topic>.tsx` for webhooks
- Inngest functions: `inngest/functions/<name>.ts`

## Business Rules
- Free tier: 1 scan/month, finding count only (no details)
- Standard ($29/mo): unlimited scans, 1 theme, full findings
- Professional ($59/mo): unlimited themes, auto-rescan, scan diffing
- All tiers get 7-day free trial on paid plans
