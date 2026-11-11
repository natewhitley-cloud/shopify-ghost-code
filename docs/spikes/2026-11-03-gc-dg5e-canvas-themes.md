# Spike gc-dg5e: Canvas themes, can GhostCode scan them, and what breaks

Date: 2026-11-03 (all "accessed" dates below are 2026-11-03). Method: docs only. No dev store, no Shopify CLI, no live API calls. Where an answer needs a live check it is marked `unknown` and the query is in "Live checks for Nathan".

Confidence scale: **verified** = a Shopify-authored source says it, quoted verbatim from the fetched page. **inferred** = my reasoning from verified facts plus our code. **unknown** = no source found.

Fetch note: help.shopify.com Canvas pages, changelog.shopify.com, community.shopify.dev thread 38212, and shopify.dev `agentic-workflows.md` were fetched raw (curl) so quotes are exact page text. shopify.com/news, the Editions page, and the shopify.dev API reference pages were read through a page-summarizing fetch tool (quotes it returned as quoted text; the themeDuplicate and themeFilesUpsert access sentences were re-checked raw from the `.md` versions).

## Summary

1. **Biggest finding:** Shopify staff said on 2026-10-01 that "Themes edited in Canvas also won't appear when your app lists a store's themes." That is the `themes` query our scanner uses (`fetchMainTheme`, `fetchAllThemes`). If it holds, GhostCode cannot list, let alone read, a Canvas-edited theme. A third-party developer confirmed the same behaviour on 2026-10-02 ("Canvas themes don't show up in the Admin API at all currently"). No Shopify doc contradicts this, but nobody has tested whether `theme(id:)` or `files` works if you already hold an ID. Unknown until Nathan runs the live checks.
2. **Detection:** no documented API field marks a theme as Canvas. The only documented marker is a "Canvas" badge in the admin theme library (UI only). The practical signal is indirect: the theme is absent from `themes`.
3. **Detectors:** every app-attributed detector requires a known-app signature (URL, snippet name, filename), so Sidekick-written Liquid should rarely trigger them. Structural detectors that need no app signature (DUPLICATE_META, GHOST_TITLE, GHOST_CANONICAL, DUPLICATE_LIBRARY, LIQUID_ERROR_RENDERED) are the plausible false-positive path. Untested.
4. **gc-tib:** `themeDuplicate` and `themeFilesUpsert` docs do not mention Canvas. Our clean-copy flow starts from the MAIN theme found via `themes(roles: MAIN)`. If the published theme is Canvas-edited it is probably not findable, so clean-copy removal likely cannot run on those stores. Non-Canvas stores are unaffected. Early access is limited ("certain stores"), so the blind spot is small today and growing.
5. Reach is unknown: Shopify gives no store counts. Only "certain stores", launched 2026-10-01, rolling out "over the coming days".

## Q1. Can the Admin API (read_themes) list and read a Canvas theme's files?

**Answer: probably no for listing; unknown for reading by ID.** Confidence: **verified** that Shopify staff say Canvas-edited themes are not listed; **unknown** whether `theme(id:)` / `files` works if the ID is known; **unknown** for REST assets (we do not use REST; blocked for new apps).

Evidence:

- Source: https://community.shopify.dev/t/meet-canvas-a-new-way-for-merchants-to-design-their-online-store-with-sidekick/38212 (post #1, by Jordan_Graham, user title "Shopify Staff" in the thread JSON)
  Quote: "Themes edited in Canvas also won't appear when your app lists a store's themes."
  Date: posted 2026-10-01 14:04 UTC; accessed 2026-11-03. Raw JSON via `/t/38212.json`. Confidence: high that this is Shopify's stated position at launch. The post is 33 days old and the thread is still open (last post 2026-11-01), so it may have changed. No later staff correction in the 44 posts.
