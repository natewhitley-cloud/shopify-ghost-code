# Learnings: implementer

## Core
- Shopify admin access in routes: `const { admin } = await authenticate.admin(request);`
- Explicit error handling over try/catch-all. Name specific error conditions.
- Keep services stateless — pass dependencies as function parameters.
- Use TypeScript strict types for all Shopify API responses.
- AdminApiContext typed inline in services (structural interface) — avoids importing full Shopify SDK, keeps services testable. (added: 2026-03-10, dispatch: .11)
- Polaris `<s-*>` valid prop values: s-badge tone (info/critical/auto/neutral/success/caution/warning, NOT 'attention'), s-text (no fontWeight/variant — use `<strong>`/`<code>`), s-stack gap ('base'/'loose', NOT 'tight'). s-banner uses `tone="critical"` (NOT `status="critical"`). (updated: 2026-03-10, dispatch: S-04/E-02/E-03)
- React Router `useActionData` returns `undefined` for non-2xx action responses. To surface errors through `actionData`, return 200 with error payload, or use `useFetcher`. (added: 2026-03-10, dispatch: E-03)
- Shopify GraphQL returns GID format (e.g., `gid://shopify/Theme/123`). Parse with string splitting, not parseInt.
- Webhook handlers receive shop domain, not internal DB ID. Model functions for webhooks need domain-keyed lookups (e.g., updateShopPlanByDomain). (added: 2026-03-10, dispatch: .43)
- app/lib/ for client-safe utility modules (no .server.ts), app/components/ for shared UI components. Both patterns established. (added: 2026-03-10, dispatch: .42)
- When extracting shared utilities, compare ALL call sites for behavioral differences before writing the shared version. (added: 2026-03-10, dispatch: .42)
- Extract shared GraphQL queries as module-level helpers. themes() uses roles: MAIN (uppercase enum). Full GID string is the themeId. (added: 2026-03-10, dispatch: .19)
- After implementing, notify tester which edge cases are most important to cover.
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.

## Task-Relevant
- Inngest functions in `inngest/functions/` use step functions for multi-step async work.
- Inngest v3 requires `new Inngest({ schemas: new EventSchemas().fromRecord<Events>() })` — the `Inngest<Events>` generic from v2 is rejected. (added: 2026-03-10, dispatch: .41)
- Cron Inngest functions use `{ cron: '0 6 * * *' }` trigger (not event name). Fan-out pattern: coordinator fetches shops + sends batch events, worker function processes per-shop with concurrency limit. (updated: 2026-03-11, dispatch: .69)
- countScansForShopSince lives in scan.server.ts (model layer) — plan-gating imports it. Keep queries in models, not lib. (added: 2026-03-10, dispatch: .8)
- vi.mock() factory functions are hoisted before variable initializations. Mock objects inside vi.mock() factories MUST use vi.hoisted(() => ...). (added: 2026-03-10, dispatch: .43)
- billing.request() throws a redirect response internally — never returns a value. (added: 2026-03-10, dispatch: .43)
- When integrating two services with different input shapes, document the adapter inline at the mapping site. (added: 2026-03-10, dispatch: .44)
- When new cross-file analysis affects existing integration tests, update fixtures to be self-consistent rather than loosening assertions. (added: 2026-03-10, dispatch: .44)
- Inngest functions must be imported+registered in api.inngest.ts. Admin clients NOT serializable across steps — create via dynamic import inside each step. (added: 2026-03-10, dispatch: .10/.14)
- fetchMainTheme is the canonical shared function in app/services/theme-fetcher.server.ts. Returns { id, name, updatedAt }. Do not inline the MAIN theme GraphQL query — import from here. Dynamic import required inside Inngest step.run() callbacks. (added: 2026-03-10, dispatch: .46)
- When a dashboard shows badge counts for an in-progress scan, render "—" instead of "0" to avoid misleading merchants. (added: 2026-03-10, dispatch: .48)
- Use useRef for poll counters and mount-time state captures (no re-renders). useState only for values that drive UI updates (e.g. pollingTimedOut for banner). (added: 2026-03-10, dispatch: .47)
- shopify.toast.show() accepts { isError?: boolean; duration?: number } as second arg. Use isError: true for FAILED state toasts. (added: 2026-03-10, dispatch: .47)
- Files with $ in the name (e.g. app.scans.$scanId.tsx) must be single-quoted when passed to git add — unquoted, the shell expands $var to empty string. (added: 2026-03-10, dispatch: .47)
- When removing a guard that produces a named outcome, check whether tests assert that outcome string explicitly — tests need rewriting, not just removal. (added: 2026-03-10, dispatch: .56)
- createScan uses callback-form $transaction for atomic TOCTOU guard (check + create in one tx). completeScanWithFindings uses array-form $transaction with deleteMany prepended for idempotency. (added: 2026-03-10, dispatch: .52/.55)
- app/lib/logger.server.ts provides structured JSON logging. Use `logger.info/warn/error(message, context)` in webhook handlers — not bare console.*. (added: 2026-03-10, dispatch: .60)
- When updating a price constant, grep for the human-readable string form (e.g., `$59`) in UI routes — settings/pricing pages often duplicate the value as display text. (added: 2026-03-10, dispatch: 6jo)
- "First scan free" is a gating-layer concept in plan-gating.server.ts, not a plan feature — hasCompletedScans() in scan model detects first-ever scan. (added: 2026-03-10, dispatch: ek4)
- Free-tier preview pattern: return `previewFinding` (single highest-severity) server-side via getHighestSeverityFinding(), keep full findings array empty. Category breakdown uses findingSummary.byType with display-name mapping in the component. (added: 2026-03-10, dispatch: acw)
- File-local component extraction (no new file) is appropriate for route-specific UI patterns that don't need cross-route sharing. (added: 2026-03-10, dispatch: 87m)
- Health score is a pure function in app/lib/health-score.ts (client-safe, no .server.ts). computeHealthScore takes severity counts + totalFiles, returns { score, label, tone }. (added: 2026-03-10, dispatch: 2oz)
- Use getPlanFeatures(plan).autoRescan to gate Pro-plan features — avoids hardcoding plan name strings scattered across the codebase. (added: 2026-03-10, dispatch: rol)
- themes/publish webhook records lastThemePublishAt on Shop model for non-Pro nudge banners. Migration: add-shop-theme-publish-timestamp. (added: 2026-03-10, dispatch: rol)
- When a model-layer count function serves as a quota mechanism, document which statuses are included/excluded in JSDoc — the filter IS the contract. (added: 2026-03-11, dispatch: l4l)
- getScanById accepts optional `{ includeFindings?: boolean }` — use false for routes that don't need findings (e.g., free-tier scan detail). Prisma conditional include returns a union type; cast is needed at usage. (added: 2026-03-11, dispatch: .70)
- Static data files (app-signatures.server.ts) are append-only with zero coupling risk — skip dependency tracing, just verify with tsc. (added: 2026-03-11, dispatch: .73)
- Resource routes (no default export) return Response directly from loader — use Content-Type + Content-Disposition headers for file downloads. Polaris `<s-link>` doesn't support `download` attribute; rely on Content-Disposition: attachment. (added: 2026-03-11, dispatch: .71)
- Fan-out worker reuse: Standard weekly scan and Professional daily scan both fan out to the same poll-check-shop worker. Plan filtering belongs in the coordinator, not the worker. (added: 2026-03-11, dispatch: .72)
