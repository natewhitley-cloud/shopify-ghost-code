## Session Handoff: 2026-03-23 (session 19) — Permission Audit Removal

### What Got Done

1. **Diagnosed Permission Audit scope-request bug** — "Enable App Scanning" button silently failed because `read_apps` was never declared in `optional_scopes`. Fixed the immediate gate by removing the bogus scope check (commit `e1784ab`).
2. **Discovered `read_apps` is not a valid Shopify scope** — Shopify rejected it as both optional and required scope. Confirmed via official docs + community forums that `appInstallations` query is restricted to Shopify-internal apps only.
3. **Removed Permission Audit feature entirely** — Spec'd the removal (`/spec`), executed via `/sprint` with implementer + scaffolder agents. Deleted 17 files (9 source, 8 test), cleaned 10 cross-cutting references, dropped 3 Prisma models + 2 enums. -5,471 lines. Commit `a3dd824`.
4. **Created portfolio-level feasibility memory** — `feedback_scope_feasibility.md` in portfolio memory requires testing actual API queries in dev store before feature work. Third feature killed by API restrictions (Ember, Tax Integrity Monitor, Permission Audit).
5. **GC-iw0 closed.**

### Key Decisions

- **Remove rather than pivot Permission Audit**: Considered pivoting to `currentAppInstallation` (only returns Ghost Code's own scopes) but that's useless as a feature. Clean removal chosen to avoid dead code before app store submission.
- **Keep `read_translations` optional scope**: It serves the GHOST_TRANSLATION finding type, not Permission Audit. Comment in toml updated.
- **Portfolio-level memory, not Ghost Code-specific**: The scope feasibility lesson applies to all three apps, so memory was written at `~/.claude/projects/.../memory/` level.

### DB Migrations

- `20260323193334_remove_permission_audit` — drops InstalledApp, PermissionSnapshot, PermissionAuditRun tables + AppPresence, AuditRunStatus enums. Applied locally. Will auto-apply on Railway via `prisma migrate deploy`.

### Test Count

- 833 → 705 (-128 tests removed with feature)
- 35 test files, all passing
- Zero TypeScript errors

### Commits

| Hash | Description |
|------|-------------|
| `e1784ab` | fix(permissions): remove bogus read_apps scope gate blocking Permission Audit |
| `a3dd824` | refactor: remove Permission Audit feature |

### Uncommitted Files

- `memory/agents/implementer/learnings.md` — 1 new entry (grep inngest/ during removal)
- `memory/team/retro-history.md` — session 19 retro entry
- `.specs/remove-permission-audit.md` — spec doc (can commit or leave)
- `.claude/tackline/` session files — internal tracking

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

- **Railway migration pending** — `remove_permission_audit` migration will auto-run on next deploy (already pushed). Verify it applied cleanly via `railway logs`.
- **Dev store theme has synthetic artifacts** — must clean before real E2E or app review (carried from session 18)
- **Legal pages use placeholder email** — `support@ghostcode.app` doesn't exist yet
- **`read_translations` scope has no UI flow** — no merchant-facing optional scope grant for translation detection
- **Scanner now passes empty `installedAppNames` to translation detector** — all translations treated as potentially orphaned (no "skip if translation app installed" check). Functionally correct but less precise.
