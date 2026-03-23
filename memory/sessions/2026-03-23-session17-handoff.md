## Session Handoff: 2026-03-23 — GC-5n8 + GC-icb Feature Sprint

### What Got Done

**2 new scanner capabilities implemented, tested, committed, and deployed:**

1. **GHOST_TEXT finding type (GC-5n8)**: Detects orphaned widget markup from uninstalled apps — review widgets, trust badges, wishlist buttons, countdown timers. 10 apps covered with `textPatterns` on signatures. Deduplicates against script/snippet detectors. LOW severity. 14 new tests.

2. **GHOST_TRANSLATION finding type (GC-icb)**: Detects orphaned translation data via Shopify Translations API. Queries `translatableResources` for 5 resource types across all non-primary locales. Cross-references with 10 known translation app names — only flags when no translation app installed. Runs as Step 3 in Inngest scan pipeline. Gracefully skips if `read_translations` scope not granted. MEDIUM severity. 27 new tests.

**Also done:**
- Pushed all accumulated metadata (agents, skills, rules, session history) — 59 files
- Fixed 2 CI lint issues (unused param, import ordering) from prior session
- Fixed 1 CI lint issue (unused import) from this session
- Ran `prisma migrate deploy` on Railway (both new migrations applied)
- Ran `shopify app deploy` to register `read_translations` optional scope
- Retro completed, scanner capabilities memory updated

### Key Decisions

- **Translation detection uses heuristic orphan detection**: Shopify's Translations API has no creator attribution on Translation objects. Cross-referencing with installed apps is the only viable approach. If no translation app is installed but translations exist, they're flagged as orphaned.
- **Text fragment detection is LOW severity**: Widget markup is cosmetic — doesn't impact performance or security. Avoids alarming merchants over minor remnants.
- **Optional scope for translations**: `read_translations` added as optional scope (not required). Feature gracefully degrades when scope isn't granted. Standard scope — no Shopify approval needed.
- **Sampling strategy for translations**: 50 resources per type per locale. Avoids expensive full enumeration while providing representative signal.

### Patterns & Discoveries

- **Shopify Translations API is separate from metafields**: Dedicated `translatableResources` query with `translations(locale:)` field. NOT stored as metafields. 31 translatable resource types.
- **No translation creator attribution**: The `Translation` object has no `appId`, `createdBy`, or source metadata. This is a platform limitation.
- **`outdated` field on translations**: Indicates the original content changed since translation was last updated. Useful signal for staleness but not orphaning.
- **CI lint blind spot pattern**: Subagents don't run full eslint before returning. Pre-commit hooks only check staged files. Two consecutive sessions with post-push CI failures.

### DB Migrations

- `20260323134446_add_ghost_text_finding_type` — adds GHOST_TEXT to FindingType enum
- `20260323135312_add_ghost_translation_finding_type` — adds GHOST_TRANSLATION to FindingType enum
- Both applied to Railway via `prisma migrate deploy`

### Test Count

- 778 → 819 (41 new tests)
- 43 test files, all passing
- Zero TypeScript errors

### Commits

| Hash | Description |
|------|-------------|
| `171baa6` | fix: resolve CI lint errors — unused param and import ordering |
| `14f707e` | chore: update agents, skills, rules, memory, and project config |
| `2cf1ed4` | feat(scanner): add persistent UI text fragment detection (GC-5n8) |
| `e1e2e7f` | feat(scanner): add orphaned translation detection via Translations API (GC-icb) |
| `7e58475` | fix: remove unused beforeEach import in translation-fetcher test |

### Open Backlog (7 beads)

- **GC-ue5** (P1): Form legal entity (LLC) — user doing via Northwest Registered Agent
- **GC-mfj** (P1 epic): Deploy Ghost Code — 1 subtask remains (E2E test)
- **GC-ehc** (P2): Set up support email — blocks legal pages and app listing
- **GC-mfj.8** (P2): E2E test in dev store — checklist in docs/e2e-test-checklist.md
- **GC-qys** (P2): Better deploy error messages
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade

### Open Questions

- **Translation detection in production**: The sampling approach (50 resources per type) hasn't been tested against a real store with translations. Need E2E verification in dev store with test translations.
- **`read_translations` scope UX**: No UI exists yet to request the optional scope from merchants. Need an App Bridge scopes modal trigger (same pattern as `read_apps` for permission audit).

### Recommended Next Steps

1. **Form LLC** (GC-ue5) — unblocks entity name in legal docs and support email
2. **Set up support email** (GC-ehc) → update legal docs with real email
3. **Clean synthetic test data** from dev store theme
4. **E2E test in dev store** (GC-mfj.8) — walk through checklist at `docs/e2e-test-checklist.md`
5. **Write app store listing → submit**

### Risks & Warnings

- **Dev store theme still has synthetic artifacts** — must clean before real E2E testing
- **Free plan scan limit**: Dev store may still have Professional plan via direct DB update
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet
- **Translation scope not yet requestable by merchants** — no UI flow for optional scope grant
