## Session Handoff: 2026-03-21 — Security Review + Deployment Prep (Session 10)

### What Got Done
- Closed GC-zse.19 (cache scopes in DB) and GC-zse.20 (consolidate write paths) — Permission Audit epic fully closed
- Full security/correctness review: 48 files, 9 findings (0 critical, 7 warning, 6 suggestion, 2 nitpick)
- Fixed all P1-P3 findings: token encryption, webhook hardening, GDPR explicit deletes, JSON.parse guards, loader parallelization, staleness caching, health endpoint cleanup
- Created deployment epic (GC-mfj) with 8 tasks, dependency-wired
- Created initial Prisma migration (no local DB needed — used prisma migrate diff)
- 577 tests, all passing

### Key Decisions
- **Token encryption is opt-in via env var**: TOKEN_ENCRYPTION_KEY enables AES-256-GCM. Without it, encryption is a no-op. This allows local dev without encryption while enforcing it in production. Handles migration from plaintext transparently.
- **5-minute staleness threshold for permissions sync**: Avoids Shopify API call on every page navigation. Fresh enough for the use case (merchants aren't installing apps every minute).
- **Health endpoint stripped of version info**: Removed git SHA exposure. Railway health check only needs status: "ok".

### In-Progress Work
None — all code tasks completed and committed.

### Uncommitted Changes
None — everything pushed to origin.

### Deployment Epic (GC-mfj) — Nathan's Manual Tasks

**Wave 1 (parallel, no code deps):**
- **GC-mfj.2**: Set up Railway project with PostgreSQL — railway.app dashboard
- **GC-mfj.6**: Create Inngest Cloud account — inngest.com, get EVENT_KEY + SIGNING_KEY

**Wave 2 (after Railway project exists):**
- **GC-mfj.3**: Configure Railway environment variables:
  - `DATABASE_URL` — from Railway PostgreSQL addon
  - `SHOPIFY_API_KEY` — from Partner Dashboard
  - `SHOPIFY_API_SECRET` — from Partner Dashboard
  - `SHOPIFY_APP_URL` — Railway deployment URL
  - `TOKEN_ENCRYPTION_KEY` — generate with `openssl rand -hex 32`
  - `INNGEST_EVENT_KEY` — from Inngest Cloud
  - `INNGEST_SIGNING_KEY` — from Inngest Cloud
  - `NODE_ENV=production`
- **GC-mfj.4**: Set GitHub secrets: `RAILWAY_TOKEN`, `RAILWAY_SERVICE_ID`
- **GC-mfj.5**: Update shopify.app.toml URLs with Railway domain, run `shopify app deploy`

**Wave 3 (after deploy):**
- **GC-mfj.8**: End-to-end test in dev store (OAuth, scan, billing, webhooks, Permission Audit)

**Not blocking deploy:**
- **GC-mfj.7**: Privacy policy + terms pages (needed before Shopify app review, not before deploy)

### Open Questions
- **Inngest deployment model**: Inngest Cloud vs. self-hosted? Cloud is simpler (just API keys), self-hosted gives more control. Recommend Cloud for now — can migrate later.
- **MARKET_RESEARCH_DB_PATH on Railway**: The enrichment SQLite DB is local. Options: (A) skip enrichment in production (degrades gracefully), (B) bundle DB into Docker image, (C) migrate to PostgreSQL. Recommend A for initial deploy.

### Recommended Next Steps
1. Create Railway project + PostgreSQL addon
2. Generate TOKEN_ENCRYPTION_KEY: `openssl rand -hex 32`
3. Set all env vars on Railway
4. Set GitHub secrets
5. Push triggers auto-deploy via GitHub Actions
6. Copy Railway domain → update shopify.app.toml → `shopify app deploy`
7. Test in dev store

### Risks & Warnings
- TOKEN_ENCRYPTION_KEY must be set in production — without it, access tokens store in plaintext (functional but insecure)
- Prisma migration has not been tested against real PostgreSQL — only generated via diff. First deploy will be the real test.
- MARKET_RESEARCH_DB_PATH won't be available on Railway — Permission Audit enrichment (category, rating data) will return null. Scoring still works, just without category context.
