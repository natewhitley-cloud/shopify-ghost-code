## Session Handoff: 2026-03-21 — Permission Audit Feature (Session 9)

### What Got Done
- Full /blossom exploration: 5 spikes (Shopify API, market-research DB, architecture, read_apps alternatives, deeper read_apps process)
- Implemented complete Permission Audit feature: 18 tasks closed, 6,200+ lines, 99 new tests (572 total)
- /review caught 3 issues (overly broad error matching, missing scope check, DRY violation with inconsistent mapping) — all fixed
- Key files created: permission-fetcher, permission-scorer, app-enrichment, category-permissions mapping, installed-app model, two routes, risk-display shared helpers
- Feature committed in 2 commits: `a11bafa` (feat) + `18d8315` (fix)

### Key Decisions
- **read_apps as optional scope (not required)**: Request via App Bridge modal when merchant activates the feature, not at install time. Avoids confusing merchants with an unexplained permission prompt. (Rejected: required scope at install — too surprising for a feature they haven't seen yet)
- **No webhooks for tracking other apps**: Shopify only fires app/installed and app/uninstalled for YOUR OWN app. InstalledApp model populated entirely via permission-fetcher sync on page load. (Rejected: webhook-based inventory — webhooks don't exist for this use case)
- **Feature gated via code flag, not billing**: `permissionAuditEnabled: false` for all plans. Nathan toggles manually. Later wired to billing. (Rejected: environment variable — too easy to accidentally enable in production)
- **firstSeenAt/lastSeenAt instead of install date**: Shopify doesn't expose install date. We track when Ghost Code first discovers each app. UX says "First seen" never "Installed on." (Rejected: claiming install date — dishonest)
- **Scoring uses scope sensitivity + category mismatch only**: No activity signals (unmeasurable). Score 0-100 with log-dampened sensitivity weights and category mismatch penalty. (Rejected: using subscription status as activity proxy in scoring — too noisy)

### Patterns & Discoveries
- `read_apps` is NOT a restricted scope despite community forum posts claiming otherwise. It's a standard scope declared in TOML. Official Shopify help docs are authoritative; community posts are often years stale.
- Shopify AppInstallation object is sparse: no install date, no last API call, no active/inactive status. Design around what IS available.
- Market-research DB (5,247 apps, 100 categories) useful for enrichment but has NO permission data — category taxonomy is the valuable part for permission baselines.

### In-Progress Work
None — all tasks completed and committed.

### Uncommitted Changes
- `memory/scratch/sprint-checkpoint.md` — stale file from a different project, can be ignored
- Branch is 2 commits ahead of origin (not pushed)

### Open Tasks (from retro)
- **GC-zse.19** (P2): Cache app scopes in InstalledApp model to avoid re-fetching all apps on detail route page load. Touches: prisma/schema.prisma (add grantedScopes field), permission-fetcher.server.ts (store during sync), app.permissions.$appId.tsx (read from DB instead of API).
- **GC-zse.20** (P3): Consolidate InstalledApp write paths. syncInstalledApps does its own Prisma upserts; should delegate to installed-app.server.ts model functions.

### Open Questions
- **App Bridge scopes API (`app/routes/app.permissions.tsx:228`)**: Does `shopify.scopes.request()` work reliably across all embedded app contexts? Needs testing in a real dev store with the App Bridge CDN. Criteria: if it fails, fall back to the OAuth redirect URL pattern documented in Shopify help. Ask: test in dev store.
- **Scoring calibration (`app/services/permission-scorer.server.ts`)**: MAX_RAW_SCORE=25 was chosen to make realistic worst cases reach 100. May need tuning after seeing real merchant data. Criteria: run against 10+ real stores and check score distribution. Ask: defer until feature is live.

### Recommended Next Steps
1. **Push to origin** — 2 commits ready, `git push`
2. **Test in dev store** — `shopify app dev`, activate feature flag, verify App Bridge scope request flow works end-to-end
3. **GC-zse.19** — Cache scopes to fix the performance issue before any merchant traffic
4. **Create Prisma migration** — `npx prisma migrate dev` when DATABASE_URL is configured (migration was skipped this session because no local DB was running)

### Risks & Warnings
- Prisma migration not yet created — schema changes exist but `prisma migrate dev` was skipped (no DATABASE_URL). Must run before deploying.
- 2 commits not pushed to origin yet
- Feature is OFF by default (`permissionAuditEnabled: false`) — safe to deploy without exposing unfinished UX
