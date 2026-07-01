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

- Inngest functions in `inngest/functions/` use step functions for multi-step async work.
- Inngest v3 requires `new Inngest({ schemas: new EventSchemas().fromRecord<Events>() })` — the `Inngest<Events>` generic from v2 is rejected. (added: 2026-03-10, dispatch: .41)
- Cron Inngest functions use `{ cron: '0 6 * * *' }` trigger (not event name). Fan-out pattern: coordinator fetches shops + sends batch events, worker function processes per-shop with concurrency limit. (updated: 2026-03-11, dispatch: .69)
- Inngest functions must be imported+registered in api.inngest.ts. Admin clients NOT serializable across steps — create via dynamic import inside each step. (added: 2026-03-10, dispatch: .10/.14)
- Static import of logger.server.ts works at Inngest function module level — .server.ts suffix is a Vite/Remix bundler concern, Inngest runs server-side only. Use dynamic import only inside step.run() callbacks. (added: 2026-04-01, dispatch: GC-yej)
- For pure operational monitoring functions (no DB writes, no fan-out), a single `step.run` to fetch data + synchronous logic outside steps is the right Inngest pattern. Steps add retry semantics; logging doesn't warrant a separate step. (added: 2026-03-28, dispatch: GC-lrq)
- Scan-dispatch has TWO contexts with different idempotency needs: (1) request-context (routes/webhooks) → use `app/services/scan-dispatch.server.ts` `dispatchScan()` which does createScan + inngest.send and SWALLOWS send errors (scan stays PENDING; watch-stale-scans watchdog expires it). (2) Inngest worker-context → must NOT use that helper; split createScan and `step.sendEvent` into SEPARATE Inngest steps so a send retry never re-runs createScan (avoids duplicate/orphan PENDING scans). Inngest memoizes each step independently. (added: 2026-06-15, dispatch: GC-40u/QLT-7)
- app/lib/logger.server.ts provides structured JSON logging. Use `logger.info/warn/error(message, context)` in webhook handlers — not bare console.*. (added: 2026-03-10, dispatch: .60)
- When adding observability side-effects to webhooks, use `.then()/.catch()` fire-and-forget with explicit error logging — `void promise` suppresses rejection warnings but silently drops errors. (added: 2026-03-28, dispatch: GC-hsk)
- When adding operational monitoring to a function with established callers, make the new parameter optional — zero test breakage, existing call sites unchanged, monitoring activates progressively as callers are updated. (added: 2026-03-28, dispatch: GC-8ib)
- When an action handles multiple intents (scan start vs dismiss), read formData before any plan-gating checks so non-scan intents don't get blocked by quota checks. (added: 2026-03-31, dispatch: GC-04d)
- When a model-layer count function serves as a quota mechanism, document which statuses are included/excluded in JSDoc — the filter IS the contract. (added: 2026-03-11, dispatch: l4l)
- vi.mock() factory functions are hoisted before variable initializations. Mock objects inside vi.mock() factories MUST use vi.hoisted(() => ...). (added: 2026-03-10, dispatch: .43)
- When new cross-file analysis affects existing integration tests, update fixtures to be self-consistent rather than loosening assertions. (added: 2026-03-10, dispatch: .44)
- When removing a guard that produces a named outcome, check whether tests assert that outcome string explicitly — tests need rewriting, not just removal. (added: 2026-03-10, dispatch: .56)
- When removing a feature, grep `inngest/` too — Inngest functions may have dynamic imports of models not visible in the feature's own route/service files. (added: 2026-03-23, dispatch: GC-iw0)
- Model-layer pagination house style: over-fetch `limit + 1`, return `{ items, hasNextPage, nextCursor }` (see `getScansForShop`, `getFindingsPageForScan`). Add `id asc` as the final `orderBy` tiebreaker so the cursor is stable when primary sort keys are non-unique. (added: 2026-06-17, dispatch: GC-6vv)
- Lazy resource route for expensive secondary data: when a page needs heavy secondary data that doesn't block the primary render (e.g. previous-scan diff), use a `.diff.tsx` resource route + `useFetcher` + a `useRef` guard. The ref stops the fetcher re-firing on `revalidator.revalidate()` poll cycles. Idiomatic React Router; avoids a DB migration (respects the prod-Railway hazard). (added: 2026-06-17, dispatch: GC-6vv)
- Derive summary/tile counts from the already-fetched aggregate (`findingSummary.byType`), NOT by filtering a paginated findings array — the array only holds the visible page, so filtering it undercounts once pagination is in play. (added: 2026-06-17, dispatch: GC-6vv)
- `app/styles/shared.ts` exposes CSS-string builders for duplicated blocks: `htmlTableCss(className)` (base compact-table rules) and `tileStatusTintCss({success,warning,critical})` (3-variant status tint from `STATUS_TINTS`). Call these in `<style>` blocks and stack overrides (sticky/hover/columns) inline after. Compact tables use header bg `TABLE_BORDER_LIGHT` (#edeeef); comfortable tables (scan-history) use `BG_SURFACE`. Tokens consumed inside a helper do NOT need importing in the calling route. (added: 2026-06-17, dispatch: GC-hlm)
- When tokenizing hardcoded hex, a color that intentionally differs from the nearest token (e.g. a deliberately-lighter border) should stay inline WITH a comment citing the token it diverges from — don't force-unify and change the rendered appearance. (added: 2026-06-17, dispatch: GC-hlm)
- Shopify "Leave a Review" CTAs: deep-link to `https://apps.shopify.com/<handle>#modal-show=WriteReviewModal` — it opens the write-review modal directly on the listing. The `#reviews` fragment does NOT exist on App Store listing pages. Portfolio-wide (every app has a review CTA). Source: Shopify docs "Manage app reviews". (added: 2026-07-01, dispatch: GC-u9e)
- Running a TS script that imports app code: `npx vite-node --config vitest.config.ts scripts/<file>.ts`. The `--config vitest.config.ts` is REQUIRED — `vite.config.ts` sets `server.fs.allow: ["app","node_modules"]`, which blocks vite-node from loading files under `scripts/`. Omitting it fails. (added: 2026-07-01, dispatch: GC-8uw)
- `ThemeFile` is `{ filename: string; content: string }`, exported from `app/services/scan-engine.server.ts:76`. Fixtures live in `tests/fixtures/theme-files.ts` (Liquid strings) and `tests/fixtures/reference-themes.ts` (Dawn/stock markup for false-positive tests) — neither exports pre-built `ThemeFile[]`; synthesize inline. (added: 2026-07-01, dispatch: GC-8uw)
- Perf baseline for `scanThemeFiles` (M-series Mac, synthetic fixtures): small 25-file theme p50~11ms/p99~51ms; large 200-file theme p50~80ms/p99~100ms. It runs synchronously and blocks the event loop — under 5 concurrent large scans the event-loop-delay p99 spikes to ~350-400ms. Confirms offload (worker pool / separate process) is warranted for production UX. (added: 2026-07-01, dispatch: GC-8uw)
- `perf_hooks.monitorEventLoopDelay()` is unreliable for `setImmediate`-based load tests — its V8 sampling hook can't interrupt a check-phase drain, washing out percentiles. Use a manual `setInterval` probe (measure `now - lastTick - intervalMs` per tick) for legible event-loop-lag numbers. (added: 2026-07-01, dispatch: GC-8uw)
