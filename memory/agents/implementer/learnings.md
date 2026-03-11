# Learnings: implementer

## Codebase Patterns
- Layer boundaries: Routes → Services → Models → Prisma. Never import routes from services.
- Route modules use loader() for data fetching, action() for mutations — no separate API route files.
- Shopify admin access in routes: `const { admin } = await authenticate.admin(request);`
- GraphQL queries use cursor-based pagination with `first: 250` and `after` cursor.
- Rate limiting: 50 points/second for GraphQL. Monitor `extensions.cost.throttleStatus` in responses.
- Inngest functions in `inngest/functions/` use step functions for multi-step async work.
- Inngest v3 requires `new Inngest({ schemas: new EventSchemas().fromRecord<Events>() })` — the `Inngest<Events>` generic from v2 is rejected. (added: 2026-03-10, dispatch: .41)
- InngestMiddleware afterExecution is BlankHook (zero args). Capture timing via closure in onFunctionRun scope, not hook params. (added: 2026-03-10, dispatch: .41)
- Cron Inngest functions use `{ cron: '0 6 * * *' }` trigger (not event name). Per-shop batch ops: for-loop with `step.run('check-shop-${safeId}')` per iteration for isolation + per-shop retryability. (added: 2026-03-10, dispatch: .41)
- countScansForShopSince lives in scan.server.ts (model layer) — plan-gating imports it. Keep queries in models, not lib. (added: 2026-03-10, dispatch: .8)
- For aggregate summaries hitting same table with different groupBy axes, use Promise.all for parallel execution. (added: 2026-03-10, dispatch: .8)

## Gotchas
- vi.mock() factory functions are hoisted before variable initializations. Mock objects inside vi.mock() factories MUST use vi.hoisted(() => ...) — plain const declarations throw ReferenceError. (added: 2026-03-10, dispatch: .43)
- billing.request() throws a redirect response internally — never returns a value. No post-call return handling needed in the action function. (added: 2026-03-10, dispatch: .43)
- APP_SUBSCRIPTIONS_UPDATE webhook payload: `{ app_subscription: { name, status, admin_graphql_api_id } }`. Status ACTIVE = live; all others (CANCELLED, DECLINED, EXPIRED, FROZEN, PENDING) = revert to free tier. (added: 2026-03-10, dispatch: .43)
- Webhook handlers receive shop domain, not internal DB ID. Model functions for webhooks need domain-keyed lookups (e.g., updateShopPlanByDomain). (added: 2026-03-10, dispatch: .43)
- Polaris uses `<s-*>` Web Components (CDN), NOT React imports. No `import { Card } from '@shopify/polaris'`.
- Polaris `<s-*>` valid prop values: s-badge tone (info/critical/auto/neutral/success/caution/warning, NOT 'attention'), s-text (no fontWeight/variant — use `<strong>`/`<code>`), s-stack gap ('base'/'loose', NOT 'tight'). (added: 2026-03-10, dispatch: .15)
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
- When extracting shared utilities, compare ALL call sites for behavioral differences before writing the shared version — subtle option differences can silently change behavior if missed. (added: 2026-03-10, dispatch: .42)
- `export { Foo as Bar }` re-export pattern satisfies framework named-export contracts (React Router's ErrorBoundary) from shared components without wrapper boilerplate. (added: 2026-03-10, dispatch: .42)
- app/lib/ for client-safe utility modules (no .server.ts), app/components/ for shared UI components. Both patterns established. (added: 2026-03-10, dispatch: .42)
- When integrating two services with different input shapes ({ filename, content } vs { key, value }), document the adapter inline at the mapping site. (added: 2026-03-10, dispatch: .44)
- Structure cross-file detection as explicit numbered passes (Pass 1: per-file, Pass 2: cross-file) in code comments and JSDoc. (added: 2026-03-10, dispatch: .44)
- When new cross-file analysis affects existing integration tests, update fixtures to be self-consistent rather than loosening assertions. (added: 2026-03-10, dispatch: .44)

## Cross-Agent Notes
- After implementing, notify tester which edge cases are most important to cover.
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.
- Webhook handlers must ALWAYS return 200. Use authenticate.webhook() for HMAC verification. Non-200 causes infinite Shopify retries. (added: 2026-03-10, dispatch: .20/.28)
- Inngest functions in inngest/functions/ must be imported+registered in api.inngest.ts. Admin clients NOT serializable across steps — create via dynamic import inside each step. Outer try/catch should mark scan FAILED and re-throw. (added: 2026-03-10, dispatch: .10/.14)
- app/uninstalled fires immediately; shop/redact fires 48h later. Both paths clean up via deleteShopData(). app/installed uses authenticate.webhook() + unauthenticated.admin() (no session context). (added: 2026-03-10, dispatch: .21/.29)
- Extract shared GraphQL queries as module-level helpers. themes() uses roles: MAIN (uppercase enum). Full GID string is the themeId. (added: 2026-03-10, dispatch: .19)
- Fingerprint-based diffing: use multiset (Map of counts) not Set. getPreviousScanForTheme filters to COMPLETED status. (added: 2026-03-10, dispatch: .27)
- Snippets can render other snippets in Liquid. File reference analyzer must include snippet files in the reference scan pass. (added: 2026-03-10, dispatch: .26)
