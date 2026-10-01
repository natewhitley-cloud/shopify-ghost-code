# Spike: Ghost Code "Fix it for me" (Professional): theme auto-remediation

Date: 2026-10-01. Read-only spike. No repo edits, no DB writes (one read-only `groupBy` against prod).
Docs read 2026-10-01 via shopify-dev doc search + WebFetch. Tags: **[V]** = verified (source cited), **[I]** = inferred.

## TL;DR

- Feasible, but gated by a **Shopify protected-scope exemption** (`write_themes` + manual approval), not just a scope add. **[V]**
- The only defensible v1: **"Clean copy"**: duplicate the live theme, apply removals to the UNPUBLISHED copy, merchant previews and publishes it themselves. Never write to the MAIN theme. **[I, design]**
- Fixable scope v1 = 4 signature-matched, `safe-to-remove` types (GHOST_SCRIPT, GHOST_STYLE, GHOST_PRECONNECT, GHOST_SNIPPET's `{% render %}` line). ~42% of current prod findings. **[V counts, I scope]**
- The Finding row is **not precise enough** to edit safely today (line number + 300-char snippet only; no byte range, no file checksum). Needs a schema add. **[V]**
- This **reverses a documented strategy decision** (`docs/product-strategy.md:135-137`, "revisit only after 500+ installs, zero FP reports") and **contradicts live Terms + Privacy text**. Decision for Nathan, not an engineering call. **[V]**
- Size: **M-L overall (~2-3 weeks focused)** plus an exemption wait of unknown length.

## 1. Shopify platform

| Item | Finding | Tag / source |
|---|---|---|
| Scope | `write_themes` **plus** "an exemption from Shopify to modify theme files" on `themeFilesUpsert`, `themeFilesDelete`, `themeDuplicate`, `themeCreate` | [V] https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/themeFilesUpsert , .../2026-04/mutations/themeFilesDelete , .../unstable/mutations/themeDuplicate , .../2026-10/mutations/themeCreate |
| Exemption process | "Online Store Protected Scope Exemption Request" form. No confirmation email or status page; no guaranteed timeline; unlisted/in-dev apps may put a placeholder in the App Store URL field | [V] Shopify staff, 2026-06-18 https://community.shopify.dev/t/write-themes-exemption-no-confirmation-received-unlisted-app-app-store-url-required/35275 ; 2026-03-10 https://community.shopify.dev/t/requesting-write-themes-themefilesupsert-exemption-for-app-in-development-phase/31997 |
| Exemption is per app record | One dev reported the exemption applied to their dev app but not prod (fixed by a support ticket in ~24h). Ghost Code has a test app + prod app, so verify both | [V] https://community.shopify.dev/t/issue-themefilesupsert-returns-access-denied-despite-write-themes-scope-and-approved-exemption/35003 (2026-06-08..10) |
| Approval criteria | Built for Shopify 3.2.2: apps "shouldn't add, remove, or edit a merchant's theme files" except (a) page builders, (b) "Your app backs up all theme files, and restores files from a backup", (c) "primarily provides search engine optimization, content locking, or developer tooling functionality". Staff cite "developer tooling" as an eligible use case | [V] https://shopify.dev/docs/apps/launch/built-for-shopify/requirements (3.2.2); staff quote in thread 31997 |
| Does ghost-code removal qualify? | Plausibly under "developer tooling" and/or "SEO" (several of our types are SEO residue). Removing leftover app code is also exactly what Shopify's own docs call the problem ("Uninstalling apps often leaves the code edits, or ghost code, behind"). Residue / ThemeSweep / BloatBuster are listed and auto-remove, so Shopify approved *something* similar. **Not guaranteed; Shopify publishes no rubric.** | [V] quote: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/migrate ; competitors: `memory/handoff-2026-09-26-journey-nudges-DEPLOYED.md:41-56`; [I] that they hold the exemption |
| BFS impact | 3.2.2 is audited at BFS application. Holding write access may complicate a future BFS badge unless the exemption covers it | [V] same BFS page ("audited for Asset API usage") ; [I] effect |
| APIs (we pin 2026-07) | `themeDuplicate(id, name)` → `newTheme` (copy is a normal theme). `themeFilesUpsert(themeId, files[])` max **50 files/request**, returns async `job`. `themeFilesDelete(themeId, files[])`. `themeCreate` only UNPUBLISHED/DEVELOPMENT roles. `OnlineStoreThemeFile.checksumMd5` + `updatedAt` readable with `read_themes`. Upsert input is only `{filename, body}`: **no compare-and-set / precondition** | [V] mutation pages above; https://shopify.dev/docs/api/admin-graphql/2027-01/objects/OnlineStoreThemeFile ; https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/OnlineStoreThemeFilesUpsertFileInput ; app pins `api_version = "2026-07"` `shopify.app.toml:12`, `ApiVersion.July26` `app/shopify.server.ts:28` |
| Duplicate failure modes | `ThemeDuplicateUserErrorCode` documents only `NOT_FOUND`. Store theme-count cap and duplicate processing time are not documented there | [V] https://shopify.dev/docs/api/admin-graphql/2026-04/enums/ThemeDuplicateUserErrorCode ; [I] a 20-theme store cap exists (from general Shopify knowledge, not re-verified) and duplicate is async (`processing` flag on themes query) |
| Live vs copy | Nothing in the API forbids writing MAIN. **Recommend never writing MAIN**: write a duplicate, merchant previews (`?preview_theme_id=`) and publishes in Shopify admin. Gives a free full backup (the original stays as an unpublished theme), no race with merchant/other-app edits, and matches BFS exception (b)'s spirit | [I, design] |
| App Store "use app embeds" rule | That requirement is about apps *adding* their own storefront code (must use theme app extensions); it does not address a cleaner removing others' code. The governing control is the protected-scope exemption | [V] https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/migrate ; [I] interpretation |
| Scope request UX | `write_themes` cannot be an App Bridge optional scope without the exemption; if granted, request it only when a Pro merchant clicks "Fix" (existing optional-scope pattern `app/lib/optional-scopes.ts:5-20`, `shopify.app.toml:39`) so Free/Standard installs stay read-only | [V] pattern exists; [I] that write_themes works as an optional scope (test on dev store) |

## 2. Codebase: what is mechanically fixable

Prod snapshot (latest completed scan per shop, 8 shops, 166 findings, read-only query 2026-10-01; includes any internal/test shops): GHOST_SNIPPET 33, GHOST_SCRIPT 25, GHOST_OG 20, GHOST_TITLE 12, GHOST_LAYOUT 12, GHOST_TEXT 12, DUPLICATE_META 11, GHOST_STYLE 10, GHOST_PIXEL 8, GHOST_HREFLANG 8, others ≤4. **[V]**

The repo already has the right axis: `app/lib/finding-safety.ts:39-127` (`safe-to-remove` / `verify-first` / `leave-alone`), plus detection confidence `app/lib/finding-classification.ts:57-200` (signature vs heuristic). Proposed fix tiers:

| Tier | Types | Edit | Why |
|---|---|---|---|
| **v1 auto (opt-in per finding)** | GHOST_SCRIPT, GHOST_STYLE, GHOST_PRECONNECT | Delete the exact tag span (`<script ...>` through its `</script>`; `<link ...>`) | `safe-to-remove` (`finding-safety.ts:43-51`) AND `signature` (`finding-classification.ts:160-173`); the detector already has the exact tag + offset (`scan-engine.server.ts:751-766`) |
| **v1 auto** | GHOST_SNIPPET (the `{% render/include %}` line only) | Delete the tag span; do NOT delete the snippet file in v1 | Same tiers (`finding-safety.ts:47-48`). Deleting `snippets/*.liquid` is v2: ORPHAN_ASSET logic misses dynamic `{% render var %}` (`finding-safety.ts:92`) |
| **Excluded: MALICIOUS_SCRIPT** | | Never auto. Show "remove now" guidance + optional one-click with explicit confirm in v2 | Mapped `safe-to-remove` (`finding-safety.ts:52-54`) but it is the highest-stakes FP (merchant-facing "you're hacked") and the source may be in an asset the attacker also modified. Brief rule: never auto |
| **v2 human-confirmed** | GHOST_PIXEL, GHOST_FONT, GHOST_AJAX, GHOST_TEXT, GHOST_SECTION, GHOST_HREFLANG, GHOST_OG/TITLE/CANONICAL/ROBOTS, DUPLICATE_*, GHOST_JSON_LD, ORPHAN_ASSET, GHOST_LAYOUT | Show diff, merchant picks | `verify-first`; many are heuristic and inline-JS/markup blocks have no reliable end boundary |
| **Never** | JSON_LD_*, DANGLING_REFERENCE, CHECKOUT_SUNSET, SETTINGS_DRIFT; Admin-resource types (GHOST_PAGE/TAG/PRICE/METAFIELD/REDIRECT/TRANSLATION) | n/a | `leave-alone` (`finding-safety.ts:56-74`); Admin types need other write scopes entirely |

Possible v1.5: settings_data.json app-embed `"disabled": true` blocks of uninstalled apps (bead gc-fed). JSON edit, but `SETTINGS_DRIFT` copy says "never hand-edit the JSON" (`finding-safety.ts:72-74`). **[V/I]**

### Data-model gaps (Finding cannot drive a precise edit today) **[V]**

`prisma/schema.prisma:304-319` stores `filename, lineNumber, codeSnippet, findingType, appName, description`. `buildSnippet` (`scan-engine.server.ts:578-593`) keeps the matched line ±1 line, **truncated to 300 chars**, so on minified/long lines the snippet does not contain the full tag. The theme fetch does not request `checksumMd5`/`updatedAt` (`app/services/theme-fetcher.server.ts:55-72`). Scan stores `themeId` (`schema.prisma:195`).

Missing, needed:
1. **Exact match text** of the tag (bounded, e.g. ≤2 KB) + **char offset** (or a `matchStart/matchEnd`). Detectors already compute `offset + match.index` (`scan-engine.server.ts:765`); they discard it.
2. **File `checksumMd5` at scan time** (per scanned file, on Scan or a small ScanFile table) for drift detection.
3. Count of identical matches in the file (to refuse ambiguous edits).
4. Fix records: a `FixRun` (shop, scanId, sourceThemeId, copyThemeId, status, createdBy, timestamps) and `FixItem` (findingId/fingerprint, filename, preChecksum, postChecksum, status, error). Redact + prune coverage needed (`memory` gotcha: new id-keyed types escape `deleteShopData`). **[I]**

Apply algorithm (edit-by-content, not by line): fetch file from the COPY, verify `checksumMd5 == scan checksum` (else "file changed since scan, rescan"), find the stored exact tag text, require exactly **one** occurrence (else skip), splice it out, re-parse (Liquid tag balance; for `.json` JSON.parse), upsert, re-read checksum. **[I]**

## 3. Safety design

| Concern | Design | Size |
|---|---|---|
| Backup / rollback | `themeDuplicate` of MAIN → "Ghost Code clean copy (date)". Original MAIN is untouched; rollback = don't publish / republish original. No need to store theme bodies ourselves (keeps Privacy §3 "full theme file contents are not stored" true, `data-integrity-suite/ghost-code/privacy.html:93`) | S |
| Drift | Scan-time `checksumMd5` vs MAIN at fix time AND vs copy; refuse the file on mismatch. Also refuse if the scan is older than N days (ties into gc-mgi stale-results) | S-M |
| Preview | Per-file unified diff in-app before apply; after apply, "Preview clean copy" link + Shopify theme editor link (existing `app/lib/theme-editor-url.ts`) | M |
| Idempotency | Key FixItem on (copyThemeId, fingerprint) using `fingerprintFinding` (`app/services/scan-differ.server.ts:127-141`); re-run skips done items; content-based edit is naturally idempotent (tag gone → 0 matches → "already clean") | S |
| Partial failure | Per-file upserts (≤50/request), per-item status; copy is never published by us, so partial = harmless; show "7 of 9 removed, 2 skipped (why)". Run as Inngest steps like scans | M |
| Audit log | FixRun/FixItem visible in-app; ops event per run (redact/prune covered) | S |
| FP containment | Only `safe-to-remove` ∩ `signature` types; never MALICIOUS_SCRIPT; per-finding opt-in checkboxes default **unchecked** for anything not in v1 set; skip findings the merchant ignored (FP-suppression table); skip if `appName` matches an app the merchant says is still installed (we cannot see installed apps: `finding-safety.ts:126-130` comment) ; require explicit "I've uninstalled X" confirmation per app | M |
| Liquid breakage | Post-edit validation: tag balance; theme-check-lite on edited files; Shopify will also reject invalid Liquid on upsert (**[I]**, verify) | M |
| Telemetry | Track fixes published vs abandoned; any "restored original" = FP signal | S |

Note on recent FPs: the two HIGH FPs that drove uninstalls were GHOST_TITLE (gc-j93, `memory/handoff-2026-09-23e-scanner-batch-DEPLOYED.md:10`, `memory/handoff-2026-09-26-journey-nudges-DEPLOYED.md:35`). GHOST_TITLE is heuristic + verify-first, so the proposed v1 tiering would have excluded it. **[V]** But that is precisely the class of bug (a detector change silently mis-firing) that would reach the fix path if tiers drift; add a test that the fixable set ⊆ safe-to-remove ∩ signature minus MALICIOUS_SCRIPT. **[I]**

## 4. Product

**Is "fix" a credible Pro differentiator?** Partly. It is **table stakes, not a differentiator**: 3 of 9 look-alikes already auto-remove (Residue $49/yr, ThemeSweep $9.99-39.99, BloatBuster $6.99), all at or below our $29 Pro (`memory/handoff-2026-09-26...:41-56`). **[V]** Its value is defensive: removes a "why pay you when X fixes it?" objection on the comparison table. Ghost Code's real edge stays breadth (26 checks, Admin-resource findings, MALICIOUS_SCRIPT free). **[I]** All competitors have 0 reviews, so no evidence auto-fix wins installs yet. **[V, same source]**

Counter-evidence in our own docs: auto-removal was killed twice, citing Cleanify Code's delisting after FP-driven removals (`docs/product-strategy.md:135-137`, `memory/handoff-2026-09-18-pricing-and-competitive.md:18`). Current install base (8 shops with completed scans) is far below the self-set 500-install / zero-FP bar. **[V]**

### Build size

| Piece | Size |
|---|---|
| Exemption request + dual-app verification + scope-request UX | S (calendar time unknown) |
| Schema: match text/offset, file checksum, FixRun/FixItem + redact/prune | M |
| Detector changes to persist exact span for 4 types + tests | S-M |
| Fix engine (duplicate, poll, fetch, verify, splice, upsert, validate) via Inngest | M |
| Diff preview + selection + results UI (Polaris) | M |
| Plan gating (Pro), telemetry, ops events | S |
| Legal: Terms §§ lines 19, 95, 121 and Privacy line 25 rewritten; listing copy | S (+counsel?) |
| Tests incl. adversarial fixtures (minified lines, duplicate tags, Liquid-wrapped tags, drift) | M |
| **Total** | **M-L, ~2-3 focused weeks + exemption wait** |

### Main risks
1. Exemption denied or slow (no SLA). Mitigation: file the request first, build after. **[V no SLA]**
2. FP → broken storefront → review/delisting (Cleanify). Contained by copy-theme + narrow tiers. **[I]**
3. Legal/trust: live Terms say "The App operates in read-only mode. It does not modify, edit, or delete any theme files" (`data-integrity-suite/ghost-code/terms.html:19`, also :95) and Privacy says "We do not request write access to your themes" (`privacy.html:25`). Must be updated **before** requesting the scope; existing installs must be notified; write access applies to all merchants who grant it, so scope it to Pro opt-in only. Liability cap = fees paid in prior 12 months (`terms.html:103`); add an explicit "you publish the copy; we never publish" clause. Counsel review advisable. **[V text, I remedy]**
4. Positioning whiplash: marketing currently counter-positions "we won't touch your live theme" (`memory/handoff-2026-09-18-pricing-and-competitive.md:18`). The copy-theme model keeps that claim literally true. **[I]**

### Recommended v1 slice ("Clean copy", Pro only)
1. Merchant selects findings (only GHOST_SCRIPT / GHOST_STYLE / GHOST_PRECONNECT / GHOST_SNIPPET render-tag, signature-matched, not ignored, scan ≤7 days old) and confirms each source app is uninstalled.
2. App duplicates MAIN → applies content-matched removals to the copy with checksum drift guard → shows per-file diff + results.
3. Merchant previews and publishes in Shopify admin. We never touch MAIN, never delete files, never auto-fix MALICIOUS_SCRIPT, never touch JSON.
4. Ship only after: exemption granted on both app records, Terms/Privacy updated, gc-mgi (stale results) shipped.

Sequencing recommendation: **file the exemption request now (cheap, long pole); hold the build decision** until (a) it is granted and (b) a few Pro conversions or explicit merchant asks show demand. Until then, a no-scope "copy-paste fix pack" (exact lines to delete per file, with theme-editor deep links) captures much of the value at zero risk. **[I]**

## Unknowns (top 3)
1. Will Shopify grant the exemption to a *cleaner* app, and how long does it take? (No published rubric or SLA.)
2. Is `write_themes` usable as an App Bridge *optional* scope (so only Pro opt-ins grant it), and does `themeFilesUpsert` reject invalid Liquid? Verify on a dev store once exempt.
3. Demand: does auto-fix actually move installs/conversions vs competitors with 0 reviews, at our 8-shop base? No data yet.
