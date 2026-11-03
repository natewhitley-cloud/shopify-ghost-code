# Spike refresh: gc-tib "clean copy" theme code removal (2026-11-03)

Date: 2026-11-03. Read-only refresh of `docs/spikes/2026-10-01-theme-autofix.md`. No code edits, no writes to Shopify or Railway, nothing filed with Shopify.
Worktree `batch/2026-11-03` at `dbd54c5` (= origin/main). Tags: **[V]** verified (source cited, read today), **[I]** inferred/design, **[U]** unverified claim (third-party or community).

## Summary

1. **Exemption is still the long pole, and the risk went up.** The form is unchanged (Google Form "Online Store Protected Scope Exemption Request", 8 fields, no status page, no SLA). The old shopify.dev page listing eligible categories and "within two weeks" now **redirects away** (only search-engine caches still show it). In June 2026 Shopify **denied** an app whose model was "merchant reviews the exact diff, approves each single-file write" ("does not fit the exemption requirements"). Our best claim is BFS 3.2.2 (c) "developer tooling", plus the full-theme backup pattern. **File for both app records on day 1.** [V]
2. **A no-exemption path exists and a competitor ships it.** Residue's listing shows **view-only** theme access and the flow "Confirm, then download a clean copy. Upload it as a draft." That means the app writes nothing, and the merchant uploads the cleaned theme file. This is a real fallback if the exemption is denied or slow (owner decision D1). [V listing, I mechanics]
3. **Big code drift, mostly in our favor.** The theme fetch now reads `checksumMd5`/`size`/`updatedAt` for every file, and the new `ScanManifest` table keeps a per-file md5 per scan (gc-rrh.4). So the "file checksum at scan time" prereq is **mostly done**. It is still missing: an exact tag span (start/end) per finding, and a guarantee that the manifest exists for the scan being fixed (it is saved best-effort and only the newest 2 per theme are kept). [V]
4. **gc-rch drift:** MALICIOUS_SCRIPT is no longer `safe-to-remove`. It is `security-risk` now (`finding-safety.ts:49`). The safe-to-remove set is exactly the 4 v1 types. That mapping is in `origin/main` (d01d752 is an ancestor of HEAD). The bead still says "operator review of mapping pending". [V]
5. **API mechanics confirmed.** `themeFilesUpsert` input is only `{filename, body}`: there is no compare-and-set. Max 50 files per request. `themeDuplicate`/`themePublish` need write_themes + exemption. A store holds 20 themes (100 on Plus). Liquid files max 256 KB. Drift guard = re-read checksum right before writing, refuse on mismatch, re-read after writing, and verify against a locally computed md5. [V]
6. **Legal text drifted to new line numbers.** The read-only claims are now `terms.html:35, :99, :112` and `privacy.html:38, :42`, plus `privacy.html:111` (300-char snippet claim), which the design must keep true. [V]
7. **Competitors:** Store Safety (live 2026-10-27; Free/$9/$19; "removes it after you approve", backup first) is a **Backup & Restore** app, which is an eligible exemption category we are not in. ThemeSweep (edit-theme access) works "on a duplicated theme with a full backup and one-click rollback". BloatBuster now lists guided removal at $2.99/mo, not auto-removal. All have 0 reviews. [V listings, U behavior]
8. **Plan:** 7 slices. Slices 1-5 (span model, splice engine, schema, orchestrator against a mocked Admin client, UI) and the legal drafts can all be built and tested **before** approval. Only slice 7 (a live write on a dev store) needs the exemption. As far as I can find, no custom-distribution or dev-store loophole is documented. [V docs, I plan]

## Owner decisions needed