- Same thread, post by Eng1neer (third-party developer, not staff), 2026-10-02 09:59 UTC.
  Quote: "I understand Canvas themes don't show up in the Admin API at all currently, so we can't see what's inside them."
  Confidence: low-medium (a developer's understanding, matching the staff post). No reply from Shopify to this question.
- The `themes` query reference does not mention Canvas. Source: https://shopify.dev/docs/api/admin-graphql/latest/queries/themes (accessed 2026-11-03). Quote: "Returns a paginated list of `OnlineStoreTheme` objects for the online store." No exclusion is documented, so the staff post is the only statement. Confidence: verified that the docs are silent.
- `OnlineStoreTheme.files` exists with "At most 2500 can be fetched at once." and `first` default 50 (https://shopify.dev/docs/api/admin-graphql/latest/objects/OnlineStoreTheme, accessed 2026-11-03). Nothing Canvas-specific.
- Conflicting/ambiguous signal: https://shopify.dev/docs/storefronts/themes/agentic-workflows.md says of theme context files: "the design decisions that Sidekick records come back to you the next time you pull the theme." and lists "GraphQL Admin API: Read the files through the `files` connection on the `OnlineStoreTheme` object". This is about AGENTS.md / DESIGN.md generally, not a statement that Canvas-edited themes are readable. It sits in tension with the help-center line "You can't download the theme files for a theme that you edited in Canvas." Treat as unresolved. Confidence: unknown.
- Download restriction (merchant side): https://help.shopify.com/en/manual/online-store/themes/canvas/requirements, accessed 2026-11-03. Quote: "You can't download the theme files for a theme that you edited in Canvas." This is the merchant download feature; it does not say the API is blocked.

What this means for us (inferred): `fetchMainTheme` (`themes(first: 1, roles: MAIN)`, `app/services/theme-fetcher.server.ts:60-68`) would return no node, and the manual scan action returns `"No published theme found. Please publish a theme before scanning."` (`app/routes/app._index.tsx:1080`). The themes/publish webhook logs "no MAIN theme found via API, skipping auto-rescan" and returns 200 (`app/routes/webhooks.themes.publish.tsx`, line 116). So the failure is silent and the merchant-facing message would be wrong (they have a published theme).

## Q2. How do we detect that a store is on Canvas?

**Answer: no documented API field. Candidate signals are indirect.** Confidence: **verified** for what is documented; **inferred** for the proposed signals; **unknown** for any undocumented field.

- `OnlineStoreTheme` fields are `createdAt, files, id, name, prefix, processing, processingFailed, role, themeStoreId, translations, updatedAt`; nothing Canvas-related. Source: https://shopify.dev/docs/api/admin-graphql/latest/objects/OnlineStoreTheme, accessed 2026-11-03.
- `ThemeRole` values: ARCHIVED, DEMO, DEVELOPMENT, LOCKED, MAIN, UNPUBLISHED, MOBILE (deprecated). No Canvas role. Source: https://shopify.dev/docs/api/admin-graphql/latest/enums/ThemeRole, accessed 2026-11-03.
- UI-only marker. Source: https://help.shopify.com/en/manual/online-store/themes/canvas/customizing (accessed 2026-11-03). Quote: "Themes edited in Canvas display a Canvas badge in your theme library."
- Created-in-Canvas themes carry `AGENTS.md` and `DESIGN.md` at the theme root. Quote (same page): "Themes that you create in Canvas include two files that Sidekick reads before it makes a change." Also https://shopify.dev/docs/storefronts/themes/agentic-workflows/agents-md (accessed 2026-11-03, via fetch tool): "Themes created with Canvas include the base theme's `AGENTS.md`". This is a content signal only usable if the files are readable (Q1 unknown), and it does not cover themes that were merely duplicated and edited (those inherit the source theme's files). Non-Canvas themes can also carry these files (Shopify CLI 4.8.4 pulls and pushes them).

Proposed detection (inferred, needs live validation):

1. Compare what the admin shows against what `themes` returns. We cannot see the admin UI from the app, so this is only useful in the spike.
2. In the app: if `themes(roles: MAIN)` returns zero nodes while the shop is installed and the storefront responds with HTML, treat as "published theme not readable, possibly Canvas". Cross-check with the `themes/publish` webhook payload, which includes the theme id (payload.id is already read at `webhooks.themes.publish.tsx`). If the webhook fires for a Canvas publish and the id is not in `themes`, that is a strong signal. Whether the webhook fires for Canvas publishes is **unknown**.
3. Look for `AGENTS.md`/`DESIGN.md` in `files(filenames: [...])` on listed themes (weak, see above).

## Q3. Would our detectors misfire on Sidekick-written custom Liquid?

**Answer: low risk for app-attributed detectors, moderate plausible risk for structural detectors. Untested.** Confidence: **inferred** (code reading only; no fixture run). Sidekick output format is not documented beyond "the new liquid file for the block is added to the blocks folder".

What Shopify says about the code:

- Source: https://help.shopify.com/en/manual/online-store/themes/customizing-themes/theme-editor/sidekick/generate-blocks (accessed 2026-11-03, raw). Quote: "the new liquid file for the block is added to the blocks folder in your theme's code." Also: "AI-generated code may not always be perfect. It can sometimes produce errors, unexpected results".
- Canvas: https://www.shopify.com/news/introducing-canvas (published 2026-10-01). Quote: "Sidekick now works directly on the theme's files, guided by instructions and skills for building stores." It edits files across templates, not only `blocks/`.
- Filename conventions, header comments, or other markers for generated blocks: **not found** (this matters for gc-n3ot's step 1).

Code reading (all in `app/services/scan-engine.server.ts` unless noted):

| Detector | Needs a known-app signature? | Misfire path with Sidekick code | Risk |
|---|---|---|---|
| GHOST_SCRIPT / GHOST_STYLE (`detectGhostScripts` ~850, `detectGhostStyles` ~922) | Yes: `identifyAppFromUrl(url) ?? identifyAppFromCode(url)`; "it never manufactures a finding from the filename alone" | Only if Sidekick writes a `<script src>` to a known app's CDN | Low |
| GHOST_SNIPPET / GHOST_SECTION (~996, ~1066) | Yes: `identifyAppFromSnippetName(snippetName, corroboratedApps)` returns an app or nothing | Only if Sidekick renders a snippet whose name matches an app signature (generic names are gated by corroboration, gc-c4k) | Low |
| ORPHAN_ASSET (~6108-6128) | Yes: `appName = identifyAppFromSnippetName(...); if (!appName) continue;` | Sidekick-created unreferenced snippets are dropped unless the name looks like an app | Low |
| MALICIOUS_SCRIPT (`detectMaliciousScripts` ~2298) | Host list match | Only if generated code loads a listed host | Low |
| unknown external scripts/styles (`collectUnknownScripts` ~3348) | No, but these are collected as "unknown resources", not findings (benign libs dropped) | Sidekick adding a CDN script surfaces as an unknown resource | Informational |
| DUPLICATE_META (`detectDuplicateMetaTags` ~1263), GHOST_TITLE (~5058), GHOST_CANONICAL (~4628), GHOST_OG (~5338), GHOST_ROBOTS | No app signature needed for the duplicate case: "multiple meta tags with the same name or property attribute in a single file"; GHOST_TITLE flags a 2nd title tag in the same file | A Sidekick edit to `layout/theme.liquid` that adds a meta/title/canonical tag next to an existing one. Conditionals are skipped, so the risk is unconditional duplicates | Medium (plausible, untested) |
| DUPLICATE_LIBRARY (`detectDuplicateLibraries` ~3704) | Library name + major version | Sidekick adding a pinned CDN library at a different major than the theme's own | Medium (plausible) |
| LIQUID_ERROR_RENDERED (`liquid-error-detector.server.ts`) | Needs the error printed on the homepage AND a theme file rendering a missing snippet | Sidekick referencing a snippet it did not create, shown on the page. This would be a true positive about a real error, not a false positive | Low (and arguably correct) |
| DANGLING_REFERENCE (`dangling-reference-extractor.server.ts`) | Literal `/products/<handle>` etc. resolved against the shop | Sidekick hardcoding a product/collection handle that exists: no finding; one that is wrong: true finding | Low |
| GHOST_LAYOUT / SETTINGS_DRIFT | Orphan layout / settings entry whose section file is gone | Sidekick deleting a section but leaving a `settings_data.json` entry. Soft-launched per the code comment | Low-medium |

Context: the open uninstall driver is false positives (gc-tib note: "2 of last 3 uninstalls FP-driven (gc-6lm, gc-01n)"). I did not run any Sidekick fixtures; the safe claim is "app-attributed detectors cannot fire without an app signature", not "no false positives".

Related unknown: Canvas-created themes are on a "new theme architecture" (Editions: "Compose pages in Liquid with blocks, typed contracts, and partial updates. Guide agents with markdown files, and get Tailwind styling built in." and "The new way to edit online stores is built on this theme architecture."). Whether those themes use new Liquid tags (`block`, `partial`) or Liquid templates instead of JSON templates, and whether our `isScannableFile` prefixes (`templates/ sections/ snippets/ layout/ blocks/`, `scan-engine.server.ts:556-561`) cover the new layout, is **unknown**. The only description of new tags I found was a secondary repost of a July 2026 article (unverified). That belongs to gc-08x8 item 3.

## Q4. What happens to leftover app code when a merchant moves to Canvas?

**Answer: unknown for existing leftover code. Documented only for app blocks/embeds ("won't be available").** Confidence: **unknown** (no Shopify source says whether duplicated files are copied verbatim, or whether Sidekick rewrites/removes them).

What is documented:

- Source: https://changelog.shopify.com/posts/design-a-fully-bespoke-store-with-canvas (2026-10-01, raw). Quote: "Go to Online Store > Themes to create a new theme in Canvas, or duplicate a Shopify theme or custom theme in Canvas. Your original theme stays in the current theme editor."
- Same page. Quote: "Themes edited in Canvas don't receive theme updates."
- Source: https://help.shopify.com/en/manual/online-store/themes/canvas/customizing (accessed 2026-11-03). Quote: "When you duplicate a supported theme in Canvas, a copy of the theme opens in Canvas." and "The two themes are separate, so changes that you make to one theme aren't added to the other."
- App-side: community.shopify.dev thread 38212, post #1 (2026-10-01). Quote: "If a merchant creates or duplicates a theme in Canvas, your app's blocks and embeds won't be available in that theme for now." Staff reply (Nick_Lepine, 2026-10-01 18:20 UTC): "For the short period where apps won't be supported in Canvas, Sidekick is aware and handles this gracefully." (Attached screenshot not readable.)
- Staff ETA for theme app extension support: Nick_Lepine, 2026-10-01 16:22 UTC: "We plan to support theme app extensions in Canvas within the next few weeks." As of 2026-10-24 a developer (nunof) was still asking for an ETA, and on 2026-11-01 David_Arbias reported Canvas saying "theme app extensions are not compatible with canvas" (developer report, unverified). I found no changelog entry announcing support (checked shopify.dev changelog listing and a web search on 2026-11-03).

Inferred (not documented):

- A "duplicate in Canvas" copy is a theme-files copy, so non-extension leftovers (snippets, `{% render %}` tags, script tags in `theme.liquid`, JSON-template app blocks) most likely come along as ordinary files. Nothing says they are stripped. Whether app block references in JSON templates are kept, dropped, or shown as unavailable blocks is unknown.
- Because Canvas themes "don't receive theme updates" and cannot use app blocks, a merchant who moves to Canvas and later uninstalls an app will have no editor path (no app blocks UI) to remove its leftovers, only Sidekick or the code editor (staff need "Online store > Themes > Edit code" permission to open Canvas; whether the code editor opens a Canvas theme is unknown).
- A real value-add scenario for GhostCode: leftover code in a theme that is then duplicated into Canvas. Needs the live test below.

## Q5. Can themeDuplicate / themeFilesUpsert operate on a Canvas theme?

**Answer: unknown. The docs do not mention Canvas, and the Canvas theme probably cannot be discovered through `themes`.** Confidence: **verified** for the access requirements; **unknown** for Canvas behaviour.

- Source: https://shopify.dev/docs/api/admin-graphql/latest/mutations/themeDuplicate.md (raw, accessed 2026-11-03). Quote: "Requires The user needs write\_themes and an exemption from Shopify to modify themes." Description: "Duplicates a theme." No Canvas mention.
- Source: https://shopify.dev/docs/api/admin-graphql/latest/mutations/themeFilesUpsert.md (raw, accessed 2026-11-03). Quote: "Requires The user needs write\_themes and an exemption from Shopify to modify theme files." and "You can process a maximum of 50 files in a single request." No Canvas mention.
- UI-side behaviour: https://help.shopify.com/en/manual/online-store/themes/canvas/requirements: "A theme that you edit or create in Canvas opens only in Canvas. You can't edit it in the theme editor." A copy made by the API is a normal theme (per our 2026-10-01 spike), so an API-made copy of a non-Canvas theme is not a Canvas theme and stays editable in the theme editor. That keeps gc-tib's existing design (duplicate MAIN, edit the copy, merchant previews and publishes) valid for non-Canvas MAIN themes (inferred).
- If the MAIN theme is Canvas-edited: `themes(roles: MAIN)` probably returns nothing (Q1), so we have no ID to duplicate. If an ID were obtained some other way (webhook payload), whether `themeDuplicate` accepts it, and whether the result opens in the theme editor or only in Canvas, is unknown.
- Also unknown: whether a write to a Canvas theme from an app is rejected, silently succeeds, or desynchronizes Sidekick/Canvas state (Canvas keeps version history: "review and restore earlier versions of the theme" in the navigating page).
- Note the scope/exemption gate is unchanged by Canvas: gc-tib's exemption blocker (write_themes + Online Store Protected Scope Exemption) stands regardless.

## Q6. Early-access reach, rollout dates, Editions notes

**Answer: no numbers published. Launched 2026-10-01, "certain stores", desktop only, rolling out over days.** Confidence: **verified** for what is quoted; **unknown** for store counts and eligibility beyond the listed requirements.

- Launch date: https://www.shopify.com/news/introducing-canvas, "October 1, 2026 by Shopify". Quote: "Rolling out over the coming days, Canvas is a new design surface where merchants build with Sidekick". Also: "We're early here and Canvas is not replacing the existing editor yet." (Ben Sehl).
- Changelog: https://changelog.shopify.com/posts/design-a-fully-bespoke-store-with-canvas, October 01, 2026. Quote: "Canvas is rolling out to existing stores over the coming days."
- Eligibility: https://help.shopify.com/en/manual/online-store/themes/canvas/requirements (accessed 2026-11-03). Quotes: "Canvas is in early access and is available only to certain stores."; "Canvas is available only on desktop devices."; "Canvas is available on plans that include theme customization."; "Canvas works only with themes developed by Shopify and with custom themes. Third-party themes aren't supported."; "Your staff need the Online store > Themes > Edit code permission to open Canvas."
- Canvas limits (same page): "You can't add or configure app blocks or app embeds in Canvas."; "You can't customize a theme for different markets in Canvas."; rollouts: "You can add a theme that you edited in Canvas to a rollout as a replacement for your main theme."
- Editions: https://www.shopify.com/editions/fall2026 (accessed 2026-11-03; the page does not state its own date). Quotes: "Design your entire store in Canvas, zoom into any detail, and work with Sidekick to turn ideas into a fully custom design." and "From no theme to a launched store 20% faster with Canvas". Editions gives no availability date and no eligibility for Canvas. Related: "Apps can no longer create or update script tags and must migrate to theme app extensions or web pixels." (gc-pa3q territory, noted only.)
- Store counts: **not found.** The only usage number is "more than twenty-five million edits to themes in the first half of 2026" (Sidekick in general, not Canvas). Secondary blogs repeat the limits (e.g. TechCrunch via a blog) and are unverified.
- Developer reports of live merchant impact (unverified, community.shopify.dev 38212): 2026-10-24 nunof: "We are starting to get more contacts from merchants and for some of them is quite confusing the fact that apps don't work with Canvas." This is evidence that real merchants are on Canvas, but not how many.

## Live checks for Nathan

Prereq: a dev store with Canvas access (early access is "certain stores"; may need Partner/Shopify contact or an existing eligible store) and our app installed with `read_themes`. Run via the app's GraphiQL, or `shopify store execute` (I could not verify the CLI flags; check `shopify store execute --help`). Use the API version the app pins (`shopify.app.toml` `api_version`, 2026-07 at the time of the 2026-10-01 spike).

Setup in the admin first: (a) note the theme list on Online Store > Themes, including any with the "Canvas" badge; (b) create theme X with leftover app code in `layout/theme.liquid` (e.g. a stale `<script src>` for a known app and a `{% render 'klaviyo-form' %}`), published; (c) "Duplicate in Canvas" X to make X-canvas; make one trivial Sidekick edit to X-canvas and ask Sidekick to add a custom Liquid block; (d) publish X-canvas in a second run.

**Check A: does `themes` list the Canvas theme?**

```graphql
query CanvasListCheck {
  themes(first: 50) {
    nodes { id name role processing processingFailed updatedAt themeStoreId }
    pageInfo { hasNextPage endCursor }
  }
}
```

- X-canvas missing, X present: confirms the staff statement. Q1 = cannot list.
- X-canvas present: the staff statement is stale; continue to Check C. Record `role` and `name` for detection ideas.

**Check B: published Canvas theme and the MAIN query (our actual code path)**

```graphql
query CanvasMainCheck {
  themes(first: 1, roles: MAIN) { nodes { id name role updatedAt } }
}
```

Run after publishing X-canvas (step d).
- Empty nodes: the "No published theme found" error will show for this merchant; need a blind-spot notice. Also see whether the `themes/publish` webhook still fires (check logs for `webhooks.themes.publish`) and what `payload.id` is.
- Returns X-canvas: Canvas themes are readable when published; go to Check C.

**Check C: can files be read by ID?** Get X-canvas's numeric ID from the Canvas admin URL (if it shows one) or from Check A/B.

```graphql
query CanvasFilesCheck($id: ID!) {
  theme(id: $id) {
    id name role
    files(first: 250) {
      nodes { filename size checksumMd5 updatedAt
              body { ... on OnlineStoreThemeFileBodyText { content } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

Variables: `{"id": "gid://shopify/OnlineStoreTheme/<id>"}` (our code receives GIDs from the list; use the same shape it returns).
- `theme` null or access error: Canvas themes are unreadable by ID. Q1 = blind spot confirmed.
- Files returned: compare the list with the code editor (Online Store > Themes > Edit code, if it opens a Canvas theme) and with `AGENTS.md`/`DESIGN.md`. Confirm the leftover code from step (b) is present (answers Q4 "kept"), and check whether `blocks/*` shows Sidekick's custom block (answers filename/header conventions for gc-n3ot).

**Check D: context files and generated blocks only (cheap, small)**

```graphql
query CanvasMarkers($id: ID!) {
  theme(id: $id) {
    files(filenames: ["AGENTS.md", "DESIGN.md", "blocks/*"], first: 50) {
      nodes { filename size updatedAt }
    }
  }
}
```

Also run it on the ordinary theme X to see whether the markers are Canvas-specific.

**Check E: scanner run on an ordinary non-Canvas theme that Sidekick edited via the theme editor** (not Canvas): generate a block from the theme editor (help page above), then run a GhostCode scan and record all findings on `blocks/<generated>.liquid`. This answers Q3 for real. Also add a Sidekick edit to `layout/theme.liquid` that adds a `<meta>`/`<title>`/canonical tag and scan again.

**Check F: gc-tib duplicate/upsert on a Canvas theme (needs an app with `write_themes` and the exemption, so likely a dev-store-only custom app)**

```graphql
mutation DupCanvas($id: ID!) {
  themeDuplicate(id: $id, name: "gc-dg5e probe") {
    newTheme { id name role processing }
    userErrors { code field message }
  }
}
```

- `userErrors` with `NOT_FOUND`/access: not possible on Canvas themes.
- Success: open the new theme in the admin. If it carries the Canvas badge and opens only in Canvas, the copy would be unreadable by us again. If it opens in the theme editor, a clean copy of a Canvas theme is feasible. Then try a single `themeFilesUpsert` to the copy (one file) and check whether Canvas shows or loses the change.

**Check G: do app blocks survive duplication?** In step (c), before duplicating, add an app block (some app with theme app extensions) to X's JSON template, then duplicate in Canvas and diff `templates/*.json` between X and X-canvas via Check C. This answers whether app block references are kept or dropped.

## Recommendation (facts-based; orchestrator decides)

**gc-n3ot (AI-generated theme code: inventory + health check): adapt, and hold the scheduling.**
- Reason: its step 1 premise ("whether Canvas themes are distinguishable") now has a documented answer: no API field, UI badge only, and possibly invisible to `themes` altogether. The Canvas-theme "no theme updates" informational finding (candidate check 3) cannot be built unless Check A/B/C show Canvas themes are readable. The generated-block inventory part (candidate checks 1 and 2) still applies to non-Canvas themes edited via the theme editor, where the output lands in `blocks/`.
- Unblocking evidence: Check D/E (marker for generated blocks) decides whether inventory is possible. No marker was found in docs.

**gc-08x8 item 3 (new theme architecture, scanner compatibility): keep as a spike; add Canvas-readability as its first gate.**
- New themes created in Canvas are built on the new architecture and may be unreadable anyway (Q1), so scanner compatibility testing with a preview theme depends on Check A-D. Unknown: directory layout and any new Liquid tags. That investigation stays in gc-08x8; I did not chase it.

**New work implied by this spike (feature candidate, not a decision):**
- A "published theme not readable" state: today the merchant sees `"No published theme found. Please publish a theme before scanning."` and the publish webhook skips silently. If Check B confirms an empty MAIN for Canvas stores, that message is wrong and could drive uninstalls. Candidate scope: detect empty MAIN while the shop is otherwise healthy, show an explicit Canvas/unsupported notice, and disclose the blind spot in the listing and docs. Could optionally fall back to storefront-HTML analysis (the storefront scanner already exists, but `fetchStorefrontContext` requires the scanned theme to be MAIN via `theme(id).role`, `storefront-fetcher.server.ts:296-335`, so it would need a theme-less path).
- Stale-theme risk (inferred): after a merchant publishes a Canvas theme, `themes` may still list their old theme as UNPUBLISHED, and the theme picker (`getCachedAllThemes`) would let them scan a theme that is no longer live, producing results that read as current. Worth a check in Check A.

**gc-tib blockers/notes (design is another agent's; facts only):**
- Not a blocker for building. Clean-copy removal works only if the MAIN theme is visible to `themes(roles: MAIN)`. If it is a Canvas-edited theme, treat the shop as out of scope for removal and say so in the UI (no scan results exist for it either).
- Add a guard: refuse removal when MAIN is not found; do not fall back to another theme.
- Unknown and test before shipping: whether `themeDuplicate` can copy a Canvas theme and whether the copy is editable outside Canvas (Check F). Also whether API writes to a Canvas theme conflict with Canvas version history.
- Exemption gate (`write_themes` + exemption) is unchanged by Canvas. Built for Shopify 3.2.2 (from the 2026-10-01 spike) is not affected by anything found here.
- Product angle: after a merchant moves to Canvas, app blocks cannot be added or configured and they cannot download the theme. For those stores, the only removal path for leftover code is the code editor or Sidekick, so Residue/ThemeSweep/BloatBuster-class tools face the same blindness; this may be a differentiator only if Canvas themes turn out to be readable and writable via the API.

## Claims rated unknown

1. Whether `theme(id:)` / `files` returns data for a Canvas-edited theme when the ID is known.
2. Whether any REST asset endpoint reaches Canvas themes (REST not usable by us; not researched).
3. Any API field, role, or metadata that identifies a Canvas theme.
4. Whether the `themes/publish` webhook fires when a Canvas theme is published, and what the payload id maps to.
5. What `themes(roles: MAIN)` returns when the published theme is Canvas-edited (staff say Canvas-edited themes don't appear in lists; MAIN behaviour not stated).
6. Whether "Duplicate in Canvas" copies existing leftover app code, snippets, and JSON-template app block references unchanged, or Sidekick strips them.
7. Whether `themeDuplicate` or `themeFilesUpsert` work on a Canvas theme, and what the result is.
8. Filename, folder, or header-comment markers on Sidekick-generated blocks (beyond "the blocks folder").
9. Number of Canvas-eligible stores, number of stores that have used Canvas, and eligibility rules beyond "certain stores".
10. Whether the code editor opens a Canvas-edited theme.
11. Whether Canvas now supports theme app extensions (staff said "within the next few weeks" on 2026-10-01; no announcement found; a developer reported "not compatible" on 2026-11-01).
12. Directory layout and Liquid tags of Canvas-created themes (new theme architecture) and whether `isScannableFile` covers them.
13. Fall '26 Editions page publication date (not stated on the page).

## Sources opened (all accessed 2026-11-03)

- https://help.shopify.com/en/manual/online-store/themes/canvas (overview), `/requirements`, `/navigating`, `/customizing`
- https://changelog.shopify.com/posts/design-a-fully-bespoke-store-with-canvas (2026-10-01)
- https://www.shopify.com/news/introducing-canvas (2026-10-01)
- https://www.shopify.com/editions/fall2026 (no date on page)
- https://community.shopify.dev/t/meet-canvas-a-new-way-for-merchants-to-design-their-online-store-with-sidekick/38212 (thread 2026-10-01 to 2026-11-01; staff: Jordan_Graham, Nick_Lepine; all other posters unverified developers)
- https://shopify.dev/docs/storefronts/themes/agentic-workflows(.md), `/agents-md`
- https://shopify.dev/docs/api/admin-graphql/latest/objects/OnlineStoreTheme, `/enums/ThemeRole`, `/queries/themes`, `/mutations/themeDuplicate`, `/mutations/themeFilesUpsert`
- https://shopify.dev/changelog (listing; no Canvas entries found; 2026-10-28 "Introducing theme app add-ons" does not mention Canvas)
- https://help.shopify.com/en/manual/online-store/themes/customizing-themes/theme-editor/sidekick/generate-blocks
- Our code: `app/services/theme-fetcher.server.ts`, `app/services/theme-cache.server.ts`, `app/services/scan-engine.server.ts`, `app/services/storefront-fetcher.server.ts`, `app/services/liquid-error-detector.server.ts`, `app/routes/app._index.tsx`, `app/routes/webhooks.themes.publish.tsx`, `docs/spikes/2026-10-01-theme-autofix.md`

Leads (not chased): community.shopify.dev reports (unverified) that a "Generate App" feature exists inside Canvas; the Editions item "Apps can no longer create or update script tags" (gc-pa3q / gc-08x8 item 5); Shopify CLI `theme pull` on a Canvas theme (not tested, CLI unavailable to me).

## Addendum 2026-11-11: what changed, and the gc-tib.12 decision input

Method: re-read of the Shopify sources (researcher pass, all pages accessed 2026-11-10; key quote re-checked from the raw thread JSON 2026-11-11) plus one live probe on nw-dev-store-2 through the Shopify CLI.

### Changes since 2026-11-03
- **Admin API: no change found.** OnlineStoreTheme fields, ThemeRole values, the `themes` query, `themeDuplicate`, `themeFilesUpsert` and the webhook topic pages (API 2026-10, `latest` and `unstable`) contain no Canvas mention. The 2026-10 and 2027-01 release-note URLs returned 404 (not read). Confidence: high for "no Canvas marker"; medium for "no 2027-01 change".
- **Theme app extensions: still unsupported.** New staff source, Paige-Shopify (staff=true), https://community.shopify.dev/t/39026, 2026-10-26: "Theme app extensions aren't officially supported in Canvas yet, but we're working on adding support. Until then, they don't render in the Canvas editor. If a non-Canvas theme already has theme app extensions enabled, duplicating it into Canvas preserves those extensions in the theme code." No ETA. Latest indirect evidence (thread 39435, 2026-11-06) still treats app embeds as unavailable.
  - Answers Q4 in part: duplicating into Canvas **keeps theme code**, so leftover app code in theme files most likely travels into the Canvas copy (inferred from "preserves those extensions in the theme code").
- **Rollout: still early access.** help.shopify.com Canvas page: "Canvas is in early access and is available only to certain stores." No GA date. A merchant-side "Canvas has fully rolled out" (community.shopify.com/t/707240, 2026-10-30) is unverified and contradicts the help page.
- **Webhooks:** no Canvas mention; whether `themes/publish` fires for a Canvas publish is still unknown.

### Live probe (2026-11-11, nw-dev-store-2, Shopify CLI 4.9.4)
- `shopify theme pull --only AGENTS.md --only DESIGN.md` on **Horizon (unpublished, 149633695921)**: `AGENTS.md` present. On the live theme `test-data` (149633761457): neither file.
- **Consequence: `AGENTS.md` / `DESIGN.md` is NOT a Canvas signal.** Shopify's own non-Canvas Horizon ships `AGENTS.md`, so refusing on it would block every Horizon store. Drop the "proposed detection 3" idea above.
- Not testable here: whether this store has Canvas access (the CLI can't show the Canvas badge).

### gc-tib.12 decision input (recommendation for Nathan)
There is still **no positive Canvas signal** in the Admin API. What the clean-copy code does in each case:

| Case | What happens today | Live theme at risk? |
|---|---|---|
| Live theme is Canvas-edited, and `themes` hides it (staff statement 2026-10-01) | The scan itself can't find a published theme, so no scan and no Clean copy; if a scan exists, preflight's `getMainTheme` is null -> `NO_MAIN_THEME` refusal | No |
| Live theme is Canvas-edited and `themes` DOES list it (statement stale) | We duplicate it; the API copy may open only in Canvas; writes to it are undocumented | No: the adapter guard never writes MAIN or the source, and the merchant publishes |
| A non-Canvas live theme (today's normal case) | Works as built | No |

The core safety promise (live theme never written, merchant previews and publishes) holds in every row. The remaining risk is a confusing copy in row 2, not damage.

**Recommendation:** downgrade gc-tib.12 from release blocker to a launch follow-up:
1. Keep the `canvasThemeRefusal` hook (no-op) so a future API marker plugs straight in.
2. Make the `NO_MAIN_THEME` refusal copy mention Canvas ("If you edit your theme in Canvas, Clean copy can't read it yet."), and the same for the scan's "No published theme found" (gc-n3ot).
3. After write_themes approval, run Live checks A-C above on any store with Canvas access (Partner support can enable early access) before marketing Clean copy to Canvas users.
Alternative (keep as blocker): wait for a Shopify API marker or a live test on a Canvas store. No date for either.
