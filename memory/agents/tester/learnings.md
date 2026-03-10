# Learnings: tester

## Codebase Patterns
- Testing framework: Vitest (not Jest). Config in `vitest.config.ts`.
- Tests mirror app/ structure in `tests/` directory (e.g., `tests/services/scan-engine.test.ts`).
- Mock Shopify admin with `vi.mock('../app/shopify.server')` — mock `authenticate.admin()`.
- Mock Prisma client for database tests — avoid hitting real DB in unit tests.
- Mock Inngest step tools with `createStepTools` from `inngest/test` (verify SDK version).

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
