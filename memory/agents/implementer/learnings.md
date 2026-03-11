# Learnings: implementer

## Codebase Patterns
- Layer boundaries: Routes → Services → Models → Prisma. Never import routes from services.
- Route modules use loader() for data fetching, action() for mutations — no separate API route files.
- Shopify admin access in routes: `const { admin } = await authenticate.admin(request);`
- GraphQL queries use cursor-based pagination with `first: 250` and `after` cursor.
- Rate limiting: 50 points/second for GraphQL. Monitor `extensions.cost.throttleStatus` in responses.
- Inngest functions in `inngest/functions/` use step functions for multi-step async work.
- countScansForShopSince lives in scan.server.ts (model layer) — plan-gating imports it. Keep queries in models, not lib. (added: 2026-03-10, dispatch: .8)
- For aggregate summaries hitting same table with different groupBy axes, use Promise.all for parallel execution. (added: 2026-03-10, dispatch: .8)

## Gotchas
- Polaris uses `<s-*>` Web Components (CDN), NOT React imports. No `import { Card } from '@shopify/polaris'`.
- s-badge tone: info, critical, auto, neutral, success, caution, warning. NOT 'attention'. (added: 2026-03-10, dispatch: .15)
- s-text has NO fontWeight/variant props — use `<strong>` for bold, `<code>` for mono. (added: 2026-03-10, dispatch: .15)
- s-stack gap: 'base', 'loose' — NOT 'tight'. (added: 2026-03-10, dispatch: .15)
- Session tokens, not cookies — never use localStorage or document.cookie for auth.
- Shopify GraphQL returns GID format (e.g., `gid://shopify/Theme/123`). Parse with string splitting, not parseInt.
- GDPR webhooks must ALL return 200 even if no data to process. Missing webhooks = automatic app rejection.
- isTest is NOT part of the billing plan config in shopifyApp(). Pass it at call sites via `billing.require({ isTest: process.env.NODE_ENV !== "production" })`. (added: 2026-03-10, dispatch: .22)
- BillingInterval values: OneTime, Every30Days, Annual, Usage. Monthly = Every30Days. trialDays is top-level on the plan, not on lineItems. (added: 2026-03-10, dispatch: .22)

## Preferences
- Explicit error handling over try/catch-all. Name specific error conditions.
- Keep services stateless — pass dependencies as function parameters.
- Use TypeScript strict types for all Shopify API responses.
- AdminApiContext typed inline in services (structural interface) — avoids importing full Shopify SDK, keeps services testable. (added: 2026-03-10, dispatch: .11)
- App signature regex patterns must match BOTH assignment form (hjid=) and object-key form (hjid:). Test against real injected code. (added: 2026-03-10, dispatch: .13)
- LINK_STYLESHEET_RE needs two capture-group branches for both attribute orderings (rel-first and href-first). (added: 2026-03-10, dispatch: .12)
- When stubbing inngest.send() with TODO, add `void inngest;` to prevent unused-import lint errors. (added: 2026-03-10, dispatch: .15)

## Cross-Agent Notes
- After implementing, notify tester which edge cases are most important to cover.
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.
- GDPR webhooks use authenticate.webhook(request) for HMAC verification — never skip this even for empty 200 responses. (added: 2026-03-10, dispatch: .20)
- Inngest functions go in inngest/functions/ and must be imported+registered in app/routes/api.inngest.ts. (added: 2026-03-10, dispatch: .10)
- Admin clients are NOT serializable across Inngest steps. Create the client inside each step via dynamic import of shopify.server + unauthenticated.admin(shop.domain). (added: 2026-03-10, dispatch: .14)
- Inngest outer try/catch should call updateScanStatus(scanId, 'FAILED') and re-throw — surfaces error state in UI while letting Inngest handle retries. (added: 2026-03-10, dispatch: .14)
- app/uninstalled webhook fires immediately on uninstall; shop/redact fires 48h later. Both paths must clean up Ghost Code data. (added: 2026-03-10, dispatch: .21)
- Child route ErrorBoundaries should use isRouteErrorResponse/useRouteError from react-router directly, not the layout-level boundary.error() delegate. (added: 2026-03-10, dispatch: .30)
