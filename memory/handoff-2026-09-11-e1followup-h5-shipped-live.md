# Session Handoff: 2026-09-11 — Ghost Code E1-followup (gc-7h9) + H5 (gc-1wf)

## Shipped + LIVE

Pushed `8dadfa6` (3 commits) to prod, Railway auto-deploy green, post-deploy smoke gate passed, `/health` ok. **No DB migration** in this batch (pure app-code + tests, 10 files).

Commits:

- `25078b1` feat(ui): gc-7h9 — Admin-resource deep-links (`buildAdminResourceUrl`)
- `52e6814` feat(auth): gc-1wf (H5) — permissions card + scope-skip banner
- `8dadfa6` fix(ui): polish + adversarial-audit fixes (friendly labels, honest banner, unavailable badges)

Both beads CLOSED (gc-7h9, gc-1wf).

## What got built

- **gc-7h9** — `app/lib/admin-resource-url.ts` (pure, client-safe, mirrors `theme-editor-url.ts`): `buildAdminResourceUrl`, `numericIdFromGidLocator`, `adminResourceLinkLabel`, `adminResourceLocatorLabel`. Wired into `FindingRow` in `app.scans.$scanId.tsx` (gated by new `isAdminResourceFinding` in finding-classification.ts). Theme vs admin-resource types partition the enum, so one link per row. File-column now shows a human label for admin-resource rows (was raw `products/gid://...`).
  - URL targets (owner chose "best available surface"): products → `{admin}/products/{numericId}`; GHOST_PAGE → storefront `https://{shop}/pages/{handle}` (locator has handle only, no id); GHOST_METAFIELD → product page (no dedicated metafields URL); GHOST_REDIRECT single+bulk → `{admin}/content/redirects`; GHOST_TRANSLATION → `{admin}/settings/languages`.
- **gc-1wf (H5)** — `app/lib/optional-scopes.ts` (single source of truth: OPTIONAL_SCOPES mirror toml, scope→label + category→scope maps, `missingOptionalScopes`, `scanSkippedForScopes`). Permissions card in `app.settings.tsx` (Standard+ only): on mount calls App Bridge `shopify.scopes.query()`, shows granted/missing, "Grant access" calls `shopify.scopes.request([...missing])` then re-queries. Scope-skip banner on scan-detail (PARTIAL or skippedCategories>0), links to /app/settings. Degrades gracefully if `shopify.scopes` undefined; SSR never touches the global.

## Adversarial audit (code-reviewer) — run pre-deploy, all addressed

- CONFIRMED data-honesty: banner said present-tense "does not have permission" on stale scan-time data → FIXED to past-tense scan-scoped copy ("This scan skipped N checks because Ghost Code didn't have the required permissions when it ran... Grant access, then run a new scan").
- Suggestion: query-failure showed false "Not granted" badges → FIXED to "Status unavailable" (extracted testable `scopeBadge`).
- WARNING (redirect URL `/content/redirects`): audit's objection was based on OUTDATED admin structure — Shopify Help Center now places URL redirects under Content > Menus, and content-hub slugs follow `/content/{noun}`. Kept the URL; documented.

Gates: build clean, tsc clean, eslint/prettier clean, **2588 tests** passing (Node 24 mandatory locally).

## LATENT / verify on first paid merchant (NOT a bug today — zero paid merchants)

- gc-1wf's full `scopes.request()` App Bridge round-trip is unverifiable until a real managed-install/paid merchant (dev installs auto-grant scopes). Pure logic is tested; live flow is not.
- `/content/redirects` and the product-metafields fallback URL: eyeball on first live merchant with those finding types. One-line constant fix if wrong.

## Open follow-ons (untouched this session)

- gc-1we (H3) — Railway cron for dead-man's-switch (standalone).
- gc-lmh (M4) — react-router v8 migration vs accept mitigated advisories (deferred by owner).

## Risk / housekeeping

- Beads closed LOCAL-ONLY — `bd dolt push` was failing ("no store available") per prior handoff; re-push when the shared Dolt sql-server is up or closes won't propagate.
- Untracked `memory/*.md` handoffs on main (established pattern, not in git).
