# Learnings: tester

## Core

- Testing framework: Vitest v4 (not Jest). Config in `vitest.config.ts`. Runs cleanly alongside Vite v6.
- Tests mirror app/ structure in `tests/` directory (e.g., `tests/services/scan-engine.test.ts`).
- Mock Shopify admin with `createMockAdmin()` from `tests/mocks/shopify.ts`.
- Mock Prisma client with `createMockPrismaClient()` from `tests/mocks/prisma.ts`.
- Mock Inngest step tools with `createMockInngestStep()` from `tests/mocks/inngest.ts`.
- Use `npx vitest run <path>` for single-file runs without the npm script alias. (added: 2026-03-10, dispatch: .33)
- `mockReset()` before per-test `mockResolvedValueOnce` sequences. When `beforeEach` pre-populates a mock with `Once` calls, per-test overrides append rather than replace. Call `mockFn.mockReset()` first. (added: 2026-03-10, dispatch: S-01/S-02)
- When mocking ESM default exports (`import db from`), the vi.mock factory must use `{ default: { ... } }`. When writing helpers that accept nullable overrides, use ternary (`!== undefined ? value : default`) not `??` — nullish coalescing swallows `null`. (added: 2026-03-10, dispatch: S-04)
- Always use mockRejectedValueOnce (not mockRejectedValue) for error-propagation tests — permanent rejections bleed into sibling tests even with beforeEach clearAllMocks. (added: 2026-03-10, dispatch: .45)
- When mocking `app/shopify.server` for files that use dynamic `import()` (like Inngest functions), include ALL exports in the vi.mock() factory — not just the ones visible to the top-level module. Dynamic imports resolve through Vitest's mock registry. (added: 2026-03-10, dispatch: .62)
- vi.mock() hoisting in Vitest correctly intercepts dynamic imports (await import(...)). Mocked modules resolve from mock registry even inside step callbacks. (added: 2026-03-10, dispatch: .35)
- When adding tests for a new model function using a Prisma method not yet in the mock (e.g., findFirst on mockDb.finding), check the vi.hoisted mock object first and add the missing vi.fn() entry before writing assertions. (added: 2026-03-10, dispatch: acw-review)
- When a service function gains an optional parameter, tests using exact argument assertions break. Use `expect.anything()` for args the test doesn't care about to make tests resilient to signature additions. (added: 2026-03-28, dispatch: GC-monitoring-sprint)
- When a webhook handler gains a new import from a module already mocked, the mock factory must include the new export or Vitest throws at runtime. Grep for vi.mock of modified modules after any sprint dispatch. (added: 2026-03-28, dispatch: GC-monitoring-sprint)

## Task-Relevant

- billing.server.ts getPlanFeatures() is a pure function — ideal smoke test, no mocks needed. (added: 2026-03-10, dispatch: .33)
- When mocking `inngest/client` for functions using `inngest.createFunction()` at module load, include `createFunction: vi.fn((_config, _trigger, handler) => ({ fn: handler }))`. Without it, the source module throws at import time. (added: 2026-03-10, dispatch: S-01/S-02)
- Shopify's embedded admin has Cloudflare captcha — automated E2E (Playwright/Cypress) is impractical. Focus on unit + integration tests.
- Theme file content in test fixtures should use real Liquid syntax with known ghost code patterns.
- Prefer testing behavior (what the function returns) over implementation details (which internal method was called).
- Every service function should have both happy-path and error-path tests.
- Ask implementer for edge cases they considered but couldn't fully handle — those make the best test cases.
- Inngest function handlers accessible via scanTheme.fn — call directly as fn({ event, step }) to bypass SDK runtime. (added: 2026-03-10, dispatch: .35)
- For best-effort catch blocks, use mockResolvedValueOnce for preceding calls so only the targeted invocation rejects. mockRejectedValue without Once corrupts earlier steps. (added: 2026-03-10, dispatch: .35)
- formatDate uses toLocaleDateString('en-US') — ISO string inputs parsed as UTC midnight can shift by one day in negative-UTC-offset envs. Use Date object constructors with local-time args, or noon UTC times + regex matching. (added: 2026-03-10, dispatch: .49)
- For exhaustive enum coverage, pair individual named tests per value (readability + pinpoint failure) with a loop over all values that asserts set membership (forward-compatibility guard). (added: 2026-03-10, dispatch: .49)
- React Router's `redirect()` returns a Response object — it does NOT throw. Only Shopify SDK's `billing.request()` throws a Response. Test redirect by checking return value, not catch block. (added: 2026-03-10, dispatch: .62)
- Integration test structure: tests/integration/ directory for multi-step flow tests. Self-contained mocks per file. Focus on "does the chain work" not edge cases (those belong in unit tests). (added: 2026-03-10, dispatch: .62)
- When testing weighted scoring formulas, derive expected outputs by hand before writing expect() calls — comment the derivation inline. Prefer inputs that produce integer normalized deductions to avoid rounding surprises. (added: 2026-03-10, dispatch: 2oz-tests)
