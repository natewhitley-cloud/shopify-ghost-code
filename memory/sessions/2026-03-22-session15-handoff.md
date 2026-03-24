## Session Handoff: 2026-03-22 — Scanner Expansion + UI Overhaul + Testing

### What Got Done

- **3 new scanner finding types**: GHOST_HREFLANG (orphaned hreflang tags from translation apps), DUPLICATE_META (stacked SEO meta tags), GHOST_JSON_LD (orphaned JSON-LD schema from review/FAQ/SEO apps)
- **ORPHAN_ASSET filter**: Now requires app attribution — eliminates Dawn stock theme false positives (icon-cart.liquid, etc.)
- **App signature expansion**: 5 new translation app entries (Transcy, Langify, LangShop, Hextom Translate, Translate & Adapt), PageFly expanded, jsonLdPatterns added to 7 apps
- **Signature DB audit**: 51 apps, 100% have scriptPatterns, identified 7 strategy-named apps missing (most use modern clean-uninstall patterns)
- **Scan detail UI overhaul**: Summary tiles (Health Score, Total Findings, Severity Breakdown with diffs), severity-sorted table, NEW indicator badges, proper table styling, Export CSV button redesign
- **Dashboard tile height equalization**
- **Settings → Billing** rename (nav + page heading)
- **Permission Audit enabled** for all plans
- **View button fix** in scan history (layout route → index route)
- **Settings page spacing** (div wrapper for Shadow DOM margin)
- **Dev store upgraded** to Professional plan for unlimited test scanning
- **Synthetic test artifacts** injected into dev store theme (Klaviyo, Judge.me, Hotjar, Loox, hreflang, meta tags, JSON-LD)
- **Test count**: 657 → 715 (58 new tests across 8 finding types)
- **Beads**: GC-xn0 (JSON-LD) closed, GC-icb (metafields) created as P3 post-launch

### Key Decisions

- **Orphan filter requires app attribution**: Only surface ORPHAN_ASSET findings when appName is non-null. Eliminates false positives from stock theme snippets. Product promise is "find what apps left behind" — can't claim that without identifying the app.
- **JSON-LD detection via Liquid tag heuristic**: Skip `<script type="application/ld+json">` blocks containing `{{` or `{%` — native theme JSON-LD always uses Liquid variables. App-injected JSON-LD is static HTML. Clean separator.
- **Hreflang attribution priority ordering**: Domain-specific translation apps (Weglot, Transcy, Langify, etc.) checked before Translate & Adapt's catch-all locale subpath pattern.
- **Settings → Billing**: Page only has plan/subscription management, no actual settings to configure.
- **Permission Audit enabled for all plans**: Feature flag flipped from false to true across Free/Standard/Professional.

### Patterns & Discoveries

- **Modern Shopify apps leave no orphans**: Transcy, BOLD Discounts, bot-analytics-cleanup-app all use Theme App Extensions which Shopify auto-cleans on uninstall. Orphaned code problem skews toward older apps and direct theme file edits (PageFly).
- **PageFly leaves real artifacts**: Creates `layout/theme.pagefly.liquid` (full theme copy), `sections/pagefly-section.liquid`, `snippets/pagefly-main-js.liquid`. Good real-world test case.
- **Market research DB has no technical signals**: 5,799 apps but only metadata (pricing, reviews). No CDN domains, script URLs, or snippet names. Building signatures requires install/uninstall testing or storefront crawling.
- **Polaris Shadow DOM**: Never inline `style` on `<s-*>` tags — wrap in `<div>`. `<s-data-table>` blocks click events.
- **React Router v7 flat files**: `app.scans.tsx` is a layout route for `app.scans.$scanId.tsx`. Use `_index` suffix for sibling index routes.

### Uncommitted Changes

- `memory/` session files, `.beads/` metadata, `.claude/` config — non-code, local only
- `vite.config.ts`, `.eslintrc.cjs`, `.github/workflows/ci.yml` — these show as modified but are from earlier sessions (formatting diffs), not this session's work
- `memory/team/retro-history.md` — updated with session 15 retro entry

### Open Backlog (8 beads)

- **GC-ue5** (P1): Form legal entity (LLC) — user doing via Northwest Registered Agent
- **GC-mfj** (P1 epic): Deploy Ghost Code — 1 subtask remains (E2E test)
- **GC-ehc** (P2): Set up support email — blocks legal pages and app listing
- **GC-mfj.8** (P2): E2E test in dev store — checklist in docs/e2e-test-checklist.md
- **GC-qys** (P2): Better deploy error messages
- **GC-icb** (P3): Translation metafield detection via GraphQL API (post-launch)
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade

### Open Questions

- **Synthetic test data cleanup**: Dev store theme has injected orphaned code artifacts (Klaviyo, Judge.me, Hotjar, Loox, hreflang, meta tags, JSON-LD). Need to clean before app review submission. Options: (A) Pull original Dawn theme and re-push, (B) Manually remove injected blocks. Criteria: time — either works. Do before E2E test.
- **Support email (GC-ehc)**: Depends on LLC formation — want email under business domain. Options: (A) Custom domain (ghostcode.app), (B) Gmail, (C) Google Workspace (~$6/mo). Resolve after LLC.
- **App store listing copy**: Product strategy doc references hreflang/metafield pain points the scanner can now partially detect (hreflang yes, metafields no). Listing needs to accurately reflect v1 capabilities.

### Recommended Next Steps

1. **Form LLC** (GC-ue5) — unblocks entity name in legal docs and support email
2. **Clean synthetic test data** from dev store theme — restore clean Dawn theme
3. **E2E test in dev store** (GC-mfj.8) — walk through checklist with clean theme + real PageFly artifacts
4. **Set up support email** (GC-ehc) — once LLC/domain decided
5. **Update legal docs** with entity name
6. **Write app store listing** — match copy to actual scanner capabilities (8 finding types)
7. **Submit for Shopify app review**

### Risks & Warnings

- **Railway auto-deploys from main** — every push deploys. No staging.
- **Dev store theme has synthetic artifacts** — must clean before real E2E testing
- **Free plan scan limit**: Dev store still has Professional plan set via direct DB update (not via Shopify billing). Reset to Free before testing billing flows.
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet

### CI State

- All green: lint, format, typecheck, tests (715 passing)
- Pre-commit hook active (husky + lint-staged)

### Inngest State

- Inngest Cloud active, 4 functions synced (scan-theme, poll-theme-changes, weekly-scan-coordinator, daily-scan-coordinator)
- No changes this session
