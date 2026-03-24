## Session Handoff: 2026-03-23 (session 19) — Permission Audit Removal + Feedback Loop + Scanner Expansion Planning

### What Got Done

1. **Diagnosed & removed Permission Audit** — `appInstallations` query restricted to Shopify-internal apps. Removed 17 files, 3 Prisma models, -5,471 lines. Commits `e1784ab`, `a3dd824`.
2. **Shipped feedback loop curation pipeline** — SubmissionStatus enum, 4 model queries, CLI review script (`scripts/review-submissions.ts`), 20 tests. Commit `cca08a8`. All v1.1 roadmap items now shipped.
3. **Killed orphaned webhook detection** — Same Shopify app isolation blocker. webhookSubscriptions only returns your own app's webhooks.
4. **Opportunity scan** — Mined all existing research (community forums, Reddit, reviews). Found 9 new audit/detection features ranked by evidence × feasibility × relevance.
5. **Feasibility check on 3 scopes** — `read_products` confirmed, `read_content` confirmed (redirects need `read_online_store_navigation`), `read_metafields` doesn't exist (use parent scopes, app-owned metafields invisible).
6. **9 new backlog items created** with feasibility annotations.

### Key Decisions

- **Remove Permission Audit, not pivot**: `currentAppInstallation` only shows Ghost Code itself — useless.
- **CLI-only curation for feedback loop**: No admin UI at current scale.
- **Webhook detection killed**: Same isolation pattern as Permission Audit.
- **No-scope items sprint-ready**: Items 4/7/8/9 extend existing scanner with zero new scopes.

### DB Migrations (pending on Railway)

- `20260323193334_remove_permission_audit` — drops 3 tables + 2 enums
- `20260323224453_add_submission_status` — adds SubmissionStatus enum + fields

### Test Count

- 725 tests, 36 test files, all passing
- Zero TypeScript errors

### Commits

| Hash | Description |
|------|-------------|
| `e1784ab` | fix(permissions): remove bogus read_apps scope gate |
| `a3dd824` | refactor: remove Permission Audit feature |
| `a186177` | docs: session 19 retro, handoff, and spec |
| `cca08a8` | feat(scanner): add submission curation pipeline |
| `69d6647` | docs: update handoff + product strategy |
| `8953112` | fix: resolve CI lint errors |

### Open Backlog (17 beads)

**Pre-launch (P1-P2):**
- GC-ue5 (P1): Form legal entity (LLC)
- GC-mfj (P1 epic): Deploy — 1 subtask (E2E test)
- GC-ehc (P2): Set up support email
- GC-mfj.8 (P2): E2E test in dev store
- GC-qys (P2): Better deploy error messages

**Scanner expansion — no new scopes (sprint-ready):**
- GC-25n (P3): Settings data drift (stale section refs in settings_data.json)
- GC-lxk (P3): Inline tracking pixel detection (fbq, gtag, _taq)
- GC-azd (P3): JSON-LD conflict detection (same @type, different data)
- GC-6m7 (P3): Page builder layout duplication (theme.pagefly.liquid)

**Scanner expansion — new standard scopes (feasibility confirmed):**
- GC-m5g (P3): Orphaned product tags (`read_products` — confirmed)
- GC-rg6 (P3): Persistent discount prices (`read_products` — confirmed)
- GC-o5r (P3): Orphaned pages (`read_content` — confirmed)
- GC-bed (P3): Orphaned metafields (`read_products` — partial, app-owned invisible)
- GC-ve8 (P3): SEO directive ghosts (`read_online_store_navigation` for redirects)

**Other P3:**
- GC-nmc: Theme picker
- GC-kis: Health score trend chart
- GC-ngh: Prisma 6→7 upgrade

### Recommended Next Steps

1. **Sprint on no-scope scanner items** (GC-25n, GC-lxk, GC-azd, GC-6m7) — 4 low-effort detectors, no new scopes
2. **Add eslint to pre-commit hook** — third consecutive session with post-push CI lint failures from agent code
3. **Form LLC** (GC-ue5) → support email → clean dev store → E2E test → submit
4. **Scope-dependent items** can be batched in a future sprint after deciding which scopes to add to shopify.app.toml

### Risks & Warnings

- **Two Railway migrations pending** — verify via `railway logs` after deploy
- **Dev store theme has synthetic artifacts** — clean before E2E or app review
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist
- **Subagent lint blind spot** — agents don't run eslint, only prettier pre-commit. CI catches it post-push. Fix: add eslint to lint-staged config.
- **Product strategy doc partially stale** — v1.2 section has shipped/killed items mixed with open ones. Consider reorganizing into "shipped" vs "planned" vs "not feasible" sections.