Each has my recommendation. They are numbered so you can answer "D1: A".

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Write path | **A** exemption + `themeDuplicate` + write to the copy (bead plan). **B** no write scope: generate a cleaned theme ZIP, merchant uploads it as a draft (Residue model). **C** build B now, add A when approved | **A, with B as a dated fallback.** File A on day 1. Slices 1-3 serve both paths. If there is no answer by day 14 (2026-11-17), or the request is denied, build the B export (about 3-4 extra days). Why not B first: a ZIP means reading every asset (binary, up to 20 MB each), a 50 MB upload cap, and merchant friction. Also, an uploaded theme probably loses its Theme Store update link [I, verify]. |
| D2 | Who publishes the clean copy | **A** merchant publishes in Shopify admin (we never call `themePublish`). **B** in-app "Publish" button | **A.** It keeps "we never touch your live theme" literally true, keeps the exemption request narrow, and removes the stale-copy race from our code (we warn about it instead). |
| D3 | v1 finding types | **A** the 4 safe-to-remove types (GHOST_SCRIPT, GHOST_STYLE, GHOST_PRECONNECT incl. `preload`/`dns-prefetch`, GHOST_SNIPPET render/include line incl. the bare `{% liquid %}` form). **B** A minus GHOST_SNIPPET bare form | **A.** All 4 are `safe-to-remove` and `signature`, and the bare form has a clear end at the line boundary. Exclusions in §4. |
| D4 | Plan gating | **A** Professional only. **B** Standard + Professional | **A.** It is the bead's framing, and only merchants who opt in grant write access. |
| D5 | "App is really gone" gate | **A** block any finding whose app has an enabled app embed (gc-k71c signal) + require a per-app "I've uninstalled X" checkbox. **B** checkbox only | **A.** Detection has no installed-app cross-check (`finding-safety.ts:162-167`). The embed signal already exists and costs nothing. |
| D6 | Where the tag span comes from | **A** re-run the detector on the copy's file at fix time (checksum-gated), and store only `spanStart`/`spanEnd`/`spanSha256` on Finding. **B** store the exact tag text (up to 2 KB) on Finding | **A.** It stores no new code text, so `privacy.html:111` ("up to 300 characters") stays true. If the checksum matches, re-detection is deterministic. |
| D7 | Legal + consent | **A** rewrite Terms/Privacy before adding the scope, make write_themes an optional scope requested only on "Fix", email no one (existing installs keep read-only). **B** same + counsel review | **A now, B if budget allows.** The text is factual and the scope stays opt-in. The Partner Agreement email rule rules out a mass notice anyway. |
| D8 | Positioning docs | Update `docs/product-strategy.md:37` ("Read-only. We never edit the theme.") and `:158-160` ("Why not auto-removal?") to "we never touch your live theme; you publish the cleaned copy" | Do it in the same batch as the legal text, so nothing contradicts the listing. |
| D9 | Canvas themes | Exclude Canvas themes from v1 until gc-dg5e reports | Exclude (refuse with a clear message). gc-dg5e is a dependency, not in scope here. |

## Blockers

1. **Exemption not filed** for either app record. No SLA, and there is a 2026-06 denial precedent for a similar write model (§1). Owner action, day 1.
2. **Test app record unknown to this repo.** Only one `shopify.app.toml` exists (`client_id 3e80…`, prod). The test app's name and client ID must come from the Partner Dashboard (Apps > app > Client credentials) for the second form submission.
3. **Legal docs** (`~/shopify/data-integrity-suite/ghost-code/terms.html`, `privacy.html`) must be updated and live before the scope is added to `shopify.app.toml` (§2.3).
4. **No live write testing before approval.** Every write mutation returns ACCESS_DENIED without the exemption, and I found no documented dev-store or custom-app exception (§1.5). Slice 7 waits.
5. **Unverified platform behaviors** that change the design if wrong (probe in slice 0/7): Shopify `checksumMd5` = md5 of the UTF-8 body; `themeDuplicate` keeps file checksums; `write_themes` works as an App Bridge optional scope; whether `themeFilesUpsert` rejects invalid Liquid; the error code when the store is at its theme cap.
6. **gc-rch operator review still open.** The bead note says "OPERATOR: review the safety mapping + final label wording before deploy". The code is in main, but I did not check whether it is deployed.
7. **Canvas (gc-dg5e)** is a dependency. v1 refuses Canvas themes until it lands.

---

## 1. Exemption: current process (read 2026-11-03)

### 1.1 Where it is filed

- Every write mutation page links the same form. `themeFilesUpsert` (2026-10): "The user needs write\_themes and an exemption from Shopify to modify theme files." It links to "submit an exception request" at **https://docs.google.com/forms/d/e/1FAIpQLSfZTB1vxFC5d1-GPdqYunWRGUoDcOheHQzfK2RoEFEHrknt5g/viewform**. [V] https://shopify.dev/docs/api/admin-graphql/latest/mutations/themeFilesUpsert
- `themeDuplicate` and `themePublish` (2026-10): "The user needs write\_themes and an exemption from Shopify to modify themes." [V] https://shopify.dev/docs/api/admin-graphql/latest/mutations/themeDuplicate , https://shopify.dev/docs/api/admin-graphql/latest/mutations/themePublish
- **Drift since 10-01:** `https://shopify.dev/docs/apps/build/online-store/asset-legacy` (and `/docs/apps/online-store/other-integration-methods/asset`) now **redirect to** `/docs/apps/build/online-store/theme-app-extensions` (curl, 2026-11-03). The categories list (page builders / backup apps / Liquid in repeating blocks), the "within two weeks" line and the "valid for BFS" line survive only in search-engine snippets. **Treat them as historical, not current policy.** [V redirect; U cached text]

