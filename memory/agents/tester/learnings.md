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
