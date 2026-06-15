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
- app/lib/ for client-safe utility modules (no .server.ts), app/components/ for shared UI components. Both patterns established. (added: 2026-03-10, dispatch: .42)
- When extracting shared utilities, compare ALL call sites for behavioral differences before writing the shared version. (added: 2026-03-10, dispatch: .42)
- Extract shared GraphQL queries as module-level helpers. themes() uses roles: MAIN (uppercase enum). Full GID string is the themeId. (added: 2026-03-10, dispatch: .19)
- After implementing, notify tester which edge cases are most important to cover.
- s-button valid variants are: primary, secondary, tertiary, auto — 'plain' is not supported. (added: 2026-03-31, dispatch: GC-04d)

## Task-Relevant

- Inngest functions in `inngest/functions/` use step functions for multi-step async work.
- Inngest v3 requires `new Inngest({ schemas: new EventSchemas().fromRecord<Events>() })` — the `Inngest<Events>` generic from v2 is rejected. (added: 2026-03-10, dispatch: .41)
- Cron Inngest functions use `{ cron: '0 6 * * *' }` trigger (not event name). Fan-out pattern: coordinator fetches shops + sends batch events, worker function processes per-shop with concurrency limit. (updated: 2026-03-11, dispatch: .69)
- vi.mock() factory functions are hoisted before variable initializations. Mock objects inside vi.mock() factories MUST use vi.hoisted(() => ...). (added: 2026-03-10, dispatch: .43)
- When integrating two services with different input shapes, document the adapter inline at the mapping site. (added: 2026-03-10, dispatch: .44)
- When new cross-file analysis affects existing integration tests, update fixtures to be self-consistent rather than loosening assertions. (added: 2026-03-10, dispatch: .44)
- Inngest functions must be imported+registered in api.inngest.ts. Admin clients NOT serializable across steps — create via dynamic import inside each step. (added: 2026-03-10, dispatch: .10/.14)
- When removing a guard that produces a named outcome, check whether tests assert that outcome string explicitly — tests need rewriting, not just removal. (added: 2026-03-10, dispatch: .56)
- app/lib/logger.server.ts provides structured JSON logging. Use `logger.info/warn/error(message, context)` in webhook handlers — not bare console.\*. (added: 2026-03-10, dispatch: .60)
- File-local component extraction (no new file) is appropriate for route-specific UI patterns that don't need cross-route sharing. (added: 2026-03-10, dispatch: 87m)
- When a model-layer count function serves as a quota mechanism, document which statuses are included/excluded in JSDoc — the filter IS the contract. (added: 2026-03-11, dispatch: l4l)
- Resource routes (no default export) return Response directly from loader — use Content-Type + Content-Disposition headers for file downloads. Polaris `<s-link>` doesn't support `download` attribute; rely on Content-Disposition: attachment. (added: 2026-03-11, dispatch: .71)
- When removing a feature, grep `inngest/` too — Inngest functions may have dynamic imports of models not visible in the feature's own route/service files. (added: 2026-03-23, dispatch: GC-iw0)
- For pure operational monitoring functions (no DB writes, no fan-out), a single `step.run` to fetch data + synchronous logic outside steps is the right Inngest pattern. Steps add retry semantics; logging doesn't warrant a separate step. (added: 2026-03-28, dispatch: GC-lrq)
- When adding observability side-effects to webhooks, use `.then()/.catch()` fire-and-forget with explicit error logging — `void promise` suppresses rejection warnings but silently drops errors. (added: 2026-03-28, dispatch: GC-hsk)
- When adding operational monitoring to a function with established callers, make the new parameter optional — zero test breakage, existing call sites unchanged, monitoring activates progressively as callers are updated. (added: 2026-03-28, dispatch: GC-8ib)
- When an action handles multiple intents (scan start vs dismiss), read formData before any plan-gating checks so non-scan intents don't get blocked by quota checks. (added: 2026-03-31, dispatch: GC-04d)
- Optimistic local state + fetcher.submit is the right pattern for instant UI feedback on dismiss/toggle actions in embedded Shopify apps. (added: 2026-03-31, dispatch: GC-04d)
- Flag any Shopify API behavior that differs from documentation for the debugger's learnings.
- Static import of logger.server.ts works at Inngest function module level — .server.ts suffix is a Vite/Remix bundler concern, Inngest runs server-side only. Use dynamic import only inside step.run() callbacks. (added: 2026-04-01, dispatch: GC-yej)
- When converting a per-line regex detector to FULL-CONTENT matching (to catch multi-line tags), use the existing `lineNumberAtOffset` helper for line attribution, and precompute skip-line Sets from a prior line pass rather than restructuring to track offset ranges — least invasive. (added: 2026-06-15, dispatch: GC-b34)
- DANGER after per-line→full-content conversion: JS `\s*`/`\s+` then matches `\n`, so a pattern like RENDER_RE matches multi-line tags AND a second `/m`-anchored line-start pattern matches the inner line — DOUBLE-counting. Dedup by OFFSET RANGE (record `[match.index, match.index+len]` claimed by the first pattern, skip overlapping hits), NOT by derived line numbers, which differ across patterns for the same token. Always add a multi-line-token regression test. (added: 2026-06-15, dispatch: GC-b34)
- To match a bare Liquid statement at a line start (e.g. `render`/`include 'x'` inside a `{% liquid %}` block) use `/^[ \t]*(?:render|include)\s+["']...["']/gim` — the `^…/m` anchor avoids matching `render` inside HTML comments/strings without needing lookbehind. (added: 2026-06-15, dispatch: GC-b34)
- Conditional-aware meta detectors: track comment lines via the shared `buildCommentSkipLines(content)` helper (extracted in GC-b34); conditional-depth (`{% if/unless/case %}` ++ / `{% endif/... %}` --, skip when depth>0) stays inline per-detector. Meta tags can't legally appear inside `{% liquid %}` blocks, so bare if/endif there is a non-issue. (added: 2026-06-15, dispatch: GC-77m)
