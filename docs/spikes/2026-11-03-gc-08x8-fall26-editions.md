# gc-08x8 spike: Fall '26 Editions impact on GhostCode

Date: 2026-11-03. Method: shopify.com/editions/fall2026, shopify.dev changelog and docs, Shopify help center. Fetched through a summarizing fetch tool, so quotes are as returned by it; re-check any load-bearing quote on the live page (see Gaps). No dev store access: nothing here was tested against a preview theme.

Label key: [OFFICIAL] = shopify.com / shopify.dev / help.shopify.com. [UNVERIFIED] = blog, community, or search-summary only.

## Summary

- Activity log (item 1): official page says "coming soon", gives no date, and says nothing about an API. Treat as an admin UI feature only until shopify.dev shows a query. GhostCode's "who injected this" is code-level (which file/app), a different object from the log's settings/product/access events.
- Extension status (item 2): "coming soon" in app settings, no date, no API mentioned. A partial read path exists today: App Bridge `shopify.app.extensions()` works only from inside the owning app, so GhostCode cannot read other apps' extension status.
- New theme architecture (item 3): dev preview only. Official sources describe new tags (`{% block %}`, `{% partial %}`) and "page structure in the Liquid template instead of a separate JSON file". GhostCode already scans `blocks/*.liquid`; the main risk is page-structure code moving out of `templates/*.json` (JSON-only pass) into `templates/*.liquid` (full pass, already covered). Low expected breakage, but unproven.
- Stylesheet subsetting (item 4): already live since 2026-04-20, applies only to `{% stylesheet %}` tags, and Shopify's docs say asset stylesheets (`asset_url`, `stylesheet_tag`) are unaffected. Little effect on third-party script/asset URL detection. App CSS behaviour is not addressed by the docs.
- ScriptTag (item 5): confirmed. Create/update rejected from 2026-10-01; storefront injection stops 2027-03-01 (changelog 2026-08-24 plus storefront docs). gc-pa3q already live.

---

## Item 1: Cross-store activity log

