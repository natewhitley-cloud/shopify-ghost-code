## Session Handoff: 2026-03-22 — CI Cleanup, Legal Pages, Full Codebase Review & Fix

### What Got Done

- **CI fully green** — Fixed 10 type errors (Polaris `s-card` types, `gap="loose"`, `s-text variant`), 12 import ordering warnings, 10 test mock type errors (Inngest `.fn` private access, PrismaClient casts), and 1 prettier formatting issue. Upgraded GitHub Actions from v4 to v5.
- **E2E test checklist** — Written to `docs/e2e-test-checklist.md` covering install/auth, scanning, billing, webhooks, plan gating, error handling, re-install.
- **Privacy policy + ToS** — Created public GitHub Pages site (`data-integrity-suite` repo) with Ghost Code privacy policy and terms of service. Live at `natewhitley-cloud.github.io/data-integrity-suite/ghost-code/`. GC-mfj.7 closed.
- **Full codebase review** — 30 findings (5 P1, 16 P2, 9 P3) across bugs, logic gaps, test gaps, logging, and accessibility.
- **All 30 findings fixed** — 5 P1 bugs (timezone, token storage, retry race, webhook validation, quota TOCTOU), navigation fixes (plain `<a>` → React Router `<Link>`), structured logging (scan lifecycle, GDPR deletes, Inngest dispatch failures, scope changes), accessibility (ARIA live region, table headers), DRY refactoring (shared `getScanUsage`), and 79 new tests.
- **Test count**: 578 → 657 (39 test files)
- **Beads**: 28 created, 28 closed this session. Total: 66 beads, 58 closed, 8 open.

### Key Decisions

- **GitHub Pages for legal docs** — Separate public repo (`data-integrity-suite`) keeps app code private. Portfolio-level structure with per-app paths (`/ghost-code/privacy.html`). Rejected: hosting on app routes (behind auth, not publicly accessible), external legal doc services (unnecessary dependency).
- **Polaris `s-card` type declaration** — Created `app/types/polaris-custom.d.ts` rather than replacing `s-card` everywhere. `s-card` works at runtime via CDN even though `@shopify/polaris-types` v1.0.1 doesn't include it.
- **Atomic quota enforcement** — Moved scan quota checking into `createScan`'s Prisma transaction (F-05) so rate limiting is authoritative, not advisory. `canStartScan` still exists for UI gating.
- **`getScanUsage` extracted** — Dashboard and plan-gating now share one function for scan usage calculation, eliminating drift risk.
- **Definition-of-done corrected** — Privacy/ToS URLs go in Partner Dashboard, not shopify.app.toml.

### Patterns & Discoveries

- **Polaris Web Components types are Preact-oriented** — `@shopify/polaris-types` registers components in Preact's JSX namespace, not React's. Custom `.d.ts` needed for any components missing from the package.
- **Inngest `InngestFunction.fn` is private** — Tests need `getInngestHandler()` helper (in `tests/mocks/inngest.ts`) to cast through `unknown`.
- **`s-link` may not handle embedded navigation correctly** — Standardized all internal nav to React Router `<Link>` to be safe.

### Uncommitted Changes

- `memory/` session files and scratch notes — not code, local only
- `.claude/tackline/` — editor config, untracked

### Open Backlog (8 beads)

- **GC-mfj** (P1 epic): Deploy Ghost Code — 2 subtasks remain (E2E test + support email)
- **GC-ehc** (P2): Set up support email — needed for legal pages and app listing
- **GC-qys** (P2): Better deploy error messages
- **GC-mfj.8** (P2): E2E test in dev store — unblocked, checklist in `docs/e2e-test-checklist.md`
- **GC-zse** (P2 epic): Permission Audit feature
- **GC-8la** (P3): Prettier pre-commit hook
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade

### Open Questions

- **Support email (GC-ehc)**: Need a real email for legal pages and app listing. Options: (A) Custom domain email (ghostcode.app — requires domain purchase + email hosting), (B) Gmail (free, less professional), (C) Support platform like HelpScout (overkill for launch). Criteria: cost, professionalism, app review requirements. Current placeholder: `support@ghostcode.app`.
- **ToS governing law**: Set to Texas/Travis County as placeholder. User should review and confirm jurisdiction.
- **Free plan scan limit**: Dev store hit 1/1 scan limit. E2E testing requires either manual DB reset or upgrading the dev store plan.

### Recommended Next Steps

1. **Support email** (GC-ehc) — Decide on email provider, update legal pages with real address. Blocks app review submission.
2. **E2E test in dev store** (GC-mfj.8) — Walk through `docs/e2e-test-checklist.md`. Reset scan limit first (`railway run npx prisma studio` or upgrade plan).
3. **Add legal page URLs to Partner Dashboard** — Go to app listing > Resources > Privacy Policy URL field.
4. **App review submission** — After email + E2E + Partner Dashboard URLs are set.

### Risks & Warnings

- **Railway auto-deploys from main** — every push deploys. No staging. All code pushed this session is now live.
- **Free plan scan limit** — Dev store has 1/1 used. Can't test scanning without reset.
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet.
- **Railway CLI scope** — Always run `railway status` before commands. CLI may be linked to wrong project.

### Inngest State

- Inngest Cloud active, 4 functions synced
- Keys rotated (previous session), current keys secure
- scan-theme now has structured lifecycle logging

### CI State

- All green: lint ✓, format ✓, typecheck ✓, tests ✓ (657 passing)
- GitHub Actions upgraded to v5 (Node.js 22)
