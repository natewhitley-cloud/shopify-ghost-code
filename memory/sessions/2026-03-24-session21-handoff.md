## Session Handoff: 2026-03-24 (session 21) — File cleanup + v1.4 GHOST_FONT/GHOST_AJAX

### What Got Done

1. **Committed 5 sessions of accumulated uncommitted files** — 3 commits covering product strategy doc, session 15-20 handoffs/retros, specs, and scripts.
2. **Implemented GHOST_FONT detector** (MEDIUM severity) — detects orphaned `@font-face` declarations and font service `<link>` tags attributable to known apps.
3. **Implemented GHOST_AJAX detector** (HIGH severity) — detects orphaned `fetch()`, `$.ajax()`, `$.get()`, `$.post()`, `XMLHttpRequest.open()` calls to defunct app server domains.
4. **Spec written** at `docs/specs/v1.4-font-ajax-spec.md`.
5. **Prisma migration created** (--create-only): `20260324123631_add_font_ajax_finding_types`.
6. **Retro run** — updated scanner capabilities memory (was badly stale), added retro history entry.

### Key Decisions

- **v1.4 performance tier is now complete**: GHOST_PRECONNECT (session 20) + GHOST_FONT + GHOST_AJAX (this session) covers all planned v1.4 items.
- **GHOST_AJAX set to HIGH severity**: Privacy concern (data leaking to defunct endpoints) elevates this above MEDIUM. Wasted network requests alone would be MEDIUM, but the privacy angle tips it.

### DB Migrations (pending on Railway)

Two migrations may be pending:
1. `20260324040259_add_seo_performance_finding_types` (from session 20)
2. `20260324123631_add_font_ajax_finding_types` (this session)

User ran `railway logs` during session — Inngest polls running fine, deploys healthy. Migration status needs explicit verification via `railway run npx prisma migrate status`.

### Test Count

- 1026 tests, all passing
- Zero TypeScript errors

### Commits

| Hash      | Description                                                            |
| --------- | ---------------------------------------------------------------------- |
| `c35361e` | docs: update product strategy with shipped/killed status               |
| `c2cc4e2` | docs: add session 15-20 handoffs and retros                            |
| `d940ef9` | chore: update specs, submission curation script, and scratch checkpoint |
| `dd973f8` | feat(scanner): add GHOST_FONT and GHOST_AJAX detectors (v1.4)         |
| `1c33d78` | docs: add session 21 retro entry                                       |

### Uncommitted Changes

None — working tree clean after all commits.

### Open Backlog

**Pre-launch (P1-P2):**

- GC-ue5 (P1): Form legal entity (LLC)
- GC-mfj (P1 epic): Deploy — 1 subtask (E2E test)
- GC-ehc (P2): Set up support email
- GC-mfj.8 (P2): E2E test in dev store
- GC-qys (P2): Better deploy error messages

**P3 (post-launch):**

- GC-nmc: Theme picker
- GC-kis: Health score trend chart
- GC-ngh: Prisma 6→7 upgrade

### Recommended Next Steps

1. **Verify Railway migrations** — `railway run npx prisma migrate status` to confirm both pending migrations applied. If not, run `railway run npx prisma migrate deploy`.
2. **Form LLC** (GC-ue5) → update legal docs with entity name → set up support email (GC-ehc) → update legal pages with real email.
3. **E2E test in dev store** (GC-mfj.8) — clean synthetic artifacts from dev store theme first, then run a full scan and verify all 22 finding types work end-to-end.
4. **Submit for app review** — once LLC, support email, legal docs, and E2E test are complete.
5. **Update product strategy doc** — mark v1.4 as shipped, reorganize into shipped/planned/killed.

### Risks & Warnings

- **Two Railway migrations pending** — code deployed but enum values may not be in DB yet. New finding types will fail to persist until migrations run.
- **Dev store theme has synthetic artifacts** — clean before E2E or app review.
- **Legal pages still use placeholder email** — `support@ghostcode.app` doesn't exist yet.
- **Scanner now at 22 finding types** — product strategy doc and app store listing copy need updating to reflect full capability.
