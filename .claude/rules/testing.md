---
paths:
  - "tests/**/*"
  - "app/**/*.test.*"
  - "vitest.config.*"
strength: must
---

# Testing Conventions

## Framework

Vitest for all tests. No Jest, no Mocha.

## File Location

Tests mirror the source structure:

```
app/services/scanner.ts      -> tests/services/scanner.test.ts
app/routes/app.scan.tsx      -> tests/routes/app.scan.test.ts
app/models/shop.server.ts    -> tests/models/shop.server.test.ts
inngest/scan-theme.ts        -> tests/inngest/scan-theme.test.ts
```

## Commands

```bash
npx vitest                    # Run all tests
npx vitest --coverage         # With coverage report
npx vitest --watch            # Watch mode
npx vitest run tests/services # Run specific directory
```

## Test Categories

### Unit Tests

- Test business logic in `app/services/` in isolation
- Mock Prisma client for database calls
- Mock Shopify GraphQL responses
- Test scanner pattern matching with real Liquid/CSS/JS snippets

### Integration Tests

- Test loaders and actions with mocked Shopify session
- Test Prisma operations against test database
- Test Inngest job handlers with mocked GraphQL responses

### Manual E2E

- Use Shopify dev store for end-to-end testing
- `shopify app dev` starts tunnel for live testing
- No automated E2E framework (manual verification)

## Patterns

- Use `describe`/`it` blocks, not `test`
- Name tests as behavior: `it('returns findings sorted by severity')`
- Mock at boundaries (GraphQL client, Prisma client), not internals
- Every service function needs at minimum: happy path, empty input, error case
