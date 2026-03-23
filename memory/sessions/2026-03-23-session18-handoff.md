## Session Handoff: 2026-03-23 (session 18) — Signatures, Theme Testing, E2E Scan

### What Got Done

1. **GC-5n8 GHOST_TEXT finding type** — detects orphaned widget markup (review widgets, trust badges, wishlist buttons). 10 apps covered. 14 new tests.
2. **GC-icb GHOST_TRANSLATION finding type** — detects orphaned translations via Shopify Translations API. Cross-references installed apps. Runs as Inngest Step 3. `read_translations` optional scope registered. 27 new tests.
3. **20 new app signatures** — Cookie consent (CookieYes, Cookiebot, iubenda, Consentmo), Search (Boost AI, Searchanise), Analytics (Elevar, Triple Whale, Littledata), Upsell (Rebuy, FBT, Candy Rack, Wiser, Selleasy), Social (Pinterest Pixel, Snapchat Pixel), Pop-ups (Sumo/BDOW!), Reviews (Fera), Page Builders (EComposer), Loyalty (Rivo). DB: 74 → 94 apps.
4. **Automated theme testing** — Shopify CLI push of test fixtures to dev store. No manual copy/paste. Documented in memory.
5. **Successful E2E scan** — 41 findings detected (18 HIGH, 14 MEDIUM, 9 LOW). All 9 theme-based finding types working. Tracker badges, performance impact, app impact map all rendering.
6. **3 CI lint fixes** — unused param, import ordering, unused beforeEach import.
7. **Backlog**: GC-5n8 closed, GC-icb closed, GC-nmc created (P3 theme picker).

### Key Decisions

- **Theme picker deferred to post-launch** (GC-nmc P3): Current behavior scans published theme only via `fetchMainTheme(roles: MAIN)`. Fine for launch — most merchants care about their live theme.
- **Translation detection is heuristic**: No creator attribution on Shopify Translation objects. Cross-ref with 10 known translation app names is the best available signal.
- **Signature patterns from web research**: CDN domains/snippet names for 20 new apps sourced from official docs and installation guides. May need adjustment when encountering real stores.

### DB Migrations

- `20260323134446_add_ghost_text_finding_type` — applied
- `20260323135312_add_ghost_translation_finding_type` — applied
- Both applied to Railway via `prisma migrate deploy`

### Test Count

- 778 → 833 (+55 tests)
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
| `e56729a` | docs: session 17 retro and handoff |
| `21bc162` | feat(scanner): add 20 app signatures |

### Uncommitted Files

- `docs/test-theme-fixtures.liquid` — reference doc for theme test artifacts (not critical to commit)

### Open Backlog (8 beads)

- **GC-ue5** (P1): Form legal entity (LLC)
- **GC-mfj** (P1 epic): Deploy Ghost Code — 1 subtask remains (E2E test)
- **GC-ehc** (P2): Set up support email
- **GC-mfj.8** (P2): E2E test in dev store
- **GC-qys** (P2): Better deploy error messages
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade
- **GC-nmc** (P3): Theme picker — scan unpublished themes

### Dev Store Theme State

Test fixtures are pushed to `nw-dev-store-2.myshopify.com` theme `test-data` (#149633761457). Contains artifacts for all 9 theme-based finding types. Must be cleaned before real E2E testing or app review submission.

### Recommended Next Steps

1. **Form LLC** (GC-ue5) — unblocks entity name in legal docs and support email
2. **Set up support email** (GC-ehc) → update legal docs with real email
3. **Clean dev store theme** — remove synthetic test artifacts
4. **E2E test** (GC-mfj.8) — run through checklist with clean theme
5. **App store listing → submit**

### Risks & Warnings

- **Dev store theme has synthetic artifacts** — must clean before real E2E or app review
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet
- **`read_translations` scope not yet requestable by merchants** — no UI flow for optional scope grant
- **Scan only targets published theme** — no theme picker (GC-nmc deferred)
