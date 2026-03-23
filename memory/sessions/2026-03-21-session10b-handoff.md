## Session Handoff: 2026-03-21 — Railway Deployment Setup (Session 10b)

### What Got Done

- Railway project created with PostgreSQL addon (GC-mfj.2 closed)
- App service deployed from GitHub repo, domain: shopify-ghost-code-production.up.railway.app
- All core env vars set on Railway (GC-mfj.3 closed)
- TOKEN_ENCRYPTION_KEY generated and stored in local .env + Railway
- shopify.app.toml updated with Railway domain (application_url + redirect_urls), committed and pushed

### What's Left (Deployment Epic GC-mfj)

**Still open:**

- **GC-mfj.4** (P1): Set GitHub secrets (RAILWAY_TOKEN, RAILWAY_SERVICE_ID) for CI/CD auto-deploy
- **GC-mfj.5** (P1): Run `shopify app deploy` to push the updated TOML config to Shopify — do this from terminal: `cd ghost-code-app && shopify app deploy`
- **GC-mfj.6** (P2): Create Inngest Cloud account, get INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY, add to Railway env vars
- **GC-mfj.7** (P2): Create privacy policy + terms of service pages (needed before Shopify app review)
- **GC-mfj.8** (P2): End-to-end test in dev store

### Immediate Next Steps

1. Run `shopify app deploy` from terminal to push TOML config to Shopify
2. Check if Railway build succeeded — if it's healthy at /health endpoint
3. Set GitHub secrets for CI/CD (GC-mfj.4)
4. Try installing the app on your dev store to test OAuth flow

### Risks

- First deploy may fail if DATABASE_URL isn't correctly referencing the Railway Postgres addon — check Railway logs
- `shopify app deploy` must be run before the app can authenticate merchants (redirect_urls need to match)
- Inngest not configured yet — background scanning jobs won't fire (manual scans from dashboard still work)
- MARKET_RESEARCH_DB_PATH not set on Railway — Permission Audit enrichment returns null (scoring still works)
