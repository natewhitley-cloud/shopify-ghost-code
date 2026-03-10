# Learnings: implementer

## Codebase Patterns
- Layer boundaries: Routes → Services → Models → Prisma. Never import routes from services.
- Route modules use loader() for data fetching, action() for mutations — no separate API route files.
- Shopify admin access in routes: `const { admin } = await authenticate.admin(request);`
- GraphQL queries use cursor-based pagination with `first: 250` and `after` cursor.
- Rate limiting: 50 points/second for GraphQL. Monitor `extensions.cost.throttleStatus` in responses.
- Inngest functions in `inngest/functions/` use step functions for multi-step async work.

## Gotchas
- Polaris uses `<s-*>` Web Components (CDN), NOT React imports. No `import { Card } from '@shopify/polaris'`.
- Session tokens, not cookies — never use localStorage or document.cookie for auth.
- Shopify GraphQL returns GID format (e.g., `gid://shopify/Theme/123`). Parse with string splitting, not parseInt.
- GDPR webhooks must ALL return 200 even if no data to process. Missing webhooks = automatic app rejection.
- Billing API uses `isTest: true` in dev — must be toggled off for production.

## Preferences
- Explicit error handling over try/catch-all. Name specific error conditions.
- Keep services stateless — pass dependencies as function parameters.
- Use TypeScript strict types for all Shopify API responses.

## Cross-Agent Notes
- After implementing, notify tester which edge cases are most important to cover.
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.
