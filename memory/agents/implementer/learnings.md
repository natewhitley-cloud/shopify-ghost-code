# Learnings: implementer

## Core

- Shopify admin access in routes: `const { admin } = await authenticate.admin(request);`
- Explicit error handling over try/catch-all. Name specific error conditions.
- Keep services stateless — pass dependencies as function parameters.
- Use TypeScript strict types for all Shopify API responses.
- AdminApiContext typed inline in services (structural interface) — avoids importing full Shopify SDK, keeps services testable. (added: 2026-03-10, dispatch: .11)
- Shopify GraphQL returns GID format (e.g., `gid://shopify/Theme/123`). Parse with string splitting, not parseInt.
- Extract shared GraphQL queries as module-level helpers. themes() uses roles: MAIN (uppercase enum). Full GID string is the themeId. (added: 2026-03-10, dispatch: .19)
- When extracting shared utilities, compare ALL call sites for behavioral differences before writing the shared version. (added: 2026-03-10, dispatch: .42)
- After implementing, notify tester which edge cases are most important to cover.
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.

## Task-Relevant

- app/lib/logger.server.ts provides structured JSON logging. Use `logger.info/warn/error(message, context)` in webhook handlers — not bare console.\*. (added: 2026-03-10, dispatch: .60)
- When adding observability side-effects to webhooks, use `.then()/.catch()` fire-and-forget with explicit error logging — `void promise` suppresses rejection warnings but silently drops errors. (added: 2026-03-28, dispatch: GC-hsk)
- When removing a guard that produces a named outcome, check whether tests assert that outcome string explicitly — tests need rewriting, not just removal. (added: 2026-03-10, dispatch: .56)
- When removing a feature, grep `inngest/` too — Inngest functions may have dynamic imports of models not visible in the feature's own route/service files. (added: 2026-03-23, dispatch: GC-iw0)
- When you swap a call-site's import (e.g. `scanThemeFiles` → `scanThemeFilesInPool`), grep ALL test files for `vi.mock` of the OLD module — integration/inngest tests carry their own mocks that must be updated or they silently test the wrong path. (added: 2026-07-01, dispatch: GC-8uw)
- `admin.graphql()` THROWS on GraphQL errors: `@shopify/shopify-api`'s `GraphqlClient.request()` calls `throwFailedRequest` and throws `GraphqlQueryError` whenever an HTTP-200 response body contains `errors` (incl. ACCESS_DENIED). Structured errors live at `err.body.errors.graphQLErrors` (array of `{message, extensions:{code}}`); `err.message` = first error's message. Any code that only inspects `json.errors` (the body path) MISSES this thrown path — you must classify in the `catch` too. Caused GC-jlk: probeScope mislabeled thrown access-denied as transient → scans stuck IN_PROGRESS → watchdog-FAILED. (added: 2026-07-01, dispatch: GC-jlk)
- `reconcileShopPlan` uses `recordEvent: true` as the semantic marker for the redirect fast-path — the one-shot Admin-API retry keys off it. Future callers wanting retry behavior pass `recordEvent: true`; do NOT add a separate `retryOnError` option. (added: 2026-07-07, dispatch: GC-4oc)
- (from tester) `fetchActiveSubscriptions`'s `json.errors` branch may be dead code — the real SDK throws `GraphqlQueryError` on HTTP-200+errors bodies, which the catch also handles (both return null, so behavior is correct either way). Note this SDK uncertainty in the helper's comment before ever removing the throw-handling. (added: 2026-07-07, dispatch: GC-4oc-audit)
