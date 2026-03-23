## Session Handoff: 2026-03-23 (session 19) — Permission Audit Removal + Feedback Loop

### What Got Done

1. **Diagnosed Permission Audit scope-request bug** — "Enable App Scanning" button silently failed because `read_apps` was never declared in `optional_scopes`. Fixed the immediate gate by removing the bogus scope check (commit `e1784ab`).
2. **Discovered `read_apps` is not a valid Shopify scope** — Shopify rejected it as both optional and required scope. Confirmed via official docs + community forums that `appInstallations` query is restricted to Shopify-internal apps only.
3. **Removed Permission Audit feature entirely** — Spec'd the removal (`/spec`), executed via `/sprint` with implementer + scaffolder agents. Deleted 17 files (9 source, 8 test), cleaned 10 cross-cutting references, dropped 3 Prisma models + 2 enums. -5,471 lines. Commit `a3dd824`.
4. **Built Unknown Finding Feedback Loop curation pipeline** — SubmissionStatus enum, 4 model aggregation queries, CLI review script (`scripts/review-submissions.ts`), 20 new tests. Commit `cca08a8`.
5. **Updated product strategy doc** — Marked all shipped v1.1 and v1.2 items (Attribution Map, Privacy Callout, Performance Score, Feedback Loop, GHOST_TEXT, GHOST_TRANSLATION, signature expansion).
6. **Created portfolio-level feasibility memory** — `feedback_scope_feasibility.md` requires testing actual API queries in dev store before feature work.
7. **GC-iw0 closed, GC-e8u closed.**

### Key Decisions

- **Remove rather than pivot Permission Audit**: `currentAppInstallation` only returns Ghost Code's own scopes — useless as a feature. Clean removal chosen.
- **Keep `read_translations` optional scope**: It serves GHOST_TRANSLATION, not Permission Audit.
- **CLI-only curation for feedback loop**: No admin UI — `npx tsx scripts/review-submissions.ts` is sufficient at current scale.

### DB Migrations

- `20260323193334_remove_permission_audit` — drops InstalledApp, PermissionSnapshot, PermissionAuditRun + enums
- `20260323224453_add_submission_status` — adds SubmissionStatus enum, status/reviewedAt fields to SignatureSubmission
- Both will auto-apply on Railway via `prisma migrate deploy`

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

### Open Backlog (8 beads)

- **GC-ue5** (P1): Form legal entity (LLC)
- **GC-mfj** (P1 epic): Deploy Ghost Code — 1 subtask remains (E2E test)
- **GC-ehc** (P2): Set up support email
- **GC-mfj.8** (P2): E2E test in dev store
- **GC-qys** (P2): Better deploy error messages
- **GC-nmc** (P3): Theme picker — scan unpublished themes
- **GC-kis** (P3): Health score trend chart
- **GC-ngh** (P3): Prisma 6→7 upgrade

### Recommended Next Steps

1. **Form LLC** (GC-ue5) — unblocks entity name in legal docs and support email
2. **Set up support email** (GC-ehc) → update legal docs with real email
3. **Clean dev store theme** — remove synthetic test artifacts from session 18
4. **E2E test** (GC-mfj.8) — run through full checklist with clean theme
5. **App store listing → submit**

### Risks & Warnings

- **Two Railway migrations pending** — `remove_permission_audit` + `add_submission_status` will auto-run on next deploy. Verify via `railway logs`.
- **Dev store theme has synthetic artifacts** — must clean before real E2E or app review
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet
- **`read_translations` scope has no UI flow** — no merchant-facing optional scope grant
- **All v1.1 items shipped** — product strategy roadmap needs a v1.3 or post-launch section if new features are planned
