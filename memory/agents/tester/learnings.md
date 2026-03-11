# Learnings: tester

## Codebase Patterns
- Testing framework: Vitest v4 (not Jest). Config in `vitest.config.ts`. Runs cleanly alongside Vite v6.
- Tests mirror app/ structure in `tests/` directory (e.g., `tests/services/scan-engine.test.ts`).
- Mock Shopify admin with `createMockAdmin()` from `tests/mocks/shopify.ts`.
- Mock Prisma client with `createMockPrismaClient()` from `tests/mocks/prisma.ts`.
- Mock Inngest step tools with `createMockInngestStep()` from `tests/mocks/inngest.ts`.
- Use `npx vitest run <path>` for single-file runs without the npm script alias. (added: 2026-03-10, dispatch: .33)
- billing.server.ts getPlanFeatures() is a pure function — ideal smoke test, no mocks needed. (added: 2026-03-10, dispatch: .33)

## Gotchas
- When mocking `inngest/client` for functions using `inngest.createFunction()` at module load, include `createFunction: vi.fn((_config, _trigger, handler) => ({ fn: handler }))`. Without it, the source module throws at import time. (added: 2026-03-10, dispatch: S-01/S-02)
- `mockReset()` before per-test `mockResolvedValueOnce` sequences. When `beforeEach` pre-populates a mock with `Once` calls, per-test overrides append rather than replace. Call `mockFn.mockReset()` first. (added: 2026-03-10, dispatch: S-01/S-02)
- When mocking ESM default exports (`import db from`), the vi.mock factory must use `{ default: { ... } }`. When writing helpers that accept nullable overrides, use ternary (`!== undefined ? value : default`) not `??` — nullish coalescing swallows `null`. (added: 2026-03-10, dispatch: S-04)
- completeScanWithFindings uses array-form $transaction (db.$transaction([op1, op2])), not callback-form. Mock with `$transaction: vi.fn(async (ops) => Promise.all(ops))`. (added: 2026-03-10, dispatch: .45)
- Always use mockRejectedValueOnce (not mockRejectedValue) for error-propagation tests — permanent rejections bleed into sibling tests even with beforeEach clearAllMocks. (added: 2026-03-10, dispatch: .45)
- canStartScan uses db directly for active-scan guard + delegates to countScansForShopSince from scan model. Both need independent mocks. (added: 2026-03-10, dispatch: .45)
- analyzeFileReferences scans ALL liquid files (including snippets) for render/include tags — transitive snippet→snippet references are correctly resolved. Tests must account for this. (added: 2026-03-10, dispatch: .45)
- Shopify's embedded admin has Cloudflare captcha — automated E2E (Playwright/Cypress) is impractical. Focus on unit + integration tests.
- GraphQL responses from Shopify include `extensions.cost` — mock this in API response fixtures.
- Inngest function tests need realistic event payloads with shopId, scanId, themeId.
- Theme file content in test fixtures should use real Liquid syntax with known ghost code patterns.

## Preferences
- Test the scan engine with realistic fixtures: actual Liquid templates containing orphaned script tags, broken snippet includes, CSS imports.
- Prefer testing behavior (what the function returns) over implementation details (which internal method was called).
- Every service function should have both happy-path and error-path tests.

## Cross-Agent Notes
- Ask implementer for edge cases they considered but couldn't fully handle — those make the best test cases.
- Report test coverage gaps to reviewer for audit.
- Inngest function handlers accessible via scanTheme.fn — call directly as fn({ event, step }) to bypass SDK runtime. (added: 2026-03-10, dispatch: .35)
- vi.mock() hoisting in Vitest correctly intercepts dynamic imports (await import(...)). Mocked modules resolve from mock registry even inside step callbacks. (added: 2026-03-10, dispatch: .35)
- For best-effort catch blocks, use mockResolvedValueOnce for preceding calls so only the targeted invocation rejects. mockRejectedValue without Once corrupts earlier steps. (added: 2026-03-10, dispatch: .35)
- formatDate uses toLocaleDateString('en-US') — ISO string inputs parsed as UTC midnight can shift by one day in negative-UTC-offset envs. Use Date object constructors with local-time args, or noon UTC times + regex matching. (added: 2026-03-10, dispatch: .49)
- For exhaustive enum coverage, pair individual named tests per value (readability + pinpoint failure) with a loop over all values that asserts set membership (forward-compatibility guard). (added: 2026-03-10, dispatch: .49)
- (from implementer) fetchMainTheme in theme-fetcher.server.ts has 3 unit tests (success, null, error). Scan detail page now has 3 testable behaviors: polling timeout banner, completion toast, no-toast on initial terminal load. (added: 2026-03-10, dispatch: .46/.47)