### What Shopify says
- Editions Fall '26, Operations section [OFFICIAL], https://www.shopify.com/editions/fall2026, accessed 2026-11-03 (page has no stated publish date; developer news post dated 2026-10-28).
  - Quote: "actions attributed to the staff member, app, or service behind it" (fetch tool's extract; the item is labeled "Coming soon, review changes across your store in one filterable log").
  - Availability: "Coming soon", no date. API: not mentioned on the page.
- Help center, https://help.shopify.com/en/manual/shopify-admin/activity-logs, accessed 2026-11-03 [OFFICIAL]. Describes a store activity log that already exists plus "a new version of the store activity log is rolling out in stages":
  - Quote: "the name of the person, app, or channel that took the action"
  - New log: entries kept 18 months; entries can't be exported (both versions); article does not mention API access. Current log shows at most 250 results.
  - The help article does not say whether the new log is the same thing as the Editions "cross-store" log. Unknown. (Assumption: related; unconfirmed.)
- No official developer-docs query or webhook for the activity log found (search of shopify.dev, 2026-11-03). Third-party connector doc (withone.ai, updated Feb 2026) describes a store-events Admin GraphQL query on 2026-04 [UNVERIFIED]; a Shopify Community thread asks for GraphQL access to the activity feed [UNVERIFIED].

### Impact on GhostCode
- Log events are admin actions (delete a product, change a setting, grant app access). They are not per-file theme code attribution. GhostCode's value ("which leftover code or injected script came from which app, and is it malicious") is not covered by the log as described. Unknown: whether the log records theme file edits/publishes at all.
- Overlap risk is positioning: a merchant may assume the log answers "who changed my theme". Watch for theme-edit entries once it ships.
- Without an API, GhostCode cannot ingest it. GhostCode's own "What changed" log (app/lib/theme-file-kind.ts, change-log.server.ts) stays the only automated source.

### Recommendation: KEEP (monitor)
Confidence: medium. Why: sourced from one-line Editions text plus help article, no date or API; could change when it ships. Trigger to revisit: a shopify.dev changelog entry exposing the log, or help-center text confirming theme file/publish events. If an API appears, ADAPT: correlate its app/staff attribution with GhostCode's file-diff timestamps.

---

## Item 2: App extension status page

### What Shopify says
- Editions Fall '26, Operations [OFFICIAL], https://www.shopify.com/editions/fall2026, accessed 2026-11-03.
  - Quote: "monitor the status of each app extension in app settings to spot issues early" (fetch tool's extract; labeled "Coming soon"). A first fetch also reported wording about contacting the developer; not re-verified verbatim.
  - No date. No API mentioned.
- Existing read path, App Bridge `shopify.app.extensions()`, https://shopify.dev/docs/api/app-bridge-library/apis/app, accessed 2026-11-03 [OFFICIAL]:
  - Quote: "The list of extensions from the current app."
  - Types: `ui_extension` and `theme_app_extension`; status values "active", "available", "unavailable"; theme app extension data "sourced from the store's published theme only."
  - Changelog 2026-01-23 (https://shopify.dev/changelog/extended-surface-support-for-shopifyappextensions-now-including-admin-and-storefront): method "now supports Admin and Theme app extensions".
- Partner Dashboard "API health" report is about deprecated API calls, not extension status [OFFICIAL via search summary, https://shopify.dev/docs/api/usage/versioning/api-health]; not fetched directly.

### Impact on GhostCode
- The Fall page says "each app extension" in app settings, likely merchant-facing UI. No evidence of a way for a third-party app to read other apps' extension status. Existing App Bridge method is scoped to the calling app, so GhostCode cannot use it to flag other apps' broken extensions.
- Adjacent GhostCode signal that already exists: `shopify://apps/<handle>/blocks/...` references in JSON templates (scan-engine.server.ts ~L4168) and dangling-reference detection (dangling-reference-extractor/resolver). These can flag app blocks/embeds that point at an app that is no longer installed, independent of Shopify's status page. A native status page would overlap partially, but only for installed apps with unhealthy extensions, not for orphaned references.
- Merchant could see "extension healthy" in Shopify while GhostCode finds leftover code from an uninstalled app; the two answer different questions.

### Recommendation: KEEP, with a small ADAPT idea
Confidence: medium-low. Why: no API or date; behaviour of the page is described in one sentence. Adapt idea (not a new feature yet): in copy for dangling app-block findings, note that Shopify's extension status covers installed apps only. Revisit when the page ships and Nathan can see what it lists.

---

## Item 3: New theme architecture (developer preview)

### What Shopify says
- Editions Fall '26 Developer > Storefronts [OFFICIAL], https://www.shopify.com/editions/fall2026 (second fetch, offset 100000), accessed 2026-11-03:
  - "New theme architecture (developer preview): Pages are composed in Liquid using blocks, typed contracts, and partial updates. Markdown files guide agents, and Tailwind styling is built in." (fetch tool's paraphrase of the item, not guaranteed verbatim)
- Developer news post 2026-10-28, https://www.shopify.com/news/fall-26-edition-developer [OFFICIAL]:
  - Quote: "Page structure now lives in the Liquid template itself instead of a separate JSON file"
  - Quote: "with blocks, typed contracts, partial updates, markdown files that guide agents, and Tailwind styling built in."
  - Quote: "Themes built on it are also ready for merchants to edit with Sidekick in Canvas, now in early access."
- Changelog 2026-07-21 "Liquid July '26", https://shopify.dev/changelog/developer-preview-liquid-block-and-partial-tags [OFFICIAL]:
  - `{% block %}` renders a reusable theme block from a template; `{% partial %}` marks a server-rendered region JavaScript can refresh without reload.
  - Quote: "Existing themes continue to work with sections, theme settings, and JSON templates."
  - Quote: "To try it, create a development store with the Liquid July ’26 developer preview."
  - Start point: skeleton theme release candidate rc-v2.0.0 (per the fetch tool's summary).
  - "Typed contracts" is not defined on any page I could open. Closest: Theme Check 3.28.0 rules that flag mismatches between block arguments, schemas and `{% doc %}` declarations.
- Theme file layout docs, https://shopify.dev/docs/storefronts/themes/getting-started/developer-preview.md (this URL returned the standard theme structure page) [OFFICIAL]:
  - Directories: `assets`, `blocks`, `config`, `layout`, `locales`, `sections`, `snippets`, `templates`. Quote: "Subdirectories, other than the ones listed, aren't supported."
- Not found in official sources: any statement on how app blocks / app embeds (theme app extensions) work in the new architecture; any new file extension; where markdown agent files live. A blog (fudge.ai / search summary) says themes carry `AGENTS.md` and `DESIGN.md` read by Sidekick in Canvas [UNVERIFIED]. The Editions page says "Markdown files ... teach Sidekick how your theme is built" (Sidekick section) without file names.
- One line on Canvas (gc-dg5e owns it): TechCrunch via search summary says Canvas lacks third-party theme support and app blocks/extensions [UNVERIFIED].

### Impact on GhostCode (from repo reading, not from a preview theme)
- Current scanner (app/services/scan-engine.server.ts):
  - `isScannableFile`: `.liquid` under `templates/ sections/ snippets/ layout/ blocks/` get the full detector suite (blocks added in gc-zfl).
  - `isMaliciousScanOnlyFile`: `templates/**.json`, `sections/**.json`, `config/settings_data.json`, `assets/*.js|.mjs|.liquid`, `locales/*.json` get only MALICIOUS_SCRIPT.
  - app/lib/theme-file-kind.ts: unknown top-level folders are classified `other` and not counted as changes.
- What the new model could change:
  1. If page structure moves from `templates/*.json` to `templates/*.liquid`, the full suite covers those files already. The JSON-embedded Custom Liquid path (escaped Liquid in JSON strings) would matter less for such themes. Positive.
  2. Apps that wrote into `templates/*.json` (app block entries `shopify://apps/...`) may have a different representation. Unknown whether app blocks are referenced through `{% block %}` in Liquid. This is the main unknown for dangling-reference and app attribution code (~L4168 in scan-engine).
  3. `{% partial %}` and `{% block %}` tag syntax: the scanner's Liquid tokenizer is mirrored from Liquid 5.8.1 (scan-engine ~L1541). Unknown tags may parse as raw text or mis-tokenize. Risk of missed or false findings on `{% block %}` args. Needs a test on the preview theme.
  4. Markdown agent files (e.g. AGENTS.md/DESIGN.md [UNVERIFIED]): not in scanned folders, would fall into `other`. Theme file API may or may not return them. Agent-readable files are a possible new injection surface (text that steers Sidekick). Speculative; no official statement.
  5. Tailwind built in: could add a generated CSS asset; GhostCode ignores CSS for the malicious pass by design.
- Merchants are not on this architecture yet (dev preview), so near-term exposure is near zero.

### Recommendation: KEEP now; ADAPT after preview-theme test
Confidence: medium on "no near-term breakage" (official compat statement), low on parse behavior (untested). Add a fixture-based test once Nathan supplies a preview theme export.

### Offline test 2026-11-05 (no dev store)
Source: Shopify's public skeleton theme, branch `rc-v2.0.0` at `56730a9504f4f62a03ace6b2361de1958932ca53` (github.com/Shopify/skeleton-theme, commit dated 2026-07-23; the only other ref is tag v1.0.0). Its AGENTS.md says: "No sections: no `sections/` folder, no `{% section %}`/`{% sections %}` tags, no JSON templates". Tags used: `{% block 'name', arg: value %}...{% endblock %}` (20), `{% doc %}` headers (6), `{% partial 'name' %}...{% endpartial %}` (1, in blocks/liquid-tips.liquid), plus ordinary Liquid. Its doc header notes the partial renders only when `shop.features.agentic_editor_enabled?` is on; otherwise the storefront raises "Unknown tag 'partial'".

File inventory (41 files, routed by `isScannableFile` / `isMaliciousScanOnlyFile` / `classifyThemeFile`):

| Files | GhostCode treatment |
|---|---|
| `templates/*.liquid` (13), `layout/*.liquid` (2), `blocks/*.liquid` (5), `snippets/*.liquid` (3) | full detector suite, kind `code` |
| `assets/liquid-tips.js`, `config/settings_data.json`, `locales/*.json` (2) | MALICIOUS_SCRIPT only |
| `assets/*.css`, `assets/*.svg`, `config/settings_schema.json` | not scanned (unchanged, by design) |
| root `AGENTS.md`, `README.md`, other root dotfiles | not scanned, kind `other` |

No new folders and no new file extensions. Page structure moved into `templates/*.liquid`, which the full suite already covers.

Results:
- A scan of the full real skeleton (one-off run, not committed: the theme's licence limits use to theme development) found 0 findings, 0 unknown scripts and 0 skipped files. No false positives.
- `tests/services/scan-engine.new-architecture.test.ts` uses fixtures written for the test in the skeleton's tag shapes:
  - (a) a listed malicious `<script src>` inside a `{% partial %}` nested in blocks with arguments fires MALICIOUS_SCRIPT on the correct line: PASS;
  - (b) a Klaviyo script in the same position fires GHOST_SCRIPT (Klaviyo) on the correct line: PASS;
  - (c) a clean layout + template + block in the new shape produces no findings: PASS;
  - (d) an AGENTS.md with prompt-like text and a malicious URL is ignored with no crash: PASS.
- **Bug found (pre-existing, not fixed here):** a leftover app script inside a `{% doc %}` body is reported HIGH, while the same script inside `{% comment %}` is LOW. Liquid never renders doc bodies. Cause: `isInsideLiquidComment` (app/services/severity-classifier.server.ts:128) matches `comment` only. It is recorded as an `it.fails` test, which flips once fixed. New-architecture blocks lean on `{% doc %}` headers with `@example` code, so the exposure grows with adoption.
- AGENTS.md / DESIGN.md: the file name AGENTS.md is now VERIFIED, since it ships in the skeleton theme. Whether the theme `files` API returns root-level files on a live store is still unknown (the fetcher requests all files; the scanner ignores `.md` either way).

Checks for Nathan, updated:
- Answered offline: new folders or extensions (none); templates/*.liquid replacing JSON (yes, already full-suite); `{% block %}`/`{% partial %}` parsing and line numbers (correct); markdown agent files (ignored, no crash).
- Still live-only:
  - how app blocks and embeds are represented in the new architecture (dangling-reference and attribution);
  - whether the API returns root `AGENTS.md`;
  - storefront CSS (item 4), activity log and extension status (items 1 and 2), and all Canvas questions (gc-dg5e).

---

## Item 4: Stylesheet subsetting

### What Shopify says
- Changelog 2026-04-23, https://shopify.dev/changelog/automatic-css-subsetting-for-stylesheet-tags [OFFICIAL]:
  - Quote: "Starting April 20, 2026, Shopify only delivers the CSS from `{% stylesheet %}` tags that are relevant"
  - Warns styles may go missing "on pages where the defining file isn't rendered".
- Docs, https://shopify.dev/docs/storefronts/themes/best-practices/performance/stylesheet-subsetting [OFFICIAL], no date on page:
  - Quote: "Only the CSS from those files' `{% stylesheet %}` tags is included in the linked `styles.css` file."
  - Quote: "Asset stylesheets aren't subject to subsetting and are always available on every page that loads them."
  - `{% style %}` and inline styles are not affected.
  - Does not address app blocks, theme app extension CSS or app-injected CSS.
- It is listed in the Fall '26 Developer > Storefronts section too (Editions page, accessed 2026-11-03), but the shipped date is April 2026, so it is not a new Fall change.

### Impact on GhostCode
- Affects only CSS from `{% stylesheet %}` tags, delivered per page. GhostCode's storefront analysis (storefront-analyzer.server.ts) and malicious pass focus on scripts and hosts; CSS is deliberately excluded from the malicious pass (scan-engine comment above `isMaliciousScanOnlyFile`). Asset URLs loaded via `asset_url` are unchanged.
- Possible small effects (unverified, from reading docs): the per-page `styles.css` content varies by page, so any feature comparing CSS across pages, or the speed report attributing CSS bytes to apps, could see page-dependent CSS. Not tested. Whether the `styles.css` URL differs per page is not stated in the docs.
- Theme-source scanning is unaffected: `{% stylesheet %}` blocks still live in the Liquid files.

### Recommendation: KEEP
Confidence: medium-high that detection of scripts/hosts is unaffected (docs state asset stylesheets unchanged); low on speed-report CSS attribution (untested).

---

## Item 5: ScriptTag sunset

### What Shopify says
- Changelog 2026-08-24, https://shopify.dev/changelog/online-store-script-tags-deprecation [OFFICIAL], accessed 2026-11-03:
  - Quote: "Starting October 1, 2026, the `scriptTagCreate` and `scriptTagUpdate` mutations will return an user error,"
  - Quote: "the `ScriptTag` REST Admin API resource will reject `POST` and `PUT`."
  - Quote: "Existing script tags will keep running."
  - Quote: "On March 1, 2027, Shopify will stop injecting script tags into storefronts."
  - Scope: "Apps that create script tags with a `display_scope` of `online_store`." `order_status` tags are under an earlier deprecation.
  - Quote: "The `scriptTags` query and the `scriptTagDelete` mutation keep working,"
- Docs, https://shopify.dev/docs/apps/build/online-store/script-tag-deprecation/storefront.md [OFFICIAL], accessed 2026-11-03:
  - Quote: "Your script will no longer load, and any feature that depends on it will stop working for that store."
  - Quote: "After that date, leftover script tag records will have no effect, so you don't need to delete them."
- Editions Fall '26 Developer > Secure ecosystem [OFFICIAL]: "Apps can no longer create or update script tags and must migrate to theme app extensions or web pixels."
- "Already blocked": the 2026-10-01 date has passed as of today (2026-11-03), so create/update rejection is in effect per the changelog schedule. Not tested against the API by me.

### Impact on GhostCode
- Matches the existing detector gc-pa3q (live since 2026-10-12 per memory shopify-scripttag-sunset-and-visibility.md; not re-verified in code this session).
- Note a nuance for copy: "leftover script tag records will have no effect" after 2027-03-01, so cleanup by delete is optional; the user-visible risk is the app feature breaking, not leftover code. Check gc-pa3q wording does not tell merchants to delete records for safety.
- After 2027-03-01 the detector's storefront signal (the `asyncLoad` urls in content_for_header) will disappear on its own; plan to retire or repurpose the finding after that date.

### Recommendation: KEEP
Confidence: high (primary source, two pages agree).

---

## Checks for Nathan

Getting the preview theme (item 3), per Shopify's changelog:
1. Create a development store (Partner Dashboard) and enable the "Liquid July '26" developer preview.
2. Start from the skeleton theme release candidate rc-v2.0.0, or add `{% block %}` / `{% partial %}` to a copy of an existing theme. (Per fetch summary; confirm steps in the changelog page.)
3. Install a test app with a theme app extension (app block + app embed), add it in the editor, then run a GhostCode scan.

What to check:
- Do any theme files appear outside `templates/ sections/ snippets/ layout/ blocks/ assets/ config/ locales/`? (They land in `other` in theme-file-kind.ts and are not scanned.) Note any `.md` files, new folders, new extensions.
- Does `templates/*.liquid` replace `templates/*.json` for page structure? Confirm the file list returned by the theme `files` query in theme-fetcher.server.ts includes them.
- How does the app block/embed appear: still `shopify://apps/<handle>/blocks/...` in JSON, or in Liquid? Run the dangling-reference extractor and app attribution on it.
- Does the scanner crash or mis-parse on `{% block %}` / `{% partial %}` with arguments (Liquid 5.8.1-mirrored tokenizer)? Add a fixture with nested blocks and a `{% partial %}` containing a pasted `<script src>` from a listed bad host; confirm MALICIOUS_SCRIPT and full-suite detectors fire with correct line numbers.
- Do the markdown agent files (if present) come back from the theme files query? If yes, paste a prompt-like instruction and see whether the scanner ignores them (expected).
- Storefront: view source of two different page types and compare the linked `styles.css`; note whether the URL differs and whether app CSS appears inside or as a separate link (items 4 and 3).
- Item 1 and 2: when the activity log and extension status page appear in the admin, screenshot them; check whether theme file edits or publishes show up, and whether the extension page lists apps that are uninstalled.
- Live API check (item 5, optional, read-only): on an existing dev store, try `scriptTagCreate` from a test app and confirm the user error; this is a write call to a dev store only.
- Check shopify.dev changelog weekly for: an activity-log query, an extension-status query, and a docs page defining "typed contracts" and app block behavior in the new architecture.

---

## Claims rated unverified

- AGENTS.md / DESIGN.md as the markdown agent file names (fudge.ai via search summary).
- Canvas lacks app blocks and third-party themes (TechCrunch via search summary).
- A public Admin GraphQL query for store events (withone.ai connector doc).
- Whether the "new log" in the help article equals the Editions "cross-store activity log".
- "Typed contracts" meaning (no official definition found).
- skeleton theme rc-v2.0.0 as the starting point (single fetch-tool summary of the changelog).

## Gaps

- All pages were read through a summarizing fetch tool, not raw HTML; verbatim quotes may be paraphrases where marked. Re-verify before quoting externally.
- Editions page text was 104,777 chars; both halves were read. Operations section wording for items 1 and 2 was extracted by the tool, not read in full context.
- shopify.dev `{% block %}` reference and theme architecture overview pages were not retrieved (the "developer-preview" URL returned the generic theme structure page).
- Changelog filter page covered 2026-09-09 to 2026-10-31 only; July-August entries were not scanned beyond the specific July 21 and August 24 posts.
- Not run: any scanner test on a preview theme; any API call.

## Leads
- gc-dg5e (Canvas): confirm whether Canvas editing writes to `templates/*.json` or new formats.
- Theme Check 3.28.0 release notes may define the "typed contracts" rules.
