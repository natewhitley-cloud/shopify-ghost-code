# Learnings: scaffolder

## Codebase Patterns

- Project uses React Router v7 (Shopify official template, NOT Remix). Scaffolded via `shopify app init`.
- Railway deploy in CI: use `ghcr.io/railwayapp/cli:latest` container (official), not third-party actions. Avoids supply-chain risk. (added: 2026-03-10, dispatch: .37)
- `npx prisma generate` must run before typecheck and test in CI — no DATABASE_URL needed for generate. (added: 2026-03-10, dispatch: .37)
- Prisma uses PostgreSQL for production, SQLite for local dev. Provider in `prisma/schema.prisma`.
- Inngest client and event types live in `inngest/`, functions in `inngest/functions/`.
- All server-only code uses `.server.ts` suffix to prevent client bundling.
- Shopify config lives in `shopify.app.toml` — scopes, webhooks, app metadata.

## Gotchas

- `shopify app init` defaults to SQLite. Must change Prisma provider to `postgresql` immediately after scaffold.
- Most Shopify tutorials reference Remix — this project uses React Router v7 (Remix merged into React Router).
- Polaris is Web Components via CDN (`<s-*>` tags), NOT the npm `@shopify/polaris` React package.
- REST Admin API is blocked for new apps since April 2025 — GraphQL only.
- Inngest has no react-router adapter. Use `inngest/remix` — it exports serve() compatible with React Router v7 loader/action exports. (added: 2026-03-10, dispatch: .10)
- `npx prisma validate` always requires DATABASE_URL to be set. Use `DATABASE_URL=postgresql://x@localhost:5432/x npx prisma validate` as the validation command. (added: 2026-03-10, dispatch: .7)
- Run `prisma migrate deploy` as Railway's `preDeployCommand` (railway.toml `[deploy]`), NOT on container boot — it then runs once per deploy in the new image and fails the deploy cleanly instead of re-running on every crash-restart. Boot should be just `react-router-serve`. (added: 2026-07-01, dispatch: GC-a5o)
- Removing boot-time `prisma generate` is only safe if the runtime image copies BOTH `node_modules/.prisma` AND `node_modules/@prisma/client` from the build stage — the generated engine lives in `.prisma/client` but the package wrapper in `@prisma/client` must match it or the client is incomplete. (added: 2026-07-01, dispatch: GC-a5o)

## Preferences

- Keep file structure matching CLAUDE.md project structure section exactly.
- Name files with kebab-case (e.g., `scan-engine.server.ts`, not `scanEngine.server.ts`).
- Always re-read package.json before editing — other agents modify it frequently and task brief snapshots go stale. (added: 2026-03-10, dispatch: .36/.38)
- tsconfig.json strict:true was already set by the scaffold template — check before adding. (added: 2026-03-10, dispatch: .38)

- `inngest/` files import from `app/` using `../app/<path>` prefix — not a `~` alias — because the `~` tsconfig alias resolves relative to `app/` itself. (added: 2026-03-28, dispatch: GC-rqt)
- When adding cross-cutting concerns (error tracking, metrics), wire through the logger rather than call-site instrumentation — existing code gets coverage without changes. (added: 2026-03-28, dispatch: GC-rqt)

- Inngest `fn.id()` is a method call returning the stable kebab-case function ID; `fn.name` is the display label. Use `id()` for logging/alerting identifiers. (added: 2026-03-28, dispatch: GC-cxr)

## Cross-Agent Notes

- After scaffolding new files, leave TODO comments for the implementer to fill in business logic.
- Always run `npx prisma validate` AND `npx prisma generate` after schema changes before handing off. (from implementer: generate is required for tsc to accept model-typed code downstream) (added: 2026-03-10, dispatch: .8)
- Inngest serve endpoint lives at app/routes/api.inngest.ts. New functions go in inngest/functions/ and must be imported+registered in api.inngest.ts. (added: 2026-03-10, dispatch: .10)
- (from implementer) webhooks.shop.redact.tsx references db.scan and db.shop — these resolve after prisma generate runs with the new schema. (added: 2026-03-10, dispatch: .22)
