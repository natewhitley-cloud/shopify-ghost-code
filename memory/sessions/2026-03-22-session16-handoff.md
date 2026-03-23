## Session Handoff: 2026-03-22/23 — Post-Launch Feature Sprint

### What Got Done

**7 features implemented, tested, and committed across 5 commits:**

1. **10 new app signatures (GC-iev)**: Pop Convert, EcomSend, Avada SEO Suite, BOOSTER SEO, Pandectes GDPR, Air Reviews, Okendo, Growave, tawk.to, Microsoft Clarity. Signature DB now at 74 apps.
2. **Tracker privacy callout (GC-ne7)**: `isTracker` flag on AppSignature type. Analytics/pixel apps (GA, GTM, Hotjar, Lucky Orange, Facebook Pixel, TikTok Pixel, Microsoft Clarity) get red TRACKING badge on scan findings. Privacy warning banner when tracker findings present.
3. **App Impact Map (GC-zi0)**: New scan detail section grouping findings by app — shows which files each app modified, finding count, and types. Computed client-side from existing scan data.
4. **Performance Impact Score (GC-1dw)**: New summary tile showing count of external scripts/stylesheets from uninstalled apps. Color-coded (neutral/warning/critical). Grid adapts from 3 to 4 columns via auto-fit.
5. **Unknown finding feedback loop (GC-3u8)**: Scan engine now collects unrecognized external scripts/stylesheets (URLs not matching any known app). Stored in new `UnknownScript` model (separate from findings — no health score impact). Merchants can submit "which app left this?" via per-row forms. New `SignatureSubmission` model stores responses. Filters out Shopify CDN URLs.
6. **Removed apps + orphaned webhook warning (GC-jxy)**: Permission audit now shows previously installed apps with former access level. Warns about potential orphaned webhooks/residual data. PII access badge on removed apps that held sensitive scopes.
7. **Sensitive scope alerts (GC-tob)**: New Privacy & Security Alerts card on app detail page. Human-readable warnings for PII scopes (read_customers, read_orders) and store-modification scopes (write_checkouts, write_themes). PII access badge added to permission audit app list.

**Also done:**
- Product strategy doc updated with shipped v1 capabilities, post-launch roadmap, cleanup gap analysis, and artifact research inventory
- Fixed pre-existing broken Judge.me JSON-LD test
- 8 backlog items created, 7 closed this session

### Key Decisions

- **Orphaned webhook detection adapted**: Shopify's `webhookSubscriptions` API only shows current app's webhooks — can't see other apps'. Adapted to show removed apps with warnings about potential orphaned webhooks/data instead of direct webhook detection.
- **Unknown scripts stored separately from findings**: `UnknownScript` model, not `Finding`. Prevents unrecognized scripts from inflating health score or finding count.
- **Tracker classification on signature, not finding**: `isTracker` lives on `AppSignature` type and is resolved at display time via `isTrackerApp()` lookup — no DB migration needed.
- **Grid adapts to tile count**: Changed scan tiles from fixed 3-column to `auto-fit, minmax(200px, 1fr)` so it handles 3 or 4 tiles gracefully.
- **Auto-removal explicitly rejected**: Documented in product strategy — liability too high for solo dev, Cleanify's cautionary tale, merchant trust issues around theme modification.

### Scope Changes Needed (Review Required)

**No new API scopes required for this session's features.** All new capabilities use existing data or the already-granted `read_apps` scope. However:

- **GC-icb (translation metafields, future)**: Will need either `read_metafields` or `read_translations` scope — TBD when this is implemented.
- **GC-5n8 (UI text fragments, future)**: No new scopes — theme file scanning only.

### DB Migration

- New migration `20260322000000_add_unknown_scripts` adds `UnknownScript` and `SignatureSubmission` tables. Created with `--create-only` (no local DB). **Run `npx prisma migrate dev` on connected environment before deploying.**

### Test Count

- 715 → 778 (63 new tests)
- 41 test files, all passing
- Zero TypeScript errors

### Commits

| Hash | Description |
|------|-------------|
| `32d0946` | feat(scanner): add 10 app signatures and tracker privacy classification |
| `443d9cf` | feat(ui): add tracker privacy callout, app impact map, and performance score |
| `bf27cd0` | feat(scanner): add unknown script collection and feedback loop |
| `211d17d` | feat(permissions): add removed apps section and sensitive scope alerts |
| `6fef228` | docs: update product strategy with shipped features and post-launch roadmap |

### Open Backlog (9 beads)

- **GC-ue5** (P1): Form legal entity (LLC) — user doing via Northwest Registered Agent
- **GC-mfj** (P1 epic): Deploy Ghost Code — 1 subtask remains (E2E test)
- **GC-ehc** (P2): Set up support email — blocks legal pages and app listing
- **GC-mfj.8** (P2): E2E test in dev store — checklist in docs/e2e-test-checklist.md
- **GC-qys** (P2): Better deploy error messages
- **GC-5n8** (P3): Persistent UI text fragment detection
- **GC-icb** (P3): Translation metafield detection via GraphQL API
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade

### Open Questions

- **Unknown script feedback curation**: Submissions go into `SignatureSubmission` table. No admin UI or batch promotion workflow yet. Manual review for now — query DB directly to review submissions and promote validated ones to `app-signatures.server.ts`.
- **Webhook detection long-term**: The adapted approach (removed apps warning) is useful but limited. True orphaned webhook detection would require Shopify to expose cross-app webhook visibility, which they currently don't. Monitor API changes.
- **Performance Impact Score fidelity**: Currently shows count of external resources, not byte size. Adding Content-Length checks would require network calls during scan (adds latency + failure modes). Count is a reasonable proxy for v1.1.

### Recommended Next Steps

1. **Form LLC** (GC-ue5) — unblocks entity name in legal docs and support email
2. **Run `npx prisma migrate dev`** on connected environment to apply UnknownScript migration
3. **Clean synthetic test data** from dev store theme
4. **E2E test in dev store** (GC-mfj.8) — walk through checklist with clean theme
5. **Set up support email** (GC-ehc) → update legal docs → write app store listing → submit

### Risks & Warnings

- **Railway auto-deploys from main** — the 5 new commits will deploy on push. Run migration before pushing.
- **Dev store theme still has synthetic artifacts** — must clean before real E2E testing
- **Free plan scan limit**: Dev store still has Professional plan via direct DB update
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet
- **UnknownScript migration not yet applied** — scan-theme Inngest function now calls `createUnknownScripts()` which will fail if migration hasn't run

### CI State

- All green: lint, format, typecheck, tests (778 passing)
- Pre-commit hook active (husky + lint-staged)