### 1.2 What the form asks (verbatim, read 2026-11-03)

Title: "Online Store Protected Scope Exemption Request". Description includes: "An app should first use theme app extensions to add dynamic elements to merchants' online store themes." / "If theme app extensions are not sufficient to implement your app's functionality, you can request access to the asset and theme API scopes." / "These scopes let your app create, publish, update, or delete an online store theme's assets and associated resources." / "All published apps must meet every App Store requirement, including 1.1.3 "Direct merchants to the Shopify Theme Store."" / "Approval for these scopes doesn't exempt your app from this requirement." / "To help us assess your exemption request, please describe your use cases in detail." / "Requests without enough detail may take longer to review or may be denied." It lists the Asset API mutations (themeFilesCopy, themeFilesDelete, themeFilesUpsert) and the Theme API mutations (themeCreate, themeDelete, themeDuplicate, themePublish, themeUpdate).

Fields (all required): Email; Consent ("I consent."); Shopify Partner Account ID; Contact Name; App Name; Shopify App Store URL; Client ID ("In your Partner Dashboard navigate to Apps > select your app > select Client credentials"); Scope history ("Has this app been granted or currently has the Asset API (write_themes_assets) or Theme API (write_theme_api) scope before?" with the options Yes Asset only / Yes Theme only / Yes both / **No, this is my first request** / I'm not sure). [V] form URL above.

Note: the fetched form text showed **no free-text use-case field**, even though the description asks you to "describe your use cases in detail". The field may sit on a second page that the fetch did not render. Have the justification below ready to paste. If there is no field, reply with it when the review team makes contact. [V fetch; I interpretation]

### 1.3 Eligibility (current official text)

- Built for Shopify 3.2.2 (read today via `requirements.md`): "Your app shouldn't add, remove, or edit a merchant's theme files. There are three exceptions to this rule:" (a) page builder; (b) "Your app backs up all theme files, and restores files from a backup."; (c) "Your app primarily provides search engine optimization, content locking, or developer tooling functionality." Also: "Your app will be audited for Asset API usage when you apply for Built for Shopify status." [V] https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
- Fit: GhostCode is a theme-code audit tool (developer tooling). Several finding types are SEO residue. The clean-copy model duplicates the **whole** theme before any change, which matches (b) in spirit but does not make us a backup app. [I] **Not guaranteed.**
- **Denial precedent (new):** Velyr_io, 2026-06-20, "Theme API write exemption denied": the app proposed a single targeted fix, "The merchant reviews the exact diff and approves each change". It was denied as "does not fit the exemption requirements" (ticket 68049335). Paige-Shopify, 2026-06-22: "A merchant-approved write to an existing theme file still requires approved access to `write_themes`." and "There isn't an app embed pattern for rewriting existing theme code." [V] https://community.shopify.dev/t/theme-api-write-exemption-denied-is-single-file-per-change-merchant-approved-writing-ever-approvable-or-is-app-embeds-the-only-path/35406 . Lesson: per-change consent alone is not the eligibility argument. The **category** (developer tooling / theme maintenance) is. [I]

### 1.4 Turnaround and status

- Alan_G (reads as staff, role not labeled), 2026-06-18: "There isn't currently a public status page or confirmation email flow for these exemption requests"; "I can't guarantee an exact timeline there, but it is in the queue." He says a placeholder in the App Store URL field is "usually okay". [V] https://community.shopify.dev/t/write-themes-exemption-no-confirmation-received-unlisted-app-app-store-url-required/35275
- Liam-Shopify, 2026-03-10: you "can use a placeholder or note that the app is not yet submitted". He did not answer whether write_themes works on dev stores before approval. [V] https://community.shopify.dev/t/requesting-write-themes-themefilesupsert-exemption-for-app-in-development-phase/31997
- Reported durations: "3-5 working days" (one community reply, 2026-04, thread 33505) [U]; historical doc "within two weeks" [U, page now redirects]. **Plan for 2+ weeks and possible denial.**

### 1.5 Per app record, and no dev loophole

- Senior_Developer, 2026-06-08: the exemption worked on the dev app but the prod app got ACCESS_DENIED. Paige-Shopify, 2026-06-09: "it looks like the exemption wasn't applied to your production app correctly". Resolved through a ticket in about 25h. [V] https://community.shopify.dev/t/issue-themefilesupsert-returns-access-denied-despite-write-themes-scope-and-approved-exemption/35003
- Custom-distribution / admin-created custom apps: I found no source that says they skip the exemption, and forum replies conflict [U]. Do not plan on it. Instead, ask in the request: "Can the test app record use the scope on development stores while prod is under review?"

### 1.6 Draft justification (paste-ready; file for BOTH records)

Submit the form **twice**: once for the prod record (App Store URL `https://apps.shopify.com/ghost-code`, client ID from shopify.app.toml) and once for the test record (App Store URL field: "Not listed: development/test record of GhostCode, listed at https://apps.shopify.com/ghost-code"; that record's own client ID). Scope history: "No, this is my first request". Fill the bracketed facts in before sending.

> **App:** GhostCode (Alpenglow Software LLC). Listed at https://apps.shopify.com/ghost-code. This request covers [prod | test] app record, client ID [ID]. Please apply the same decision to our other record, client ID [ID], which we are submitting separately.
>
> **What the app does today:** GhostCode is a theme-code audit tool. With read_themes only, it scans a store's theme files and reports code that uninstalled apps left behind: external app scripts and stylesheets, connection hints to app CDNs, and `{% render %}` calls to app snippets. Each finding shows the file, the line, and the app it came from. Merchants currently delete this code by hand in the code editor. Shopify's own docs describe the problem: "Uninstalling apps often leaves the code edits, or ghost code, behind."
>
> **What we want to add, and why theme app extensions can't do it:** an optional "clean copy" action for merchants who choose it. The leftover code sits in the merchant's existing theme files, so removing it means editing those files. App embeds and app blocks can only add app-owned code. They cannot remove code another app wrote into the theme.
>
> **Exactly what we would write:**
> 1. `themeDuplicate` of the published theme. We never write to the published (MAIN) theme. The original stays untouched as a full backup.
> 2. `themeFilesUpsert` on that unpublished copy only. Each edit deletes one exact tag the merchant selected: a `<script src>` or `<link>` pointing to a known app CDN, or a `{% render %}`/`{% include %}` line for a known app snippet. We never delete files, never edit JSON/config files, and never edit files we didn't flag.
> 3. Before each write we check that the file is byte-identical (checksum) to what we scanned, and we skip the file if it isn't. After writing we re-read the file to confirm the result.
> 4. We do not publish. The merchant previews the copy and publishes it themselves in Shopify admin. If they don't like it, the original theme is still there.
>
> **Scopes and controls:** write_themes will be an optional scope, requested only when a merchant on our Professional plan clicks the clean-copy action. Every other install stays read-only. The merchant ticks each finding, confirms the source app is uninstalled, and sees a per-file diff before anything is written. We do not use themeFilesDelete, themeFilesCopy, themeCreate, themeDelete, themeUpdate or (in this version) themePublish.
>
> **Category:** we believe this fits the developer tooling / theme maintenance category in Built for Shopify requirement 3.2.2. We also follow the backup-before-change pattern, because the original theme is kept as a complete copy. We direct merchants to the Shopify Theme Store per requirement 1.1.3 [confirm how: e.g. link in Help page].
>
> **Question:** while this request is reviewed, can our test app record use these mutations on development stores?
>
> Contact: Nathan Whitley, [email], Partner ID [ID].

Do not overclaim. Leave out install counts, "Shopify-approved" language, and competitor names. The Shopify quote is verified at https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/migrate (10-01 spike; re-check before pasting). [I]

## 2. Code drift since 2026-10-01 (every spike citation re-checked)

### 2.1 Citation table

| Spike cite | Now | Status |
|---|---|---|
| `shopify.app.toml:37` `scopes = "read_themes"` | `:37` same; `:36` comment "only needs to read themes"; `:39` optional scopes unchanged | unchanged [V] |
| `shopify.app.toml:12` api 2026-07 | `:12` is `[webhooks] api_version = "2026-07"` | unchanged [V] |
| `app/shopify.server.ts:28` `ApiVersion.July26` | `:28` and `:49` | unchanged [V] |
| `app/lib/optional-scopes.ts:5-20` | doc comment `:1-20`, list `:23-29` | moved [V] |
| `finding-safety.ts:39-127` map | map `:43-146` | moved [V] |
| `finding-safety.ts:52-54` MALICIOUS_SCRIPT `safe-to-remove` | `:49` **`security-risk`**; also APP_INCIDENT_ADVISORY `:53`, MENU_INJECTION `:56` | **changed** (safer) [V] |
| `finding-safety.ts:43-51` safe-to-remove | `:61-69` exactly GHOST_SCRIPT/STYLE/SNIPPET/PRECONNECT | moved [V] |
| `finding-safety.ts:56-74` leave-alone | `:73-93`, plus new GHOST_APP_EMBED `:90`, SCRIPT_TAG_SUNSET `:93` | grew [V] |
| label | `:167` "Likely safe, confirm app removed" | [V] |
| `finding-classification.ts:160-173` signature set | `SIGNATURE_FINDING_TYPES` `:182`, includes the 4 types; `getFindingConfidence` `:219` | moved [V] |
| `scan-engine.server.ts:578-593` buildSnippet | `:633-648`, still ±1 line, 300-char cap | moved [V] |
| `scan-engine.server.ts:751-766` offsets | GHOST_SCRIPT `:850-896` (offset `:875`); GHOST_STYLE `:922-971` (`:950`); GHOST_SNIPPET `:996-1047` (`RENDER_RE :980`, bare `:990`); GHOST_PRECONNECT `:5511-5570`; `extractTags` `:312-337` | moved; offsets still computed then discarded [V] |
| `theme-fetcher.server.ts:55-72` no checksum | `THEME_FILES_QUERY :88-110` **requests `checksumMd5`, `size`, `updatedAt`**; `onFileMeta` callback `:243-312` (gc-rrh.4, `e64b392`) | **changed** [V] |
| `schema.prisma:304-319` Finding | `:726-741`, same fields (no span, no checksum) | moved [V] |
| `schema.prisma:195` Scan.themeId | `:498` | moved [V] |
| `scan-differ.server.ts:127-141` fingerprint | `fingerprintFinding :153-161` | moved [V] |
| `docs/product-strategy.md:135-137` | **`:158-160`** "Why not auto-removal?"; also `:37` "Read-only. We never edit the theme." | moved [V] |
| `terms.html:19`, `:95` | **`:35`** ("The App operates in read-only mode. It does not modify, edit, or delete any theme files."), **`:99`** ("read-only mode for scanning purposes only"), **`:112`** ("The App does not modify your theme."); `:36` optional scopes read-only (stays true); liability cap `:120` | moved [V] (`data-integrity-suite` @ `72e4d3d`, 2026-11-02) |
| `privacy.html:25` | **`:38`** ("read-only mode"), **`:42`** ("We do not request write access to your themes. We do not modify any theme files.") | moved [V] |
| `privacy.html:93` contents not stored | `:140`; also `:111` findings snippet "up to 300 characters", `:138` | moved; `:111` is new to watch [V] |
| gc-mgi stale results | CLOSED, built `30cbe1c`; `app/lib/stale-results.ts` exists | prereq done [V]; deploy state not checked |

### 2.2 Scan-time data available today, and what is missing

Available [V]:
- **Per-file Shopify md5 per scan**: `ScanManifest.entries` = `[path, md5|null, size|null, updatedAtEpochSec|null, ownerApp|null]` (`schema.prisma:613-631`). Written by `persistScanManifest` (`inngest/functions/scan-theme.ts:1182-1214`). Kept for the **newest 2** scans per (shop, theme) (`MANIFEST_KEEP_PER_THEME = 2`, `app/models/scan-manifest.server.ts:22`). **Best-effort:** on failure the scan continues with no manifest (`:1205-1214`, `manifest_persist_failed`).
- `Scan.themeId` (`:498`), `Shop.lastThemePublishAt` (`:67`), and `Finding.filename/lineNumber/codeSnippet(≤300)/appName`.
- **Live-app signal:** `appsWithEnabledEmbed` (`scan-theme.ts:654, :778`, gc-k71c) and `AppRemoval` rows (`schema.prisma:409-433`, REMOVED/CLEANED/REINSTALLED).
- Detectors compute exact tag starts (`offset + match.index`) and drop them.

Must be persisted or added:
1. **Span per fixable finding**: `spanStart`, `spanEnd` (UTF-16 offsets into content), `spanSha256` (hash of the span text). Nullable, filled only for the 4 v1 types. It stores no code text (D6). The span must cover the **whole element**. Today `extractTags` stops at the first `>` (`:331`), so `<script ...></script>` needs the matching `</script>` added. `RENDER_RE` stops at the closing quote (`:980`), so the span must extend to `%}`/`-%}`, including arguments (`, product: p`, `with x as y`).
2. **Manifest guarantee for fixes**: only fix from the **latest successful scan of the current MAIN theme**, and refuse when its manifest row is missing or the file's md5 is null. No schema change needed, but this is a gate. [I]
3. **FixRun / FixItem tables** (as in the 10-01 spike §2): FixRun (shopId, scanId, sourceThemeId, copyThemeId, copyCreatedAt, status, timestamps). FixItem (fixRunId, findingId, fingerprint, filename, preMd5, postMd5, status, reasonCode). Must be covered by shop/redact (cascade via Shop) and by prune. [I]
4. **Ambiguity count** is not needed under D6: with the checksum matching, each duplicate tag has its own finding and offset. [I]

### 2.3 Legal rewrites required (in data-integrity-suite, before the scope is added)

`terms.html:35, :99, :112` and `privacy.html:38, :42` need new wording, for example: "read-only by default; if you use Clean copy, we make an unpublished copy of your theme and remove only the lines you select in that copy; we never edit or publish your live theme." Add a "you publish the copy" clause near `terms.html:112`. `privacy.html:111/:138/:140` stay true under D6 and the ZIP path B (B builds the theme in memory and streams it without storing it; if B is chosen, add a line covering that).

## 3. API mechanics

| Item | Fact | Source |
|---|---|---|
| `themeDuplicate(id, name)` → `newTheme`, `userErrors` | write_themes + exemption. Page shows no async note, no limits, no role; error codes on a separate page (10-01: only `NOT_FOUND`) | [V] themeDuplicate page 2026-10 |
| Copy readiness | `OnlineStoreTheme.processing` "Whether the theme is processing." / `processingFailed` "Whether the theme processing failed." Poll before reading | [V] https://shopify.dev/docs/api/admin-graphql/latest/objects/OnlineStoreTheme |
| Targeted re-read | `theme.files(filenames:)` "At most 50 filenames can be specified." | [V] same |
| `themeFilesUpsert(themeId, files[])` | "You can process a maximum of 50 files in a single request." Returns `job`, `upsertedThemeFiles`, `userErrors` | [V] themeFilesUpsert page 2026-10 |
| No compare-and-set | `OnlineStoreThemeFilesUpsertFileInput` = `filename: String!`, `body: OnlineStoreThemeFileBodyInput!`. No checksum, version or precondition field. Result enum does include `CONFLICT` ("Operation faced a conflict with the current state of the file."), but nothing lets the caller supply an expected state | [V] https://shopify.dev/docs/api/admin-graphql/latest/input-objects/OnlineStoreThemeFilesUpsertFileInput , https://shopify.dev/docs/api/admin-graphql/latest/enums/OnlineStoreThemeFileResultType |
| `themePublish(id)` | write_themes + exemption; returns `theme`, `userErrors`. Not used in v1 (D2) | [V] themePublish page |
| `checksumMd5` | "The md5 digest of the theme file for data integrity." Nullable `String`. Readable with read_themes | [V] OnlineStoreTheme file object page |
| Theme cap | "Stores and organizations on the Basic, Grow, and Advanced plans can add up to 20 themes." / Plus "up to 100 themes"; Starter "can only add the Spotlight theme." | [V] https://help.shopify.com/en/manual/online-store/themes/adding-themes |
| File size | "Other Liquid files (sections, snippets, layouts) | 256 KB"; JSON template 512 KB; settings_data 1.5 MB; assets 20 MB; ZIP upload 50 MB compressed | [V] https://shopify.dev/docs/storefronts/themes/architecture/limits.md , theme-check max-file-size |
| Rate limit | Standard 100 pts/s, Advanced 200, Plus 1000; mutation base cost 10 | [V] https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits.md |

Rate-limit impact: a typical fix is 1 duplicate + polling + 1-3 file reads + 1 upsert (≤50 files) + 1 re-read. That is far below the bucket. Reuse `paginateConnection`/throttle backoff (`theme-fetcher.server.ts:8-10`). [I]

### Drift guard design (no CAS, so we bracket the write)

Per file, inside one Inngest step: [I]
1. **Pre-flight (MAIN):** the scan is the latest successful scan of the current MAIN, and `MAIN.updatedAt` is not later than `scan.completedAt` (reuse `stale-results.ts`). Refuse the whole run if not: "Your theme changed since the scan. Rescan first."
2. **Pre-read (copy):** `files(filenames:[f])` on the copy. Require `checksumMd5 === manifest md5(f)` and `md5(utf8(body)) === checksumMd5` (checks our md5 assumption on every write). On mismatch, skip the file with `FILE_CHANGED`.
3. **Locate:** re-run the same detector on the body and match on fingerprint + appName + type. Require `sha256(body.slice(spanStart, spanEnd)) === spanSha256`. Otherwise `SPAN_MISMATCH`, skip.
4. **Splice + validate:** remove the spans from the highest offset to the lowest. Validate (Liquid `{% %}` balance unchanged apart from removed tags, no unclosed `<script>`, size under the limit). Otherwise `VALIDATION_FAILED`.
5. **Write:** `themeFilesUpsert` with the expected new md5 computed locally. Poll `job` until done. [I job polling]
6. **Post-read:** require copy `checksumMd5 === expectedNewMd5`. Otherwise mark `POST_WRITE_MISMATCH`, flag the run "do not publish", and show it in the UI.

Residual race: someone edits the **copy** between steps 2 and 5. The window is about a second, on a theme we created minutes earlier, and step 6 catches it. **Stale-copy risk** (the merchant edits MAIN after the copy is made, then publishes the copy and loses those edits) is not a write race. Handle it with a banner whenever `MAIN.updatedAt > FixRun.copyCreatedAt`: "Your live theme changed after this clean copy was made. Make a new copy." Also use the `themes/publish` webhook (`shopify.app.toml:27`) to mark the run as published or superseded. [I]

## 4. v1 scope

**Fixable (D3):** GHOST_SCRIPT, GHOST_STYLE, GHOST_PRECONNECT (rel `preconnect|dns-prefetch|preload`, `scan-engine.server.ts:5464`), GHOST_SNIPPET (`{% render/include %}` tag form and bare `{% liquid %}` line form; **do not** delete the snippet file). These are exactly the `safe-to-remove` set (`finding-safety.ts:61-69`) and are all `signature` (`finding-classification.ts:182`). On d01d752 (`git show d01d752 --stat`: `finding-safety.ts` +149, `app.scans.$scanId.tsx` +20, `tests/lib/finding-safety.test.ts` +122) the same 4 were the safe-to-remove set, and MALICIOUS_SCRIPT was added to that set later. Today MALICIOUS_SCRIPT is `security-risk` [V].

Additional v1 gates [I]:
- Fixable set = `safe-to-remove ∩ signature ∩ v1 allowlist`. A unit test asserts this, so a future relabel cannot widen the fix path silently.
- Files limited to `layout/`, `sections/`, `snippets/`, `templates/`, `blocks/` with `.liquid` extension. `assets/`, `config/` and `locales/` are excluded.
- Skip ignored findings (INSTANCE/APP scope). Skip apps with an enabled embed (D5). Skip findings inside Liquid comments (GHOST_SCRIPT/STYLE today do **not** apply `buildCommentSkipLines`; removing commented code is harmless but surprising, so refuse in v1).
- MAIN themes only, no Canvas (D9).

**Explicit exclusions:** MALICIOUS_SCRIPT, APP_INCIDENT_ADVISORY and MENU_INJECTION (security-risk: show guidance only). Any JSON edit (settings_data.json, templates/*.json, GHOST_APP_EMBED, SETTINGS_DRIFT). File deletes (ORPHAN_ASSET, snippet files, GHOST_LAYOUT). All verify-first and leave-alone types. Admin-resource types (they need other write scopes). LIQUID_ERROR_RENDERED: Store Safety's "render calls to snippets that no longer exist" overlaps it, but it is verify-first, so it is a v1.5 candidate, not v1.

**Competitors** (listing text read 2026-11-03; behavior **unverified** beyond the listings):

| App | Listing claim (verbatim) | Access shown | Price | Launched / reviews |
|---|---|---|---|---|
| Store Safety: Backup & Restore | scanner "finds code uninstalled apps left behind" and "removes it after you approve", backup first; dev post: "with the theme backed up first" (Community 705506, 2026-10-27). Live vs copy: not stated | "Edit Online Store: Online Store pages, theme" (+ products, navigation) | Free / $9 / $19 mo | 2026-10-27 / 0 |
| ThemeSweep | "remove it in one click, on a duplicated theme with a full backup and one-click rollback"; "quarantine it to comment code out"; backups "retained for 30 days" | "Edit Online Store: Theme" | Free / $9.99 / $19.99 / $39.99 mo | 2026-09-07 / 0 |
| Residue | "A backup of your theme is created before any change"; "Confirm, then download a clean copy. Upload it as a draft." | **View only** ("View Online Store: Theme") | $49/yr | 2026-07-03 / 0 |
| BloatBuster | "clear step-by-step excision guides" (guided, no automatic deletion claimed) | View and edit Online Store incl. theme | $2.99 mo (was $6.99 in the 10-01 note) | 2026-09-16 / 0 |

Sources: https://apps.shopify.com/store-safety , https://community.shopify.com/t/705506 , https://apps.shopify.com/themesweep , https://apps.shopify.com/theme-residue-cleaner , https://apps.shopify.com/bloatbuster-clean-theme-code . Read: Store Safety's exemption probably rests on the **backup** category (it backs up products, pages and every theme file), which does not transfer to us. ThemeSweep's duplicate-theme model is the closest analogue to path A. Residue is the existence proof for path B. [I]

## 5. Slice plan

Each slice ends green under `agent-gate.sh` with frozen existing tests. Security/write-path slices (2, 4) are Opus-built per routing; slices 1, 3, 5 are builder-eligible once Opus writes the failing acceptance tests.

| # | Slice | Needs exemption? | Test plan |
|---|---|---|---|
| 0 | **Day 1:** file the form for both records (owner). Read-only dev-store probe: compare `checksumMd5` with `md5(utf8(body))` across about 50 files incl. non-ASCII (read_themes only, allowed) | No | Probe script output kept in scratch. If md5 ≠ Shopify checksum, step 2 of the drift guard falls back to Shopify-to-Shopify comparison only |
| 1 | **Span model**: the 4 detectors return `spanStart/spanEnd` (full element/tag, see §2.2). Pure, behind a new exported helper; findings unchanged | No | Fixtures (each asserts exact span text): tag split across lines; attributes in either order; `<script src></script>` with whitespace or content between; self-closing `<link/>`; missing `</script>` → no span; `>` inside a Liquid expression within the tag (`{% if a > b %}`) → no span; `<script` inside a JS string (`document.write('<script src=…')`) → no span; `{%- render 'x' -%}` and `{% render 'x', product: p %}` and `with … as …`; bare form inside `{% liquid %}`; tag on a minified 100 KB single line; CRLF line endings; BOM; non-ASCII before the tag (UTF-16 offset correctness); full-width/lookalike `＜script` (must not match). Regression: existing detector suites unchanged |
| 2 | **Splice engine** (pure): `(content, spans[]) → {newContent, removed[], refused[]}`. Removes spans highest-first, collapses a line left empty, keeps whitespace-control semantics. Validation pass | No | Fixtures: **duplicate identical tags** (remove 1 of 2 by offset, the other stays); two spans on one line; overlapping spans → refuse; span inside `{% comment %}`/`{% doc %}`/`{% raw %}`/`{%# … %}` inline comment → refuse; **whitespace-control**: removing `{%- render -%}` between text nodes, asserting the output and documenting that neighbor whitespace changes; tag inside `{% if %}` leaving an empty branch (allowed); idempotency (re-run on output → 0 removals, "already clean"); size cap; output re-scanned by the detector → finding gone, no new findings. Property test: random non-span bytes never change |
| 3 | **Schema**: Finding span columns (nullable), FixRun/FixItem, redact/prune coverage; detectors persist spans for new scans | No | Migration additive and reversible; shop/redact deletes FixRun/FixItem (test via `deleteShopData`); prune test; old scans with null spans → "rescan to enable Clean copy" |
| 4 | **Orchestrator** (Inngest): preflight → duplicate → poll processing → per-file guard (§3) → upsert ≤50 → poll job → post-read. Admin client **mocked** | No (mocked) | **Outcomes list**, each one tested: *preflight* (ok / not Pro / scope not granted / scan stale / manifest missing / theme cap reached / Canvas / Starter plan); *duplicate* (ok / userError / processingFailed / timeout → run FAILED, nothing written); *per file* (ok / **file changed between scan and fix** → FILE_CHANGED / span hash mismatch / validation fail / upsert userError / job timeout / post-read mismatch → "do not publish"); *run* (all ok / partial "7 of 9" / none / **interrupted mid-run then Inngest retry** → idempotent, no second duplicate, done items skipped via (copyThemeId, fingerprint)); MAIN is never written (assert no mutation targets the MAIN id); ACCESS_DENIED → clear "exemption/scope" error, no retries |
| 5 | **UI** (Polaris): selection (only fixable findings selectable, default unchecked), per-app "I've uninstalled X" confirm, per-file diff, results, preview link (`?preview_theme_id=`) + theme editor link (`app/lib/theme-editor-url.ts`), stale-copy banner, optional-scope request on click | No | Loader/action tests; one-ask rule unaffected; copy reviewed against style guide; diff renders minified lines truncated safely |
| 6 | **Legal + listing + docs**: terms/privacy rewrite, product-strategy `:37`/`:158-160`, listing data-access note, `write_themes` added to `optional_scopes` **only after approval** | No (drafts); scope add waits | Legal agent review; diff against §2.3 list |
| 7 | **Live dev-store run** on both app records: real duplicate, write, re-read; probes: optional-scope grant flow, duplicate keeps checksums, invalid Liquid rejected or not, cap error code, CONFLICT behavior | **Yes** | Manual script on a dev store with seeded leftovers covering the slice-1 fixtures; verify preview renders and MAIN untouched (checksums before and after) |

Then: adversarial audit over the batch (security-guard scope and feature-logic scope separately). Deploy is gated on approval for both records + legal live + slice 7 green. Sizing unchanged from 10-01: M-L, about 2-3 focused weeks; slices 1-3 are about 4-5 days of that.

**Pre-approval build answer:** everything in slices 1-6 can be built and fully tested before approval (pure functions + mocked Admin client + UI). Slice 0's read probe is allowed now. A custom-distribution or test app does **not** remove the need for the exemption, as far as current sources show (§1.5). The only pre-approval way to test end to end on a real store is path B (export a cleaned ZIP and upload it by hand to a dev store), which is a reason to keep B's engine shared (D1).
