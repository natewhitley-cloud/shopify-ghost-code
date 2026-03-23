## Session Handoff: 2026-03-22 — GDPR Fix, Inngest Live, UI Polish

### What Got Done

- **GDPR webhook routing fixed** — created catch-all `webhooks.tsx` route for compliance_topics; deleted 4 dead route files (3 per-topic GDPR + app/installed)
- **Inngest Cloud configured** — account created, keys deployed to Railway, sync verified. Keys rotated after accidental exposure in conversation.
- **First successful scan** — scan-theme function had 4MB step output limit error; fixed by combining fetch+scan+save into single step. Scan completed with 3 Low findings on test-data theme.
- **Health score formula replaced** — old normalized formula scored 0 for 3 Low findings. New simple deduction: `100 - (HIGH*10 + MED*5 + LOW*1)`. 3 Low = 97 Excellent.
- **Standard plan changed to weekly scans** — was unlimited, now 1/week manual. Professional keeps unlimited + automation. `scheduledScan: false` for Standard. Weekly gating uses Monday 00:00 UTC boundary.
- **Dashboard visual overhaul** — Theme Health tile (color-coded), Most Recent Findings tiles (High/Medium/Low stat cards), Scan Actions section with New Scan tile (usage bar) and Scan History tile (blue button)
- **Settings page redesigned** — 3-column plan tiles with borders, bold names, aligned dividers, Current Plan blue pill badge, removed redundant Your Plan Details section
- **Scan History table** — bordered cells, header background, alternating rows, View link uses React Router Link
- **Lint cleanup** — fixed 5 unused import/variable errors, ran prettier on all flagged files
- **About section** — added Permission Audit feature description
- **CI** — all tests passing (578), lint clean, format clean

### Key Decisions

- **Health score simple deduction** — no file count normalization; scores are intuitive and don't require schema changes
- **Standard plan weekly manual** — automation (scheduled scans, auto-rescan) reserved for Professional as upgrade driver
- **Railway CLI scope** — CLI was linked to bot-analytics, causing env vars to deploy to wrong project. Always run `railway status` first.
- **Inngest step consolidation** — fetch + scan + save combined into one step to avoid 4MB output limit. Tradeoff: less granular retries, but the alternative doesn't work.

### Uncommitted Changes

- Memory/session files (handoffs, scratch) — not code
- `.claude/tackline/`, `.cursor/`, `.gemini/`, `.mcp.json` — editor configs, untracked

### Open Backlog

- **GC-mfj.7** (P2): Privacy policy and terms of service — needed for app review
- **GC-mfj.8** (P2): End-to-end test in dev store — now unblocked (Inngest working)
- **GC-qys** (P2): Better error messages for deploy-time failures
- **GC-zse** (P2 epic): Permission Audit feature
- **GC-kis** (P3): Health score trend bar chart (3+ scans, paid plans)
- **GC-ngh** (P3): Upgrade Prisma 6.x → 7.x
- **GC-8la** (P3): Add prettier to pre-commit hook

### Dashboard UI State

The dashboard layout is nearly final. Remaining polish item from last feedback:

- Theme Health tile is slightly taller than Findings tiles (a few pixels). The `align-items: end` approach aligns bottoms but the heights aren't pixel-perfect. May need explicit matching height or a different grid approach.

### Inngest State

- Inngest Cloud account active, synced, keys rotated
- 4 functions registered: scanTheme, pollThemeChanges, pollCheckShop, weeklyScan
- Scan flow working end-to-end (confirmed with successful scan of test-data theme)
- Free plan limit reached (1/1 used this month) — next scan available next month or after upgrade

### Recommended Next Steps

1. **Privacy policy + ToS** (GC-mfj.7) — needed before Shopify app review
2. **E2E test checklist** (GC-mfj.8) — OAuth, scan, billing, webhooks, Permission Audit
3. **App review preparation** — combine privacy/ToS + GDPR verification + billing test
4. **Permission Audit feature** (GC-zse) — built but gated, needs activation plan

### Risks & Warnings

- **Railway deploys from main** — every push auto-deploys. No staging environment.
- **Inngest keys were exposed** — rotated and old keys revoked. New keys are secure.
- **Railway CLI scope** — verify `railway status` before any Railway command. CLI may be linked to wrong project.
- **Free plan scan limit** — dev store is on free plan with 1/1 scans used. Can't test scanning again until next month unless plan is upgraded or scan record is manually reset.
