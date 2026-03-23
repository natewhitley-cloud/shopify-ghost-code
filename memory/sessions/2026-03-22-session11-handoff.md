## Session Handoff: 2026-03-22 — First Production Deploy

### What Got Done

- **`shopify app deploy` succeeded** — fixed 3 TOML validation errors: removed invalid `app/installed` topic, fixed `app_subscriptions/update` format, moved GDPR webhooks to `compliance_topics`, removed nonexistent `read_apps` scope
- **Build error fixed** — extracted `PLANS` constant from `billing.server.ts` to shared `app/lib/plans.ts` so client code can import it; fixed `getPlanFeatures` ReferenceError by importing PLANS into local scope (not just re-exporting)
- **Railway deploy working** — fixed DATABASE_URL (was localhost, needed Railway Postgres internal URL), added PORT=3000 env var
- **OAuth flow working** — app installs and authenticates on dev store `nw-dev-store-2.myshopify.com`
- **Shop record creation fixed** — `app/installed` is not a valid webhook topic, so shop records were never created; added upsert to `app.tsx` layout loader on first authenticated visit
- **CI/CD wired up** — GitHub secrets `RAILWAY_TOKEN` and `RAILWAY_SERVICE_ID` set; pushes to main auto-deploy
- **Inngest graceful fallback** — wrapped `inngest.send()` in try/catch so scans can be created without Inngest Cloud configured
- **Railway CLI linked** — `railway logs` now available for direct log access
- **Backlog item created** — GC-qys (P2): better error messages for deploy-time failures

### Key Decisions

- **`read_apps` is not a valid Shopify scope** — removed from optional_scopes entirely. `appInstallation` queries work without any special scope. (Previously documented as "standard scope" in memory — corrected)
- **`app/installed` is not a valid webhook topic** — removed from TOML. Shop record creation moved to layout loader as fallback. The `webhooks.app.installed.tsx` route file still exists but won't receive webhooks.
- **GDPR webhooks use `compliance_topics`** — single subscription block with `compliance_topics` array pointing to `/webhooks` URI. Per-topic route files (`webhooks.customers.redact.tsx` etc.) may need a catch-all route at `/webhooks` to actually handle these — not yet tested.
- **PLANS extracted to shared module** — `app/lib/plans.ts` is client-safe; `billing.server.ts` imports and re-exports for backward compatibility

### Patterns & Discoveries

- **React Router v7 server code splitting** — importing a `.server` module in component code (not just loader/action) causes a build error. The fix is to extract shared constants to non-`.server` files.
- **`export { X } from` does NOT import into local scope** — re-exporting doesn't make the symbol available to functions in the same file. Must use `import { X } from; export { X };` pattern.
- **Railway auto-deploy from GitHub** — Railway detects pushes to main and builds automatically (no GitHub Actions needed for deploy). The GitHub Actions workflow exists but CI/CD also happens natively via Railway's GitHub integration.

### In-Progress Work

- **Scan flow** — scan record creation works, redirects to `/app/scans/:scanId`, but scan stays in PENDING because Inngest is not configured. Next step: set up Inngest Cloud (GC-mfj.6)
- **GDPR compliance webhook routing** — compliance_topics point to `/webhooks` but no catch-all route exists at that path. The per-topic route files exist but may not receive compliance webhooks. Needs testing.

### Uncommitted Changes

- `memory/scratch/sprint-checkpoint.md` — modified (stale from session 10)
- Several untracked files in `.claude/tackline/`, `.cursor/`, `.gemini/`, `memory/sessions/` — session artifacts, not code

### Blocked Work

- **GC-mfj.8** (E2E test in dev store): blocked on GC-mfj.5 — but GC-mfj.5 is now closed, so this should be unblocked. Need to update dependency.

### Open Questions

- **`webhooks.app.installed.tsx`**: Route file exists but `app/installed` is not a valid Shopify webhook topic. Options: (A) Delete the file since it will never receive webhooks, (B) Keep as dead code for now. Criteria: whether any install-time logic should move elsewhere. The auto-scan-on-install logic in that file is now orphaned.
- **GDPR compliance webhook routing at `/webhooks`**: The `compliance_topics` in TOML point to `/webhooks` but no catch-all route exists. Options: (A) Create a `webhooks.tsx` route that dispatches by topic header, (B) Test if Shopify's framework handles this automatically. Criteria: whether GDPR webhooks actually fire during app review. Ask: test by triggering a GDPR data request from Partner Dashboard.
- **Inngest Cloud vs alternatives**: GC-mfj.6 requires creating an Inngest Cloud account. Options: (A) Set up Inngest Cloud (free tier), (B) Run scanning synchronously in the action handler for MVP. Criteria: scan duration — if theme scanning takes >30s, synchronous won't work. Recommendation: Inngest Cloud (already wired up, just needs keys).

### Recommended Next Steps

1. **Set up Inngest Cloud** (GC-mfj.6) — create account at inngest.com, get EVENT_KEY + SIGNING_KEY, add to Railway env vars. This unblocks the scan flow.
2. **Test scan flow end-to-end** — after Inngest is configured, click "Start Scan" on dev store, verify it processes and shows results
3. **Unblock GC-mfj.8** — update dependency now that GC-mfj.5 is closed, then run full E2E test checklist (OAuth, scan, billing, webhooks, Permission Audit)
4. **Create GDPR catch-all route** — `/webhooks` route to handle compliance_topics, or test if framework handles it
5. **Privacy policy + ToS** (GC-mfj.7) — needed before Shopify app review

### Risks & Warnings

- **GDPR webhooks may not be routed correctly** — compliance_topics point to `/webhooks` but no route handles that path. This will block app review if not fixed.
- **`webhooks.app.installed.tsx` is dead code** — the auto-scan-on-install logic there will never fire. Shop creation is handled, but first-install auto-scan is not.
- **Scan stays PENDING without Inngest** — merchants see a scan created but no results. Need Inngest Cloud or a synchronous fallback before any real user testing.
- **Railway deploys from main** — every push deploys. No staging environment exists. Be careful with breaking changes.
