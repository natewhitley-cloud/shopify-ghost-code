# Archived Learnings: tester

- completeScanWithFindings uses array-form $transaction (db.$transaction([op1, op2])), not callback-form. Mock with `$transaction: vi.fn(async (ops) => Promise.all(ops))`. (archived: 2026-04-01, reason: relevance passive — GC-06c changed to interactive transaction, entry is now incorrect)
- canStartScan uses db directly for active-scan guard + delegates to countScansForShopSince from scan model. Both need independent mocks. (archived: 2026-04-01, reason: relevance low, freshness stale — implementation detail discoverable from code)
- analyzeFileReferences scans ALL liquid files (including snippets) for render/include tags — transitive snippet→snippet references are correctly resolved. Tests must account for this. (archived: 2026-04-01, reason: relevance low, freshness stale — scanner internals discoverable from code)
- (from implementer) fetchMainTheme in theme-fetcher.server.ts has 3 unit tests (success, null, error). Scan detail page now has 3 testable behaviors: polling timeout banner, completion toast, no-toast on initial terminal load. (archived: 2026-04-01, reason: relevance low — snapshot of past coverage, test file is source of truth)
- GraphQL responses from Shopify include `extensions.cost` — mock this in API response fixtures. (archived: 2026-04-01, reason: relevance low, freshness stale — discoverable from existing test fixtures)
- Inngest function tests need realistic event payloads with shopId, scanId, themeId. (archived: 2026-04-01, reason: relevance low, freshness stale — existing tests demonstrate the pattern)
