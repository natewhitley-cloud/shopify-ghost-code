# Learnings: scaffolder

## Codebase Patterns
- Project uses React Router v7 (Shopify official template, NOT Remix). Scaffolded via `shopify app init`.
- Prisma uses PostgreSQL for production, SQLite for local dev. Provider in `prisma/schema.prisma`.
- Inngest client and event types live in `inngest/`, functions in `inngest/functions/`.
- All server-only code uses `.server.ts` suffix to prevent client bundling.
- Shopify config lives in `shopify.app.toml` — scopes, webhooks, app metadata.

## Gotchas
- `shopify app init` defaults to SQLite. Must change Prisma provider to `postgresql` immediately after scaffold.
- Most Shopify tutorials reference Remix — this project uses React Router v7 (Remix merged into React Router).
- Polaris is Web Components via CDN (`<s-*>` tags), NOT the npm `@shopify/polaris` React package.
- REST Admin API is blocked for new apps since April 2025 — GraphQL only.

## Preferences
- Keep file structure matching CLAUDE.md project structure section exactly.
- Name files with kebab-case (e.g., `scan-engine.server.ts`, not `scanEngine.server.ts`).

## Cross-Agent Notes
- After scaffolding new files, leave TODO comments for the implementer to fill in business logic.
- Always run `npx prisma validate` after schema changes before handing off.
