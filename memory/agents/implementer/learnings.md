# Learnings: implementer

## Core
- Shopify admin access in routes: `const { admin } = await authenticate.admin(request);`
- Explicit error handling over try/catch-all. Name specific error conditions.
- Keep services stateless — pass dependencies as function parameters.
- Use TypeScript strict types for all Shopify API responses.
- AdminApiContext typed inline in services (structural interface) — avoids importing full Shopify SDK, keeps services testable. (added: 2026-03-10, dispatch: .11)
- Polaris `<s-*>` valid prop values: s-badge tone (info/critical/auto/neutral/success/caution/warning, NOT 'attention'), s-text (no fontWeight/variant — use `<strong>`/`<code>`), s-stack gap ('base'/'loose', NOT 'tight'). (added: 2026-03-10, dispatch: .15)
- Shopify GraphQL returns GID format (e.g., `gid://shopify/Theme/123`). Parse with string splitting, not parseInt.
- Webhook handlers receive shop domain, not internal DB ID. Model functions for webhooks need domain-keyed lookups (e.g., updateShopPlanByDomain). (added: 2026-03-10, dispatch: .43)
- app/lib/ for client-safe utility modules (no .server.ts), app/components/ for shared UI components. Both patterns established. (added: 2026-03-10, dispatch: .42)
- When extracting shared utilities, compare ALL call sites for behavioral differences before writing the shared version. (added: 2026-03-10, dispatch: .42)
- `export { Foo as Bar }` re-export pattern satisfies framework named-export contracts (React Router's ErrorBoundary). (added: 2026-03-10, dispatch: .42)
- Extract shared GraphQL queries as module-level helpers. themes() uses roles: MAIN (uppercase enum). Full GID string is the themeId. (added: 2026-03-10, dispatch: .19)
- After implementing, notify tester which edge cases are most important to cover.
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.

## Task-Relevant
- Inngest functions in `inngest/functions/` use step functions for multi-step async work.
- Inngest v3 requires `new Inngest({ schemas: new EventSchemas().fromRecord<Events>() })` — the `Inngest<Events>` generic from v2 is rejected. (added: 2026-03-10, dispatch: .41)
- InngestMiddleware afterExecution is BlankHook (zero args). Capture timing via closure in onFunctionRun scope, not hook params. (added: 2026-03-10, dispatch: .41)
- Cron Inngest functions use `{ cron: '0 6 * * *' }` trigger (not event name). Per-shop batch ops: for-loop with `step.run('check-shop-${safeId}')` per iteration. (added: 2026-03-10, dispatch: .41)
- countScansForShopSince lives in scan.server.ts (model layer) — plan-gating imports it. Keep queries in models, not lib. (added: 2026-03-10, dispatch: .8)
- vi.mock() factory functions are hoisted before variable initializations. Mock objects inside vi.mock() factories MUST use vi.hoisted(() => ...). (added: 2026-03-10, dispatch: .43)
- billing.request() throws a redirect response internally — never returns a value. (added: 2026-03-10, dispatch: .43)
- APP_SUBSCRIPTIONS_UPDATE webhook payload: `{ app_subscription: { name, status, admin_graphql_api_id } }`. Status ACTIVE = live; all others = revert to free tier. (added: 2026-03-10, dispatch: .43)
- isTest is NOT part of the billing plan config in shopifyApp(). Pass it at call sites via `billing.require({ isTest: process.env.NODE_ENV !== "production" })`. (added: 2026-03-10, dispatch: .22)
- BillingInterval values: OneTime, Every30Days, Annual, Usage. trialDays is top-level on the plan, not on lineItems. (added: 2026-03-10, dispatch: .22)
- App signature regex patterns must match BOTH assignment form (hjid=) and object-key form (hjid:). (added: 2026-03-10, dispatch: .13)
- LINK_STYLESHEET_RE needs two capture-group branches for both attribute orderings (rel-first and href-first). (added: 2026-03-10, dispatch: .12)
- When integrating two services with different input shapes, document the adapter inline at the mapping site. (added: 2026-03-10, dispatch: .44)
- Structure cross-file detection as explicit numbered passes (Pass 1: per-file, Pass 2: cross-file). (added: 2026-03-10, dispatch: .44)
- When new cross-file analysis affects existing integration tests, update fixtures to be self-consistent rather than loosening assertions. (added: 2026-03-10, dispatch: .44)
- Inngest functions must be imported+registered in api.inngest.ts. Admin clients NOT serializable across steps — create via dynamic import inside each step. (added: 2026-03-10, dispatch: .10/.14)
- app/uninstalled fires immediately; shop/redact fires 48h later. Both paths clean up via deleteShopData(). (added: 2026-03-10, dispatch: .21/.29)
- Fingerprint-based diffing: use multiset (Map of counts) not Set. getPreviousScanForTheme filters to COMPLETED status. (added: 2026-03-10, dispatch: .27)
- Snippets can render other snippets in Liquid. File reference analyzer must include snippet files in the reference scan pass. (added: 2026-03-10, dispatch: .26)
