# Ghost Code — Full Code Review

**Date:** 2026-06-12
**Scope:** entire repository (`app/`, `inngest/`, `scripts/`, `prisma/`, `tests/`, Docker/Railway/Shopify config)
**Method:** two multi-agent review waves (76 agents total) across nine dimensions — security, logic, hardcoded URLs, performance, features, tests, code quality, ops, and Shopify compliance. Every finding (except feature ideas) was independently re-checked by an adversarial verifier instructed to refute it; severities below reflect the verifier-adjusted rating. 1 finding was refuted and excluded (see appendix); 3 cross-wave duplicates were merged.

**Confirmed findings: 63** — 1 critical · 9 high · 27 medium · 26 low

---

## Executive summary

The headline is not any single bug — it's a systemic pattern three independent reviewers converged on: **the five optional-scope audit features (products, content, redirects, translations, prices) are effectively dead in production, and the codebase has no way to notice.** The chain:

1. Optional scopes are declared in `shopify.app.toml` but **no code path ever requests them** from the merchant ([CMP-1](#cmp-1)) — so they are never granted.
2. Scope checks **swallow every error and return "scope missing"** ([LOG-9](#log-9)), so throttling or network failures also silently skip audit categories.
3. Scans are **marked COMPLETED at step 2 of 8** ([LOG-4](#log-4)), so later failures still produce a "clean" scan, and the differ then reports prior findings as *resolved*.
4. The test suite is **green for the wrong reason**: the audit steps pass trivially because unmocked fetchers throw, the error is swallowed, and every step short-circuits to zero findings ([TST-2](#tst-2)).

Alongside that systemic issue, the four most urgent individual items:

- **Patch dependencies now** — the installed `react-router` 7.13.1 has a published unauthenticated RCE advisory, among 26 production-dependency vulnerabilities ([OPS-1](#ops-1)).
- **Detector false positives on default themes** — GHOST_TITLE/GHOST_OG flag stock Dawn variables at HIGH severity ([LOG-1](#log-1)), and GHOST_PRICE flags every normal compare-at sale price ([LOG-2](#log-2)). For a scanner app, false positives on a vanilla store are an existential credibility problem.
- **The upgrade/billing link is still broken** — the Managed Pricing deep link uses `client_id` where Shopify expects the app *handle* ([URL-1](#url-1)). This is the revenue path.
- **No database backup story** — the Postgres database (sessions, scans, findings, billing events) has no documented backup/restore plan ([OPS-2](#ops-2)).

Security posture is comparatively good: no critical or high vulnerabilities were confirmed. The worst item is that live access tokens sit in plaintext in the Session table while the encryption module protects an unused, stale copy ([SEC-1](#sec-1)) — a defense-in-depth gap, not an open door.

## Top priorities

| # | ID | Sev | Finding | Why it's top-10 |
|---|----|-----|---------|-----------------|
| 1 | [OPS-1](#ops-1) | 🟠 high | Patch react-router RCE + 25 other prod vulns | Published unauthenticated RCE; one `npm update` cycle |
| 2 | [LOG-1](#log-1) | 🔴 critical | GHOST_TITLE/GHOST_OG false positives on stock Dawn themes | Scanner credibility; every default-theme merchant sees bogus HIGH findings |
| 3 | [CMP-1](#cmp-1) | 🟠 high | Optional scopes never requested — 5 advertised audit features dead | Advertised features silently no-op for all merchants |
| 4 | [URL-1](#url-1) | 🟠 high | Managed Pricing deep link still broken (client_id vs handle) | Merchants cannot upgrade — direct revenue impact |
| 5 | [LOG-2](#log-2) | 🟠 high | GHOST_PRICE flags all compare-at sale pricing | High-severity false positive on a near-universal merchant pattern |
| 6 | [LOG-4](#log-4) | 🟠 high | Scan marked COMPLETED at step 2 of 8 | Partial failures look like clean scans; differ falsely resolves findings |
| 7 | [LOG-3](#log-3) | 🟠 high | Translation detector's installed-app guard is dead code | Flags stores using Shopify Translate & Adapt |
| 8 | [TST-2](#tst-2) | 🟠 high | scan-theme steps 3–8 pass tests trivially via swallowed errors | Test suite cannot catch the systemic failure above |
| 9 | [OPS-2](#ops-2) | 🟡 medium | No database backup/restore story | Merchant data loss one incident away |
| 10 | [SEC-1](#sec-1) | 🟡 medium | Live tokens plaintext in Session table; encryption protects dead copy | Encryption control fails its documented purpose |

---

## Security

<a id="sec-1"></a>
### SEC-1 · 🟡 MEDIUM — Shopify offline access tokens stored in plaintext in Session table; the encrypted Shop.accessToken copy is never used

**Where:** `prisma/schema.prisma:20-38`

The token-encryption module (app/lib/token-encryption.server.ts) only protects Shop.accessToken via upsertShop/getShopByDomain (app/models/shop.server.ts:48-80). But getShopByDomain has zero callers in the codebase — every background job and webhook that needs API access uses `unauthenticated.admin(shop.domain)` (e.g. inngest/functions/scan-theme.ts:65-66 and 135-136, app/routes/webhooks.themes.publish.tsx:47), which reads the offline token from the Session table via PrismaSessionStorage. Session.accessToken (schema line 27) and Session.refreshToken (line 36) are stored in plaintext. So the operative copy of every shop's API credential is unencrypted, and TOKEN_ENCRYPTION_KEY protects only a dead, never-refreshed duplicate written once on first visit (app/routes/app.tsx:13-16) — which also goes stale because expiringOfflineAccessTokens is enabled (app/shopify.server.ts:33). A database leak exposes all live tokens despite the encryption infrastructure.

**Recommendation:** Either (a) wrap PrismaSessionStorage with encrypt-on-write/decrypt-on-read using the existing encryptToken/decryptToken helpers (a thin SessionStorage decorator), so the live tokens are actually protected by TOKEN_ENCRYPTION_KEY; or (b) if DB-at-rest encryption on Railway Postgres is deemed sufficient, delete the unused Shop.accessToken column, getShopByDomain, and the token-encryption module to stop implying a protection that does not exist. Option (a) matches the documented intent of token-encryption.server.ts.

<a id="sec-2"></a>
### SEC-2 · ⚪ LOW — CSV formula injection in scan findings export

**Where:** `app/routes/app.scans.$scanId.export.tsx:30-44, 117-121`
**Severity:** reviewer said medium, verifier adjusted to **low**

escapeCsvField() only quote-wraps and doubles internal quotes; it does not neutralize fields beginning with =, +, -, @, tab, or CR. The exported columns include codeSnippet, filename, and appName, which are taken verbatim from merchant theme files — content that is written by third-party apps (the exact 'ghost code' this app hunts). A malicious or compromised app that left `=HYPERLINK(...)` or `=CMD|...` style content in a theme file (e.g. as a script src or comment) would have it land as a live formula when the merchant opens the CSV in Excel/Sheets, enabling data exfiltration or command execution prompts on the merchant's machine. Quoting does not prevent this: spreadsheet apps unquote the field and then evaluate the leading '='.

> **Verifier note:** Finding is correct but overrated: CSV formula injection exists in escapeCsvField and exported fields carry verbatim third-party content, but the long exploit chain plus modern spreadsheet protections (DDE disabled by default, formula warnings, click-required HYPERLINK exfiltration) make this low severity rather than medium.

**Recommendation:** In escapeCsvField, prefix any field whose first character is =, +, -, @, \t, or \r with a single quote (') or a space before quote-wrapping (e.g. `if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;`). Add a unit test in tests/routes/app.scans.$scanId.export.test.ts with a codeSnippet like `=HYPERLINK("http://evil")` asserting the output is neutralized.

<a id="sec-3"></a>
### SEC-3 · ⚪ LOW — Inngest endpoint signature enforcement relies entirely on implicit env detection with no fail-fast

**Where:** `app/routes/api.inngest.ts:22-35`

serve() is configured without an explicit signingKey, so verification depends on the INNGEST_SIGNING_KEY env var being present AND the SDK detecting cloud mode. The installed SDK (inngest@3.54, InngestCommHandler.validateSignature) skips signature validation entirely when mode is not cloud (`if (this._mode && !this._mode.isCloud) return { success: true }`), and mode is inferred from INNGEST_DEV / NODE_ENV. The app fails fast at boot for SHOPIFY_API_SECRET, SHOPIFY_APP_URL (app/shopify.server.ts:13-21) and TOKEN_ENCRYPTION_KEY (token-encryption.server.ts:23-28), but there is no equivalent guard for INNGEST_SIGNING_KEY. If INNGEST_DEV=1 leaks into the Railway environment (or NODE_ENV is ever not 'production'), the public /api/inngest endpoint at app.alpenglowsoftware.com would accept unsigned invocations of every background function (scan-theme, weekly-scan, etc.) — allowing an attacker to trigger scans for arbitrary shopIds and burn merchants' API quotas. If the key is merely missing, all Inngest requests 500 (availability failure that surfaces only at job time).

> **Verifier note:** The missing explicit signingKey and absent boot-time guard for INNGEST_SIGNING_KEY are real hardening/operational gaps, but the security exposure is narrower than claimed: NODE_ENV=production is baked into the Docker image (Dockerfile:19), Railway deployments independently trigger cloud-mode inference via RAILWAY_GIT_BRANCH, and a missing key fails closed (all Inngest requests rejected, not accepted). The only unsigned-invocation path is a deliberate INNGEST_DEV=1 misconfiguration in production. The fix (explicit signingKey + production fail-fast, mirroring token-encryption.server.ts) is still worthwhile as defense-in-depth and to convert a silent job outage into a deploy-time failure.

**Recommendation:** In api.inngest.ts, pass signingKey explicitly: read process.env.INNGEST_SIGNING_KEY and throw at module load when NODE_ENV === 'production' and it is unset (mirroring the token-encryption pattern). Optionally also assert process.env.INNGEST_DEV is not set in production. This converts a silent runtime misconfiguration into a deploy-time failure.

---

## Logic & Correctness

<a id="log-1"></a>
### LOG-1 · 🔴 CRITICAL — GHOST_TITLE / GHOST_OG safe-variable lists omit stock Dawn variables — HIGH-severity false positives on default themes

**Where:** `app/services/scan-engine.server.ts:1215-1216, 1303-1324, 1409-1416, 1487-1509`

SAFE_TITLE_VARS_RE (line 1215) allows only page_title|shop.name|page_description|product.title|collection.title|article.title|blog.title|template|content_for_*. Stock Dawn's layout/theme.liquid <title> block contains `{{ current_tags | join: ', ' }}` and `{{ current_page }}` — neither is in the safe list, so check 2 (lines 1303-1324) emits 'Unresolved Liquid variable in title tag' at HIGH severity on every Dawn-based store. Similarly SAFE_OG_VARS_RE (1409) omits `page_image` and `canonical_url`, and SAFE_OG_FILTER_RE (1416) lists the deprecated `img_url` filter but not the modern `image_url` filter. Dawn's snippets/meta-tags.liquid uses `content="http:{{ page_image | image_url }}"` for og:image and `{{ canonical_url }}` for og:url — both flagged as 'Unresolved Liquid variable', and og:image findings are upgraded to HIGH by classifySeverity (severity-classifier.server.ts:113). The conditional-skip only inspects the line containing the tag opening (scan-engine.server.ts:1265-1266, 1459-1462), so the enclosing `{%- if page_image -%}` on the previous line does not suppress it. Net effect: nearly every merchant on the default theme gets multiple HIGH findings on untouched stock code, tanking the health score (each HIGH = -10) and destroying trust in the scanner. A grep confirms `current_tags`, `current_page`, and `page_image` appear nowhere in app/ or tests/.

> **Verifier note:** Confirmed as stated with one detail fixed: Dawn's og:url tag renders {{ og_url }} (a {%- liquid assign -%} local derived from canonical_url), not {{ canonical_url }} directly. Consequently the proposed fix is incomplete — adding canonical_url/page_image/current_tags/current_page/request.* to safe lists and image_url/image_tag to safe filters is necessary but insufficient; the detector must also recognize theme-local assigned variables (track {% assign %} / {% liquid assign %} bindings, or at minimum whitelist Dawn's og_* locals and the escape filter), in addition to block-aware {% if %}/{% endif %} conditional tracking and verbatim Dawn fixtures as regression tests.

**Recommendation:** Add current_tags, current_page, page_image, canonical_url, request.* to the safe-variable lists; add image_url (and image_tag) to SAFE_OG_FILTER_RE; extend conditional detection to enclosing {% if %}/{% endif %} blocks (track block state like the comment tracking already does) instead of only the tag's own line. Add regression tests using verbatim Dawn theme.liquid and meta-tags.liquid fixtures asserting zero findings.

<a id="log-2"></a>
### LOG-2 · 🟠 HIGH — GHOST_PRICE flags every product with normal compare-at sale pricing as ghost code at HIGH severity

**Where:** `app/services/price-detector.server.ts:26-59`
**Severity:** reviewer said critical, verifier adjusted to **high**

detectPersistentDiscounts emits a HIGH-severity finding for any product where any variant has compareAtPrice > price (lines 30-34), describing it as 'may be left by an uninstalled discount app'. compareAtPrice is the standard, manual Shopify mechanism merchants use to show sale prices — there is no app-attribution signal at all in this detector (appName is always undefined, line 53). A store running an ordinary sale across its catalog gets up to 500 HIGH findings (fetchProductPrices caps at 500 in product-fetcher.server.ts:204), each deducting 10 points, guaranteeing a health score of 0 and a wall of false 'ghost code' for healthy stores. This is qualitatively different from the tag/metafield/page detectors, which at least match distinctive app-specific patterns.

**Recommendation:** Either remove this detector or require an actual app signal (e.g. compare-at price set together with an app-pattern tag/metafield on the same product, or compareAtPrice == price which is the classic leftover-discount-app artifact). At minimum downgrade to LOW, set a clear 'informational' framing, and cap the number of findings so it cannot zero out the health score.

<a id="log-3"></a>
### LOG-3 · 🟠 HIGH — Translation detector's installed-app guard is dead code — flags stores actively using translation apps (incl. Shopify Translate & Adapt)

**Where:** `inngest/functions/scan-theme.ts:205-212`

detectOrphanedTranslations (app/services/translation-detector.server.ts:63-71) only suppresses findings when a known translation app is installed, but scan-theme.ts:208 hard-codes `const installedAppNames: string[] = []` because the appInstallations query is restricted. The guard can therefore never fire, and every store that granted read_translations and has any non-primary locale translations — including stores actively translating via Shopify's free, native Translate & Adapt or any third-party app — gets MEDIUM 'orphaned translations … no translation app is currently installed' findings. With up to 5 locales x 5 resource types (translation-fetcher.server.ts:84), that is up to 25 false MEDIUM findings (-125 health points). The description text ('no translation app is currently installed') is asserted but never verified.

**Recommendation:** Since installed-app data is unavailable, the 'orphaned' premise cannot be established — either remove the GHOST_TRANSLATION detector, restrict it to translations whose `outdated` flag is true (a real staleness signal the API does provide), or reword/downgrade to an informational LOW finding that does not claim no app is installed.

<a id="log-4"></a>
### LOG-4 · 🟠 HIGH — Scan is marked COMPLETED at step 2 while audit steps 3-8 are still running; later step failures leave a silently-partial COMPLETED scan

**Where:** `inngest/functions/scan-theme.ts:128-167, 239-341, 371-394`

completeScanWithFindings (called at scan-theme.ts:159) sets status COMPLETED inside step 2, but six more audit steps (translation, tags, prices, pages, metafields, redirects) run afterwards and keep appending findings. Consequences: (1) the dashboard/diff/health score treat the scan as final the moment step 2 commits — a merchant viewing during steps 3-8 sees a partial findingCount and a diff that falsely reports all API-based findings (GHOST_REDIRECT, GHOST_TAG, …) from the prior scan as 'resolved' (app.scans.$scanId.tsx:214-264 gates only on status === COMPLETED); (2) the outer catch (lines 384-389) deliberately skips marking FAILED when status is already COMPLETED, so if any audit step exhausts its retries the scan stays COMPLETED with whole categories silently missing — no FAILED status, no UI signal; (3) the active-scan guard (createScan / canStartScan checks PENDING/IN_PROGRESS only) no longer blocks, so a second scan can start while the first scan's audit steps are still writing to the old scanId.

**Recommendation:** Persist findings in step 2 without flipping status (add a separate persistFindings function), and add a final 'mark-completed' step after all audit steps. This makes the watchdog cover the whole pipeline, keeps the concurrency guard honest, and makes audit-step failure produce FAILED instead of silent partial results.

<a id="log-5"></a>
### LOG-5 · 🟡 MEDIUM — fetchThemeFiles silently returns partial/empty file list on missing theme data — scan completes clean and diff marks all prior findings resolved

**Where:** `app/services/theme-fetcher.server.ts:283-290`
**Severity:** reviewer said high, verifier adjusted to **medium**

When `json.data.theme` is null/undefined (theme deleted, access denied without a top-level errors array, malformed response), the pagination loop does `break` and returns whatever was accumulated — usually an empty array on the first page. scan-theme.ts:137-166 then runs scanThemeFiles([]) and completeScanWithFindings(scanId, []) which deletes all findings for the scan and marks it COMPLETED with findingCount 0. The scan-detail diff (app/routes/app.scans.$scanId.tsx:259-264) then reports every previous finding as 'resolved'. A transient API soft-failure is thus indistinguishable from a genuinely clean theme — the worst possible failure mode for an audit product. The same partial-result risk applies if theme data disappears mid-pagination.

> **Verifier note:** The mechanism is exactly as claimed, but the dominant realistic trigger is theme deletion mid-pipeline (poll-check-shop.ts enqueues scans with a theme ID fetched earlier), where the previous findings genuinely no longer apply — the bug there is a wrong COMPLETED-clean status instead of FAILED. The "transient API soft-failure indistinguishable from a clean theme" scenario is real but requires Shopify to return null theme data without an errors array for an existing theme, which is rare. Proposed fix (throw on null themeData + zero-file sanity guard) is appropriate.

**Recommendation:** Throw an error when themeData is null (letting Inngest retry and ultimately mark the scan FAILED), and consider a sanity guard in scan-theme: if a previous COMPLETED scan had findings but the fetched file count is 0, fail the scan rather than completing with zero findings.

<a id="log-6"></a>
### LOG-6 · 🟡 MEDIUM — 15-minute stale-scan watchdog uses createdAt and races legitimately-running jobs (Inngest retry backoff easily exceeds it)

**Where:** `inngest/functions/watch-stale-scans.ts:25-54`

watch-stale-scans expires any PENDING/IN_PROGRESS scan older than 15 minutes from createdAt (expireStaleScans in app/models/scan.server.ts:201-214). But a scan can legitimately exceed 15 minutes: huge themes with rate-limit sleeps in fetchThemeFiles (theme-fetcher.server.ts:45-53 sleeps proportionally per page), plus Inngest's default retry backoff after a transient step failure can alone exceed 15 minutes. When that happens: the watchdog marks the scan FAILED, the merchant (or poll-check-shop) is now free to start a second concurrent scan for the same shop, and the still-running original job later calls completeScanWithFindings which silently resurrects the 'FAILED' scan to COMPLETED — producing two overlapping scan jobs hammering the same shop's rate limits and out-of-order scan history. The job itself never checks whether its scan was expired before continuing.

**Recommendation:** Base staleness on startedAt with a larger threshold for IN_PROGRESS (and keep a short one for PENDING), and make scan-theme steps verify the scan is still IN_PROGRESS before persisting (abort if FAILED/expired). Alternatively use Inngest's per-shop concurrency key to make overlapping scans for one shop impossible regardless of watchdog timing.

<a id="log-7"></a>
### LOG-7 · 🟡 MEDIUM — poll-check-shop staleness check ignores scan status — a FAILED last scan permanently suppresses automatic re-scans

**Where:** `inngest/functions/poll-check-shop.ts:131-140`

Step 3 fetches the latest scan with no status filter (`db.scan.findFirst({ where: { shopId, themeId }, orderBy: { createdAt: 'desc' } })`) and re-scans only when `themeUpdatedAt > latestScan.createdAt`. If the most recent scan FAILED (e.g. expired by the watchdog or a crashed job), its createdAt is necessarily after the theme update that triggered it, so needsScan evaluates false on every subsequent daily/weekly poll. A paid Professional/Standard shop whose last scheduled scan failed will never be automatically re-scanned until the merchant edits the theme again — exactly the stale-data scenario the cron exists to prevent.

> **Verifier note:** Claim is accurate except two minor details: getPreviousScanForTheme is in app/models/scan.server.ts:160-171 (not app/services/), and suppression is not strictly permanent — it ends when the merchant next edits the theme (advancing updatedAt), publishes a theme, or runs a manual scan. The proposed fix (filter latest-scan query to COMPLETED, or treat a FAILED latest scan as needing a re-scan) is correct.

**Recommendation:** Filter the latest-scan query to status COMPLETED (matching getPreviousScanForTheme's approach in scan.server.ts:160-171), or additionally trigger a scan when the latest scan exists but is FAILED.

<a id="log-8"></a>
### LOG-8 · 🟡 MEDIUM — poll-check-shop dispatch step is non-idempotent: createScan + inngest.send in one step turns a send failure into a poisoned retry loop and an orphan PENDING scan

**Where:** `inngest/functions/poll-check-shop.ts:153-182`

Step 4 calls createScan() and then inngest.send() inside the same step.run. If send() throws after the scan row is committed, Inngest retries the step; the retry's createScan() now finds the PENDING scan it created and throws 'A scan is already in progress for this shop.' (scan.server.ts:44-50), so every retry fails deterministically. End state: function fails permanently, the scan/requested event is never sent, and an orphan PENDING scan blocks the shop until the watchdog expires it 15 minutes later — after which nothing re-dispatches until the next day's cron (which then skips via the FAILED-scan staleness bug above). The dashboard action (app._index.tsx:314-339) and themes/publish webhook have the same create-then-send shape but deliberately swallow the send error; here the error propagates into the retry loop.

**Recommendation:** Split into two steps: step 'create-scan' returns the scanId (memoized on retry), then step.sendEvent (Inngest's idempotent event-send step) dispatches scan/requested. Alternatively make createScan return the existing active scan instead of throwing when called from the worker.

<a id="log-9"></a>
### LOG-9 · 🟡 MEDIUM — Scope checks treat any error (throttling, network) as 'scope missing' — audit categories silently skipped and diff reports them as resolved

**Where:** `app/services/product-fetcher.server.ts:117-128`

hasProductScope (product-fetcher.server.ts:117-128), hasTranslationScope (translation-fetcher.server.ts:94-105), and hasNavigationScope (redirect-fetcher.server.ts:28-36) return false when the probe query returns ANY error or throws — including THROTTLED rate-limit errors (likely right after the expensive theme-file fetch) and transient network failures. runAuditStep (scan-theme.ts:68-77) then logs 'scope not available' and returns 0 without failing the step, so the scan completes successfully with entire categories (GHOST_TAG, GHOST_PRICE, GHOST_PAGE, GHOST_METAFIELD, GHOST_REDIRECT, GHOST_TRANSLATION) missing. On the next page view, diffScans marks all previously-found findings of those types as 'resolved' — false good news caused by a rate-limit blip.

**Recommendation:** Distinguish ACCESS_DENIED (return false) from THROTTLED/transport errors (rethrow so the Inngest step retries). The GraphQL error objects include extensions.code; check it instead of treating all errors uniformly. Better: check the session's granted scopes (available on the session record) instead of probing with a query.

<a id="log-10"></a>
### LOG-10 · 🟡 MEDIUM — Diff fingerprint includes 3-line context snippet — unrelated edits to adjacent lines report unchanged findings as resolved + new

**Where:** `app/services/scan-differ.server.ts:56-68`

fingerprintFinding hashes filename + findingType + codeSnippet. codeSnippet comes from buildSnippet (scan-engine.server.ts:122-127), which embeds one line before and after the match. Editing an adjacent, unrelated line (or inserting a line above, which shifts the 300-char window) changes the snippet, so the same untouched ghost-code line is reported as one 'resolved' and one 'new' finding in the next scan's diff — overstating churn in both directions. Worse, some detectors embed volatile counts directly in the snippet: the bulk-redirect snippet starts with `${unmatched.length} redirects under ${prefix}` (redirect-detector.server.ts:101), so adding a single redirect flips the finding to resolved+new. Findings with positional descriptions ('also found on line N') escape this only because description isn't hashed.

> **Verifier note:** Fingerprint instability is real, but only edits touching the matched line or its immediately adjacent lines (plus volatile counts/samples in bulk-redirect snippets) change the fingerprint — insertions elsewhere in the file only shift line numbers, which are not hashed and do not affect the diff.

**Recommendation:** Fingerprint on stable identity fields instead: filename + findingType + a normalized matched-line/identifier (e.g. the matched URL, snippet name, meta property, redirect prefix) rather than the display snippet. Store the matched token separately from the display snippet at detection time.

<a id="log-11"></a>
### LOG-11 · 🟡 MEDIUM — Per-line regex detectors miss multi-line tags and `render` inside {% liquid %} blocks — false negatives plus ORPHAN_ASSET false positives

**Where:** `app/services/scan-engine.server.ts:138-166, 216-246`

detectGhostScripts, detectGhostStyles, detectGhostSnippets, detectGhostSections, detectGhostHrefLang, detectGhostCanonical, detectGhostPreconnect, and detectGhostAjax all iterate `lines(file.content)` and run their regexes per line. Any tag formatted across multiple lines (e.g. `<script\n  src="https://static.klaviyo.com/...">` — common in prettier-formatted or theme-store themes) is never matched, a silent false negative. Separately, file-reference-analyzer.server.ts:48-49 and RENDER_RE (scan-engine.server.ts:216) only match `{% render '...' %}` syntax; Liquid's `{% liquid ... render 'snippet-name' ... %}` block form (used by modern OS 2.0 themes) contains bare `render 'x'` statements that match neither pattern. Consequences: app snippets rendered only inside {% liquid %} blocks are missed by GHOST_SNIPPET, and — worse — counted as unreferenced by analyzeFileReferences, producing false ORPHAN_ASSET findings for snippets that are actively rendered (scan-engine.server.ts:1952-1972 emits these when the snippet name matches an app signature).

**Recommendation:** For HTML-tag detectors, match against the full file content (like JSON_LD_BLOCK_RE/TITLE_TAG_RE already do) using lineNumberAtOffset for line attribution. For render references, add a pattern for bare `render|include\s+['\"]name['\"]` inside {% liquid %} blocks (or simply also match `\brender\s+['\"]([^'\"]+)['\"]` anywhere) in both RENDER_RE and file-reference-analyzer.

<a id="log-12"></a>
### LOG-12 · 🟡 MEDIUM — DUPLICATE_META has no Liquid-conditional or multi-value awareness — flags legitimate if/else branches and repeated og:image tags

**Where:** `app/services/scan-engine.server.ts:366-414`

detectDuplicateMetaTags counts every occurrence of each meta name/property in a file and flags the 2nd+ as a duplicate. Unlike detectGhostRobots/Canonical/Title/OG, it performs no LIQUID_CONDITIONAL_RE or comment-block skipping. Two ubiquitous legitimate patterns are flagged: (1) mutually-exclusive branches — `{% if template == 'product' %} <meta property="og:type" content="product"> {% else %} <meta property="og:type" content="website"> {% endif %}` renders exactly one tag at runtime but is reported as a MEDIUM duplicate; (2) genuinely repeatable properties — the Open Graph spec allows multiple og:image (and og:image:secure_url, article:tag) tags per page. Both produce MEDIUM false positives in well-formed themes.

**Recommendation:** Skip meta tags on lines inside or matching Liquid conditionals (reuse the comment/conditional tracking other detectors have), and whitelist repeatable OG properties (og:image, og:image:*, article:tag, og:locale:alternate) from duplicate detection.

<a id="log-13"></a>
### LOG-13 · ⚪ LOW — Protocol-relative URLs bypass cdnDomains matching and are silently dropped from unknown-script collection

**Where:** `app/services/app-lookup.server.ts:22-28`

SCRIPT_SRC_RE deliberately captures protocol-relative URLs (`(https?:)?//...`, scan-engine.server.ts:136), but safeHostname does `new URL(url)` which throws on `//cdn.example.com/x.js`, returning null — so identifyAppFromUrl skips the precise cdnDomains/subdomain matching entirely and relies only on scriptPatterns (which not all signatures duplicate, e.g. Klaviyo's domain list vs its filename-only patterns). Worse, collectUnknownScripts/collectUnknownStylesheets (scan-engine.server.ts:780-785, 818-824) do `try { new URL(url) } catch { continue }`, so every protocol-relative external resource that isn't signature-matched is silently excluded from the unknown-scripts feature — a systematic blind spot for older app embeds, which commonly used `//` URLs. The codebase already has a correct helper: extractDomain (scan-engine.server.ts:1563-1571) prepends `https:` for `//` URLs.

> **Verifier note:** Protocol-relative URLs bypass cdnDomains hostname matching (safeHostname throws/returns null), but app identification is mostly rescued by the identifyAppFromCode fallback whose cssPatterns typically contain the brand name — at the cost of losing the anti-substring-collision precision of domainMatches. The real unmitigated defect is that collectUnknownScripts/collectUnknownStylesheets silently exclude all unmatched protocol-relative external resources from the unknown-resources feature, despite extractDomain (scan-engine.server.ts:1563) already implementing correct normalization.

**Recommendation:** Normalize protocol-relative URLs (prefix `https:`) in safeHostname and in the unknown-resource collectors — or reuse extractDomain from scan-engine — so domain matching and unknown-script collection treat `//host/path` identically to `https://host/path`.

<a id="log-14"></a>
### LOG-14 · ⚪ LOW — createUnknownScripts has no idempotency guard — Inngest step retry after the findings transaction commits duplicates unknown-script rows

**Where:** `inngest/functions/scan-theme.ts:159-166`

Step 2 carefully wraps findings in completeScanWithFindings (delete-then-insert in a transaction, finding.server.ts:196-218) precisely so a step retry after commit is safe — but then calls createUnknownScripts(scanId, unknownScripts) outside that transaction with no preceding deleteMany (unknown-script.server.ts:30-36). If the step result is lost after both writes commit (the exact retry scenario the transaction comment describes), the retry re-runs the whole step: findings are idempotently replaced, but unknown scripts are inserted a second time, duplicating rows shown in the 'unknown scripts' UI and double-counting signature submissions targets.

> **Verifier note:** Accurate except one detail: duplicate UnknownScript rows do not double-count signature submissions, since SignatureSubmission rows are created per merchant action on a specific unknownScriptId — the impact is duplicate entries in the Unrecognized Scripts UI (and duplicate rows matched by acceptSubmissionsForDomain), not doubled submission counts.

**Recommendation:** Mirror the findings pattern: deleteMany({ where: { scanId } }) before createMany inside createUnknownScripts (or include it in the same $transaction as completeScanWithFindings).

<a id="log-15"></a>
### LOG-15 · ⚪ LOW — fetchTranslationSummary lacks the empty-page loop guard the other fetchers have

**Where:** `app/services/translation-fetcher.server.ts:214-220`

The pagination loop advances `fetched += nodes.length` and exits only on `!pageInfo.hasNextPage` or `fetched >= sampleSize`. product-fetcher (lines 185, 265, 346) and the redirect fetcher additionally break when `nodes.length === 0` to protect against a page returning zero nodes with hasNextPage=true (which would otherwise loop forever re-querying the same cursor, burning rate limit inside an Inngest step until timeout). translation-fetcher omits that guard — an inconsistency in the one fetcher whose query (translatableResources with per-node translations) is most likely to return sparse pages.

> **Verifier note:** fetchTranslationSummary (translation-fetcher.server.ts:214-219) lacks the `nodes.length === 0` loop guard present in product-fetcher (185, 265, 346) and content-fetcher (139) — not the redirect fetcher, which also lacks it (redirect-fetcher.server.ts:83-120), as does theme-fetcher. In translation-fetcher the failure mode is a cursor reset to null (line 217, `endCursor ?? null`) restarting pagination from the beginning, not re-querying the same cursor. Fix should add the guard to translation-fetcher and ideally redirect-fetcher for consistency.

**Recommendation:** Add `if (nodes.length === 0) break;` to match the other fetchers' loop-termination guards.

---

## Shopify Compliance & Privacy

<a id="cmp-1"></a>
### CMP-1 · 🟠 HIGH — Optional scopes are declared but no code path ever requests them — five advertised audit features are permanently dead and the app declares scopes it never uses

**Where:** `shopify.app.toml:39`

shopify.app.toml declares optional_scopes = [read_translations, read_products, read_content, read_url_redirects]. Optional scopes are only granted when the app explicitly requests them at runtime via App Bridge (shopify.scopes.request()). A repo-wide grep finds zero occurrences of scopes.request/requestScopes in app/ or inngest/ — there is no UI or server flow that ever asks the merchant for these scopes. Consequently every probe in inngest/functions/scan-theme.ts (steps 3–8, e.g. runAuditStep scope check at lines 68–77, translation check at lines 185–193) returns false in production and the translation, product-tag, price, page, metafield, and redirect audits silently never run for any merchant. This is both a compliance problem (Shopify requires apps to request only scopes they actually use; unused declared scopes are flagged in review) and a listing-accuracy problem (if these detection categories are mentioned in the listing or UI, reviewers will find they never produce results). The scopes_update webhook handler (app/routes/webhooks.app.scopes_update.tsx) is implemented but can never fire for grants that are never requested.

> **Verifier note:** Six audit steps (translation, product-tag, price, page, metafield, redirect) are dead, not five, gated on four optional scopes (read_products covers tag/price/metafield). The "compliance" framing is slightly overstated: optional_scopes are never shown to merchants at install, so this is primarily dead functionality and listing-accuracy risk rather than a scope over-ask; the proposed fix (build the scopes.request flow or remove the scopes and dead steps) is correct.

**Recommendation:** Either (a) build the grant flow: add an App Bridge scopes-request UI (e.g. on the dashboard or settings page) that calls shopify.scopes.request([...]) before the relevant audit features, keeping the scopes_update webhook to sync session.scope; or (b) remove the unused optional_scopes from shopify.app.toml and the dead audit steps until the flow exists. Do not submit for review with declared-but-never-requested scopes.

<a id="cmp-2"></a>
### CMP-2 · 🟡 MEDIUM — Plan state is trusted solely from the app_subscriptions/update webhook with no reconciliation against Shopify

**Where:** `app/routes/webhooks.app.subscriptions.update.tsx:105-161`

Shop.plan is only ever written by this webhook handler (via updateShopPlanByDomain). There is no query of currentAppInstallation.activeSubscriptions anywhere in the codebase (grep for appSubscription returns nothing outside this handler), and no billing config in shopify.server.ts (lines 35–37 explicitly note billing is webhook-driven). The codebase itself acknowledges webhook delivery is best-effort (inngest/functions/poll-theme-changes.ts lines 10–14 built a cron fallback for exactly this reason for themes/publish — but no equivalent exists for billing). Failure modes: (1) a merchant subscribes but the webhook is dropped → they pay while gated to free features (a refund/review risk); (2) a cancellation webhook is dropped → the shop keeps paid features indefinitely; (3) the handler's own race note at lines 152–158 (webhook arrives before the shop row exists, e.g. subscription chosen during install before first /app load creates the Shop record at app/routes/app.tsx:13-17) returns 200 and permanently discards the plan update — the shop is then created with plan="free" and never corrected.

**Recommendation:** Add reconciliation: on authenticated admin load (e.g. in the app.tsx layout loader, throttled to once per N hours per shop) query currentAppInstallation { activeSubscriptions { name status } } and call updateShopPlanByDomain if it disagrees with the stored plan. This also fixes the install-race case since the first dashboard load would self-heal the plan.

<a id="cmp-3"></a>
### CMP-3 · ⚪ LOW — Standard plan receives scheduled weekly scans that contradict the declared plan features and consume the merchant's paid weekly quota

**Where:** `inngest/functions/weekly-scan.ts:36-45`
**Severity:** reviewer said medium, verifier adjusted to **low**

weekly-scan fans out poll/check-shop for all PLANS.STANDARD shops every Sunday 06:00 UTC, but getPlanFeatures(STANDARD) sets scheduledScan: false with the comment 'Manual weekly scans only — automation is Professional' (app/lib/billing.server.ts:27-28), and the billing page sells automation (auto-rescan/daily scans) as Professional-only (app/routes/app.settings.tsx:172-174). The worker (inngest/functions/poll-check-shop.ts:153-169) calls createScan directly, bypassing canStartScan, and the resulting scan counts against countScansForShopSince — so a Standard merchant whose theme changed gets their single weekly scan consumed by the cron and can be blocked from the manual scan they paid for ('Weekly scan limit reached', app/lib/plan-gating.server.ts:47-54). Billing-accuracy mismatches between what a plan promises and what the app does are review-relevant and a merchant-trust issue.

> **Verifier note:** The cron targeting Standard shops is intentional, documented product behavior, not a billing-accuracy violation: /Users/nathanwhitley/shopify/ghost-code-app/docs/pricing-and-plans.md (line 37, changelog 2026-03-11) — the doc CLAUDE.md designates as the source of truth for plans — explicitly grants Standard a "Weekly scheduled scan (automatic scan every Sunday 6 AM UTC)". The real residue is two smaller issues: (1) the scheduledScan:false flag and its comment in app/lib/billing.server.ts:27 are stale and contradict both the doc and the cron — but the flag gates nothing at runtime (only referenced in tests/mocks), so it is dead metadata, not behavior; (2) cron-created scans do count toward the "1 manual scan per week" quota (poll-check-shop.ts:153-169 bypasses canStartScan; countScansForShopSince at app/models/scan.server.ts:181-189 has no origin filter), but because the cron fires Sunday 06:00 UTC and the quota window resets Monday 00:00 UTC (getWeekStartUTC, plan-gating.server.ts:8-15), a cron scan can block a manual scan for at most ~18 hours — and only when the theme actually changed, in which case the merchant just received an equivalent fresh scan. The settings page does not mis-sell: the Standard tile (app.settings.tsx:144-151) simply omits the scheduled scan, so merchants get more than advertised, and "Automatic daily scans" for Professional (line 173) is accurate. Fix: align the scheduledScan flag/comment with the doc, and optionally exempt cron-origin scans from the weekly count.

**Recommendation:** Pick one source of truth: either set scheduledScan: true for Standard and exclude scheduled scans from the quota count (add an origin field on Scan, or exempt cron-created scans in countScansForShopSince), or stop targeting Standard shops in weekly-scan.ts so behavior matches the plan definition and the billing page copy.

---

## Operations & Deployment

<a id="ops-1"></a>
### OPS-1 · 🟠 HIGH — Installed react-router 7.13.1 has a published unauthenticated RCE advisory; 26 prod-dependency vulnerabilities total (1 critical, 18 high)

**Where:** `package.json:47 (react-router ^7.12.0; installed 7.13.1)`

`npm audit --omit=dev` reports 26 vulnerabilities on production dependencies: 1 critical, 18 high, 7 moderate. Most serious: react-router <=7.14.2 — the installed version is 7.13.1 — is subject to GHSA-49rj-9fvp-4h2h, "vendored turbo-stream v2 allows arbitrary constructor invocation via TYPE_ERROR deserialization leading to Unauth RCE", plus an open-redirect (GHSA-2j2x-hqr9-3h42), stored XSS in redirect handling, and two DoS advisories. This server is internet-facing at app.alpenglowsoftware.com. The single critical advisory is protobufjs (<=7.5.7, multiple code-execution/prototype-pollution advisories), pulled in transitively via @sentry/node's OpenTelemetry/grpc chain. Also high: @grpc/grpc-js server-crash advisories, express/qs DoS (express is the actual server via @react-router/serve), path-to-regexp ReDoS.

> **Verifier note:** react-router 7.13.1 (declared ^7.12.0 at package.json:48) is subject to GHSA-49rj-9fvp-4h2h, but that advisory is rated HIGH (not critical) and is a conditional 2-step RCE requiring a pre-existing prototype-pollution vulnerability in app code — not a standalone unauth RCE. The app does use Framework Mode, so it is in scope, and the other react-router advisories (open redirect, __manifest DoS, single-fetch DoS) are directly reachable on this internet-facing server. The single critical (protobufjs <=7.5.7) is pulled in transitively via inngest's OpenTelemetry/grpc chain, not via @sentry/node. Audit totals (26 prod vulns: 1 critical, 18 high, 7 moderate) and the availability of non-breaking fixes via `npm audit fix` are accurate; no CI audit step or Dependabot/Renovate config exists.

**Recommendation:** Run `npm audit fix` (all fixes are available as non-breaking per audit output) and pin react-router packages to >=7.14.3. Add a CI step (e.g. `npm audit --omit=dev --audit-level=high`) or Dependabot/Renovate so production advisories surface automatically rather than at review time.

<a id="ops-2"></a>
### OPS-2 · 🟡 MEDIUM — Database is PostgreSQL (not SQLite) — but no backup/restore story exists anywhere in the repo, and better-sqlite3 ships as a dead production dependency

**Where:** `prisma/schema.prisma:11-14`

Contrary to the stated stack, the datasource provider is `postgresql` (prisma/schema.prisma lines 11-14) and prisma/migrations/migration_lock.toml confirms `provider = "postgresql"`. No code references better-sqlite3 or a `file:` DATABASE_URL — the only mentions are in package.json line 42 and historical session notes in memory/. So the worst-case 'merchant data lost on redeploy' scenario does NOT apply: data lives in an external Postgres, and railway.toml needs no volume. However: (1) there is zero backup documentation or automation in the repo — recovery depends entirely on whatever the Railway Postgres service is configured to do, which is unverifiable from code and not guaranteed; merchant scan history, billing events, and encrypted access tokens are in this DB; (2) better-sqlite3 ^12.8.0 remains a production dependency, compiling/shipping an unused native module into the runtime image (deps stage, Dockerfile line 7) and adding supply-chain surface; @types/better-sqlite3 likewise lingers in devDependencies.

**Recommendation:** Remove better-sqlite3 and @types/better-sqlite3 from package.json. Verify Railway Postgres backups are enabled and document the backup/restore procedure (frequency, retention, how to restore) in the repo; consider a scheduled pg_dump to object storage as a second copy since access-token data is hard to regenerate (merchants would need to reinstall).

<a id="ops-3"></a>
### OPS-3 · 🟡 MEDIUM — Missing INNGEST_SIGNING_KEY/INNGEST_EVENT_KEY silently disables all background jobs; TOKEN_ENCRYPTION_KEY only validated lazily at first use

**Where:** `app/lib/token-encryption.server.ts:21-43 (and inngest/client.ts, app/routes/api.inngest.ts)`

Env-var boot behavior is inconsistent. Fail-fast (good): SHOPIFY_API_SECRET and SHOPIFY_APP_URL throw at module load (app/shopify.server.ts lines 13-21); a missing DATABASE_URL fails at `prisma migrate deploy` during docker-start. Silent degradation (bad): INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY are never referenced or validated anywhere in the repo — the SDK reads them from env internally. If either is unset/wrong in production, the app boots and passes health checks, but event sends and the /api/inngest serve endpoint fail signature validation, so scans sit in PENDING until watch-stale-scans marks them FAILED — merchants see broken scans with no deploy-time signal. Lazy failure (bad): TOKEN_ENCRYPTION_KEY throws in production only inside getKey() (token-encryption.server.ts lines 21-28), i.e. at the first encrypt/decrypt during a merchant install/auth flow — surfacing as runtime 500s instead of a failed boot. SENTRY_DSN is intentionally optional with documented no-op behavior (app/lib/sentry.server.ts), which is fine.

> **Verifier note:** Claim is accurate except one detail: if INNGEST_SIGNING_KEY is wrong, the watch-stale-scans safety net never runs either (it is itself an Inngest cron served via the same broken /api/inngest endpoint), so stuck scans remain PENDING indefinitely rather than being marked FAILED — the failure mode is slightly worse than stated.

**Recommendation:** Create an env.server.ts validation module that asserts SHOPIFY_API_SECRET, SHOPIFY_APP_URL, DATABASE_URL, TOKEN_ENCRYPTION_KEY (including the 64-hex-char check), INNGEST_EVENT_KEY, and INNGEST_SIGNING_KEY at startup when NODE_ENV=production, imported from entry.server.tsx so a misconfigured deploy fails its health check instead of degrading silently.

<a id="ops-4"></a>
### OPS-4 · 🟡 MEDIUM — Unhandled web request errors never reach Sentry — onError only console.errors, no handleError export, captureException unused in routes/services

**Where:** `app/entry.server.tsx:42-45`

Sentry coverage is one-sided. The Inngest path is properly wired: sentryMiddleware in inngest/middleware.ts forwards function errors via captureException, and failureLoggingMiddleware adds structured logs. But on the web path, entry.server.tsx's onError handler (lines 42-45) only does `console.error(error)`, there is no `handleError` export, and grep shows captureException is not called from any file in app/routes or app/services. So an exception thrown in any loader/action (auth failures, billing logic, Prisma errors) produces a raw console line in Railway logs and nothing in Sentry. The only web-side Sentry signal is logger.error → captureMessage (app/lib/logger.server.ts line 33), which sends message strings without stack traces. Additionally, monitor-scan-failures.ts alerting depends entirely on SENTRY_DSN being set — notifications.server.ts Slack/email channels are TODO stubs — and sentry.server.ts line 36 has an unset release, so errors can't be tied to deploys.

**Recommendation:** Export a `handleError(error, { request })` from entry.server.tsx that calls captureException (skipping aborted requests), and call captureException in the renderToPipeableStream onError callback. Set `release: process.env.RAILWAY_GIT_COMMIT_SHA` in Sentry.init. Verify a Sentry alert rule exists for the scan-failure-rate-critical event, since Slack/email are unimplemented.

<a id="ops-5"></a>
### OPS-5 · ⚪ LOW — Secrets (.env) and .git baked into Docker build-stage layers — .dockerignore is incomplete

**Where:** `.dockerignore:1-3 (and Dockerfile line 13)`
**Severity:** reviewer said high, verifier adjusted to **low**

The .dockerignore contains only three entries: .cache, build, node_modules. It does NOT exclude .env or .git. A real .env exists at the repo root (505 bytes) containing SHOPIFY_API_SECRET, TOKEN_ENCRYPTION_KEY, INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY, and DATABASE_URL (verified by key names). Dockerfile line 13 runs `COPY . .` in the build stage, so these secrets and the entire git history are written into image layers. Although the final runtime stage doesn't copy .env, Railway's builder caches and stores intermediate layers, and anyone with access to the build cache or who pulls intermediate images can extract the production Shopify API secret and the token-encryption key. The build also ships memory/, docs/, tests/ into the context, inflating build time.

> **Verifier note:** .dockerignore is incomplete (only .cache/build/node_modules) and Dockerfile:13 `COPY . .` would bake .env into a build-stage layer — but only for local `docker build` runs. The production path cannot leak: .env is gitignored (.gitignore:17, never committed per git log/ls-files), and deploys go through .github/workflows/deploy.yml (actions/checkout of the GitHub repo, then `railway up`), so the Railway build context never contains .env. No key rotation is needed. Fix is hygiene only: add `.env*`, `.git`, `docs/`, `tests/`, `memory/`, `.claude/` to .dockerignore to harden local builds and shrink context.

**Recommendation:** Add `.env`, `.env.*`, `.git`, `memory`, `docs`, `tests`, `.claude` to .dockerignore immediately, then rotate SHOPIFY_API_SECRET, TOKEN_ENCRYPTION_KEY, and both Inngest keys since they have already been copied into build layers on Railway. Note: rotating TOKEN_ENCRYPTION_KEY requires re-encrypting stored shop tokens.

<a id="ops-6"></a>
### OPS-6 · ⚪ LOW — Migrations run on every container start with no rollback plan; redundant runtime `prisma generate` races a 30s health check timeout

**Where:** `package.json:13-14 (docker-start/setup), railway.toml lines 6-7`
**Severity:** reviewer said medium, verifier adjusted to **low**

docker-start runs `prisma generate && prisma migrate deploy` before the server starts, on every boot. Failure modes: (1) if a migration fails mid-apply, Prisma records a failed row in _prisma_migrations that blocks ALL subsequent deploys and restarts until someone manually runs `prisma migrate resolve` — there is no documented rollback/resolve runbook anywhere in the repo; (2) `prisma generate` at runtime is redundant (the client is already generated at build, Dockerfile line 14, and .prisma is copied at line 22) and adds 10-30s of boot latency on a small Railway instance — railway.toml line 7 sets healthcheckTimeout = 30 (seconds), so slow generate+migrate can cause healthy builds to fail health checks and deploys to flap. Partial mitigation: Railway keeps the previous deployment serving when the new one fails its health check, so a failed migration blocks deploys rather than causing an outage — but a crash-restart of the running container (restartPolicyType on_failure, max 5 retries) also re-runs setup, and 5 consecutive failures leave the service down.

**Recommendation:** Remove `prisma generate` from the setup script (also COPY node_modules/@prisma/client from the build stage if needed). Move `prisma migrate deploy` out of container start into Railway's pre-deploy command so migrations run once per deploy, not per restart. Raise healthcheckTimeout to 120-300s. Add a short runbook for failed migrations (`prisma migrate resolve --rolled-back <name>`).

<a id="ops-7"></a>
### OPS-7 · ⚪ LOW — No graceful shutdown: npm→sh→npm→node process chain swallows SIGTERM; in-flight web requests dropped on every deploy

**Where:** `Dockerfile:28`
**Severity:** reviewer said medium, verifier adjusted to **low**

CMD ["npm", "run", "docker-start"] makes npm PID 1, which spawns `sh -c "npm run setup && npm run start"`, which spawns another npm, which finally spawns node. Shell `&&` chains do not forward SIGTERM to the currently running child, so the node server never receives Railway's SIGTERM during deploys/restarts and is SIGKILLed after the grace period. There are no SIGTERM/SIGINT handlers anywhere in app/ or inngest/ (grep confirms zero matches), and @react-router/serve does not drain connections on its own. Impact: in-flight admin requests and webhook deliveries (including mandatory GDPR webhooks) are cut mid-response on every deploy. Mitigation that already exists: scan work runs in Inngest steps which are retried by the Inngest platform, and inngest/functions/watch-stale-scans.ts expires scans stuck >15 min — so background scans recover; only the web tier lacks shutdown handling.

> **Verifier note:** Real issue, but corrected: the npm→sh→npm chain in Dockerfile:28 + package.json "docker-start" does swallow SIGTERM (empirically verified), yet the claim that "@react-router/serve does not drain connections on its own" is false — cli.js lines 143-145 already call server.close() on SIGTERM. The only fix needed is ensuring node receives the signal (e.g., CMD ["npx","react-router-serve","./build/server/index.js"] after moving prisma migrate to a Railway pre-deploy command); no custom handler is required for connection draining. Impact is also smaller than claimed because Shopify retries webhook deliveries and the SQLite volume already forces a deploy downtime window.

**Recommendation:** After moving migrations to a pre-deploy step (previous finding), change CMD to exec node directly: CMD ["npx", "react-router-serve", "./build/server/index.js"] or CMD ["node", "node_modules/@react-router/serve/..."], so node is PID 1 and receives SIGTERM. Optionally add a SIGTERM handler that stops accepting connections and closes the Prisma client.

<a id="ops-8"></a>
### OPS-8 · ⚪ LOW — /health endpoint is static — passes while the database is unreachable

**Where:** `app/routes/health.tsx:1-7`

The health loader returns {status:"ok", timestamp} unconditionally with no dependency checks. railway.toml points its deploy health check here. Boot-time DB failures are caught indirectly because `prisma migrate deploy` runs first, but after boot, a lost Postgres connection (credential rotation, Railway Postgres restart, connection-pool exhaustion) leaves the app reporting healthy while every authenticated route 500s, and external monitoring probing /health sees nothing wrong.

**Recommendation:** Add a `SELECT 1` via prisma.$queryRaw with a ~2s timeout to the health loader and return 503 on failure (or add a separate /health/deep for external monitoring if you want the deploy gate to stay shallow).

<a id="ops-9"></a>
### OPS-9 · ⚪ LOW — Container runs as root; no HEALTHCHECK instruction; on_failure restart policy caps at 5 retries

**Where:** `Dockerfile:17-28 (and railway.toml lines 8-9)`

The runtime stage has no USER directive, so the node server runs as root — any RCE in the app (see the react-router advisory finding) yields root in the container. The image also lacks a HEALTHCHECK instruction (low impact since Railway probes /health externally, but it removes self-healing if the image is ever run elsewhere). In railway.toml, restartPolicyType = "on_failure" with restartPolicyMaxRetries = 5 means a crash-looping container (e.g. transient Postgres outage during the boot-time migrate step) stops being restarted after 5 attempts and stays down until a manual redeploy. No replica/region settings are present (single replica = single point of failure, acceptable at this stage and now safe to scale later since the DB is Postgres, not SQLite).

**Recommendation:** Add `USER node` after the COPY steps in the runtime stage (node:20-alpine ships the `node` user; ensure /app ownership). Consider restartPolicyType = "always" for a web service, or at least raise maxRetries, so transient infra failures self-heal.

---

## Test Coverage & Quality

<a id="tst-1"></a>
### TST-1 · 🟠 HIGH — Access-token storage path (upsertShop/getShopByDomain) has zero tests; its only caller (app.tsx loader) is also untested

**Where:** `app/models/shop.server.ts:48-80`

Coverage run (1308 tests, 56 files) shows shop.server.ts at 64.5% stmts / 50% branch with lines 49-75 uncovered — exactly getShopByDomain() (the only decryptToken call site in the codebase) and upsertShop() (the encrypt-and-store path for Shopify access tokens). tests/models/shop.server.test.ts has 27 tests covering every other function in the file but none for these two. upsertShop contains real logic: encrypt-before-store, an update-only re-install path, and a throw when a new shop has no access token (app/models/shop.server.ts:70-72) — that throw would surface as a user-facing 500 on first authenticated visit via app/routes/app.tsx:16 (`upsertShop(session.shop, session.accessToken || undefined)`), and app.tsx has no test file at all (violates the project's own definition-of-done: 'Tests for both loader and action'). Additionally, a repo-wide grep shows getShopByDomain is called from nowhere — it is dead code, meaning the decrypt half of the token-encryption integration is both untested and unused.

**Recommendation:** Add tests for upsertShop: (1) creates with encrypted token (assert stored value != plaintext and round-trips via decryptToken with TOKEN_ENCRYPTION_KEY set), (2) updates token on re-install, (3) update-only no-op path when token omitted and shop exists, (4) throws when token omitted and shop missing. Add a tests/routes/app.test.ts covering the loader's first-visit upsert branch and the missing-accessToken edge. Either delete getShopByDomain as dead code or add a round-trip test proving stored tokens decrypt correctly.

<a id="tst-2"></a>
### TST-2 · 🟠 HIGH — scan-theme Inngest steps 3-8 (translation + 5 API audits) are untested and pass trivially via error-swallowing scope checks

**Where:** `inngest/functions/scan-theme.ts:53-107, 172-341, 378-392`

Coverage shows scan-theme.ts at 60% stmts / 45% branch. Both tests/inngest/scan-theme.test.ts and tests/integration/scan-pipeline.test.ts mock the admin client as `{ graphql: vi.fn() }` (scan-theme.test.ts:104-106) and do NOT mock product-fetcher/content-fetcher/redirect-fetcher/translation-fetcher. The real scope checks swallow any error and return false (e.g. app/services/product-fetcher.server.ts:125-126, translation-fetcher.server.ts:102-103), so every audit step silently returns 0 in tests. Consequently the happy-path assertion `findingCount: MOCK_FINDINGS.length` (scan-theme.test.ts:190-194) passes only because all six audit steps short-circuit through an error path. Never exercised: the runAuditStep persistence block including the retry-idempotency guard (deleteMany before createFindings) and findingCount recount (scan-theme.ts:81-106), the equivalent translation persistence block (214-236), the fetchAndDetect wiring for each audit (251-257, 271-278, 292-297, 311-317, 333-339), and the explicitly-commented regression guard that prevents overwriting a COMPLETED scan with FAILED on a late retry (scan-theme.ts:380-389 — no test sets db.scan.findUnique to return COMPLETED).

**Recommendation:** Mock the fetcher/detector service modules in scan-theme tests (matching the project's 'mock at boundaries' rule) and add: (1) audit step persists findings with deleteMany-then-create and recounts findingCount (run twice to prove retry idempotency), (2) scope-unavailable skips cleanly, (3) total findingCount sums theme + audit findings, (4) catch-block does not mark FAILED when scan status is already COMPLETED. Also assert in the happy path that hasProductScope etc. were actually consulted, so a silent error-swallow can't masquerade as 'scope unavailable'.

<a id="tst-3"></a>
### TST-3 · 🟡 MEDIUM — Scan-detail route action (signature suggestion) untested, including its tenant-ownership check

**Where:** `app/routes/app.scans.$scanId.tsx:290-316`

tests/routes/app.scans.$scanId.test.ts (13 tests) imports and tests only the loader; the action is never imported. The action handles untrusted form input (missing/blank/over-200-char suggestedAppName, lines 299-306) and enforces tenant isolation via findUnknownScriptForShop (line 309-312) before writing a SignatureSubmission. The model side confirms the gap: app/models/unknown-script.server.ts shows lines 31-57 and 205 uncovered — createUnknownScripts (with its empty-array guard at line 31), submitSignatureSuggestion, and findUnknownScriptForShop (the cross-shop ownership filter `scan: { shopId }`) all have zero tests despite tests/models/unknown-script.server.test.ts having 20 tests for the read/admin-side functions.

**Recommendation:** Add action tests: happy path creates a submission; missing unknownScriptId, blank name, and >200-char name return validation errors without writing; a script belonging to another shop returns 'Unknown script not found' and does NOT call submitSignatureSuggestion (the regression that would matter most). Add model tests for findUnknownScriptForShop (scoped where-clause), createUnknownScripts (empty input short-circuit, scanId stamping), and submitSignatureSuggestion.

<a id="tst-4"></a>
### TST-4 · 🟡 MEDIUM — Inngest middleware (Sentry forwarding, failure notification, duration logging) is 27% covered with no behavioral tests

**Where:** `inngest/middleware.ts:33-114`

Coverage reports middleware.ts at 27.27% stmts / 0% branch (uncovered: 41-42, 55-64, 92-108). There is no tests/inngest/middleware.test.ts. Untested behavior: sentryMiddleware's transformOutput forwarding ctx.result.error to captureException (lines 56-64), failureLoggingMiddleware's Error-vs-non-Error message extraction and fire-and-forget notifyFunctionFailure dispatch (lines 97-109), and loggingMiddleware's duration logging (40-44). This is the production observability path for every background-job failure — if the hook signatures drift on an Inngest SDK upgrade (the comments themselves note SDK contract subtleties like BlankHook), scan failures would silently stop reaching Sentry and notifications, and nothing would catch it.

**Recommendation:** Add unit tests that instantiate each middleware via init().onFunctionRun(...) with a fake fn/ctx, then call transformOutput with `{ result: { error: new Error('boom') } }` and assert captureException / notifyFunctionFailure are called with the right functionId/eventName/runId, that non-Error values are stringified, and that transformOutput returns undefined (output passthrough).

<a id="tst-5"></a>
### TST-5 · 🟡 MEDIUM — GDPR test asserts 'always returns 200 — never 4xx or 5xx' but only tests the happy path; the failure mode it names is untested and actually violated

**Where:** `tests/integration/gdpr-flow.test.ts:371-386`

The test 'shop/redact always returns 200 — never 4xx or 5xx' mocks deleteShopData to resolve successfully, then asserts 200 — it can never fail for the reason its name claims to guard. The in-test comment concedes this: 'the current implementation does not wrap deleteShopData in try/catch, so a DB error would propagate. This test verifies the normal-path guarantee.' Both app/routes/webhooks.tsx (SHOP_REDACT branch) and app/routes/webhooks.app.uninstalled.tsx:15 call deleteShopData with no error handling, so a transient DB error returns 5xx to Shopify. No test anywhere covers deleteShopData rejecting inside a webhook handler, and no webhook test covers authenticate.webhook throwing (invalid HMAC path). The test name documents a compliance contract the code does not enforce — worse than no test, because it reads as covered.

**Recommendation:** Decide the actual contract first: for shop/redact and app/uninstalled, returning 5xx on transient DB failure is arguably correct (Shopify retries, data eventually deleted). Either (a) keep that behavior and add a test asserting the error propagates ('returns 5xx and relies on Shopify retry when deleteShopData fails'), renaming the misleading test, or (b) wrap deleteShopData in try/catch per the test's stated invariant and make the existing test actually mock a rejection. Also add one test per webhook route where authenticate.webhook rejects, asserting the thrown Response propagates.

<a id="tst-6"></a>
### TST-6 · 🟡 MEDIUM — getWeekStartUTC Sunday branch untested; weekly/monthly quota tests are clock-dependent

**Where:** `app/lib/plan-gating.server.ts:8-15, 99-108`

Coverage flags line 12 (`const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1`) as the sole uncovered branch in plan-gating.server.ts — the Sunday case of the ISO-week calculation that resets Standard-plan scan quotas. The function takes an injectable `now` parameter specifically for testability, yet no test in tests/lib/plan-gating.server.test.ts (33 tests) calls it with fixed dates; the period-boundary tests ('passes the start of the current ISO week...' at line 187, and the month-start check using `new Date()` at lines 267-280) recompute expectations from the real clock. The Sunday branch only executes if CI happens to run on a Sunday, and a wrong Sunday offset would let Standard merchants get a second weekly scan (or be wrongly blocked) one day a week — a billing-entitlement bug in the exact category (date math edge cases) the codebase otherwise handles carefully. getScanUsage also constructs `new Date()` internally (lines 99, 105) with no injection point, which is why the tests resort to clock-relative assertions.

**Recommendation:** Add direct unit tests for getWeekStartUTC with fixed dates covering all seven weekdays — especially Sunday (e.g. 2026-06-14 → Monday 2026-06-08T00:00Z), Monday itself, and a month/year-spanning week. For getScanUsage, either thread the optional `now` parameter through or use vi.useFakeTimers with vi.setSystemTime in the period tests to make them deterministic.

<a id="tst-7"></a>
### TST-7 · ⚪ LOW — finding-sort.ts has zero tests, and the vitest coverage config makes non-.server lib files and all routes invisible to coverage

**Where:** `app/lib/finding-sort.ts:14-53`
**Severity:** reviewer said medium, verifier adjusted to **low**

finding-sort.ts (used by app/routes/app.scans.$scanId.tsx to order findings shown to merchants) has no test file — the only sibling in app/lib without one — and its specific behaviors are untested: the unknown-severity fallback (`SEVERITY_ORDER[a.severity] ?? 3`, lines 24 and 47, which silently sorts any new/typo'd severity last), the 4-level tiebreak chain, in-place mutation, and the null/empty guard. This gap is invisible in coverage reports because vitest.config.ts:13-14 sets coverage.include to ['app/**/*.server.ts', 'inngest/**/*.ts'] and excludes app/routes/** — so finding-sort.ts, health-score.ts, finding-classification.ts, format.ts, plans.ts, and every route loader/action (including the well-tested ones) produce no coverage signal at all. A future untested route or pure-lib module would never show up as a coverage regression.

> **Verifier note:** finding-sort.ts (app/lib/finding-sort.ts) has no dedicated tests and no ordering assertions anywhere — though it is executed incidentally by tests/routes/app.scans.$scanId.test.ts via the loader, nothing asserts severity order, the `?? 3` unknown-severity fallback (lines 24, 47), tiebreaks, or mutation semantics. The vitest.config.ts:13-14 coverage blind spot (only app/**/*.server.ts + inngest/** included, routes excluded) is also real and hides finding-sort.ts, health-score.ts, finding-classification.ts, format.ts, plans.ts, and all routes from coverage. However, finding-sort.ts is NOT 'the only sibling in app/lib without one' — plans.ts and logger.server.ts also lack dedicated test files. Severity is low, not medium: this is a regression-protection gap in a 40-line pure function with no current defect, not an active bug.

**Recommendation:** Add tests/lib/finding-sort.test.ts covering: severity ordering HIGH→MEDIUM→LOW, unknown severity sorts last, full tiebreak chain (type → filename → lineNumber), stability on empty/single-element arrays, and in-place mutation semantics. Widen coverage.include to ['app/**/*.{ts,tsx}'] with targeted excludes (components/types/styles if desired) so route modules and pure libs are measured.

<a id="tst-8"></a>
### TST-8 · ⚪ LOW — Token encryption: production key-enforcement branch and wrong-key (rotation) decryption are untested

**Where:** `app/lib/token-encryption.server.ts:22-27, 68-86`

The token-encryption suite is otherwise strong (round-trip, random IV, tamper detection on IV/tag/ciphertext, plaintext migration), but coverage flags line 24 uncovered: the branch where NODE_ENV=production and TOKEN_ENCRYPTION_KEY is missing must throw rather than silently fall back to plaintext storage. That fail-closed guarantee is the security backbone of the no-op dev mode and is only documented, never asserted (tests run with NODE_ENV=test, so the 'without encryption key' suite exercises the permissive branch only). There is also no test for decrypting with a different valid key (key rotation / misconfigured environment): GCM auth will throw, which means every getShopByDomain-style read would crash after a key change — behavior worth pinning so a future 'graceful fallback' refactor is deliberate.

**Recommendation:** Add two tests: (1) vi.stubEnv('NODE_ENV', 'production') with TOKEN_ENCRYPTION_KEY deleted → expect encryptToken/decryptToken to throw with the 'required in production' message; (2) encrypt under key A, set key B, expect decryptToken to throw — documenting that key rotation requires a re-encryption migration.

---

## Performance

<a id="prf-1"></a>
### PRF-1 · 🟡 MEDIUM — scan-theme Inngest function has no concurrency limit and runs CPU-bound synchronous scanning on the web process event loop

**Where:** `inngest/functions/scan-theme.ts:113-167`
**Severity:** reviewer said high, verifier adjusted to **medium**

scanTheme is created with `{ id: "scan-theme", name: "Scan Theme for Ghost Code" }` — no `concurrency` config (contrast poll-check-shop.ts:34 which sets `concurrency: { limit: 5 }`). poll-check-shop's limit only bounds the *check* worker; the `scan/requested` events it dispatches (poll-check-shop.ts:160-169) queue scan-theme runs with unlimited concurrency, so a Sunday cron fan-out (weekly-scan + poll-theme-changes both fire at 6 AM UTC) can run every dispatched shop's scan simultaneously. Each run's `fetch-and-scan` step (scan-theme.ts:128-167) loads the ENTIRE theme into memory (`fetchThemeFiles` accumulates all text files — typically 5-20MB per theme) and then calls `scanThemeFiles(files)` (app/services/scan-engine.server.ts:1914-1981), which is fully synchronous CPU work: 17 regex detectors per file with no `await` or yield points. Inngest functions execute in-process via the `/api/inngest` route (app/routes/api.inngest.ts:22-35) on the single Railway web service that also serves merchant UI, so each scan blocks the event loop for the full synchronous pass and N concurrent scans multiply both memory and blocking.

**Recommendation:** Add `concurrency: { limit: 2-3 }` to the scanTheme function config (per-shop key not needed since createScan already prevents per-shop overlap). Additionally, break the synchronous scan loop in scanThemeFiles with a periodic `await setImmediate()` between files (make it async), or move detection into a worker_thread, so a large theme cannot freeze UI request handling.

<a id="prf-2"></a>
### PRF-2 · 🟡 MEDIUM — Scan detail page ships all findings unpaginated and loads the full previous scan's findings for diffing on every page view

**Where:** `app/routes/app.scans.$scanId.tsx:201-283`

For paid plans the loader calls `getScanById(scanId, { includeFindings: true })` which eager-loads every Finding row (app/models/scan.server.ts:84-90, no take/limit), and `getPreviousScanForTheme` (scan.server.ts:160-171) which `include: { findings: true }` loads the entire previous scan's findings as well — two full result sets per page view, just to compute the diff. The full enriched findings array plus scanDiff arrays are serialized to the client (loader return at lines 266-283) and rendered as one non-virtualized HTML table. Each finding carries a codeSnippet up to 300 chars (buildSnippet, scan-engine.server.ts:122-127), so a theme with ~1,000 findings produces a multi-hundred-KB JSON payload and a 1,000-row DOM table; the previous-scan load doubles the DB read volume.

**Recommendation:** Paginate or cap the findings query (e.g. take: 100 with severity-ordered pages, or server-side filter tabs by severity/type using the existing getFindingsForScan filters). For the diff, select only the fingerprint fields diffScans needs (filename, findingType, codeSnippet, severity, appName, description) instead of full rows, and consider persisting the diff summary at scan-completion time instead of recomputing per page view.

<a id="prf-3"></a>
### PRF-3 · 🟡 MEDIUM — No handling of THROTTLED GraphQL errors — a throttle mid-pagination fails the whole step and re-fetches every page from scratch

**Where:** `app/services/theme-fetcher.server.ts:33-57, 276-281`

checkRateLimit only sleeps proactively when post-response headroom drops below 100 points; it never inspects errors. fetchThemeFiles (lines 276-281) — and the same pattern in product-fetcher, content-fetcher, redirect-fetcher, translation-fetcher — throws on ANY `json.errors`, including THROTTLED, with no retry/backoff. Because the entire multi-page fetch lives inside one Inngest step (`fetch-and-scan`, scan-theme.ts:128-167, deliberately combined due to the 4MB step-output limit), a throttle on page N fails the step and the Inngest retry re-downloads all N pages from page 1 — amplifying the very API load that caused the throttle. The project's own rule (.claude/rules/shopify-graphql.md) requires exponential backoff for THROTTLED errors. rate-limit-monitor.server.ts is observation-only by design (logs warn/error), so nothing in the codebase actually recovers from a throttle.

**Recommendation:** In the shared fetch helpers, detect `errors[].extensions.code === "THROTTLED"` (or message match), sleep based on `extensions.cost.throttleStatus.restoreRate`, and retry the same page with exponential backoff (2-3 attempts) before throwing. This keeps the pagination cursor intact and avoids full re-fetches on transient throttles.

<a id="prf-4"></a>
### PRF-4 · ⚪ LOW — Product catalog is paginated three separate times per scan, with duplicated scope probes and session lookups per audit step

**Where:** `inngest/functions/scan-theme.ts:241-341`
**Severity:** reviewer said medium, verifier adjusted to **low**

The product-tag-audit, price-audit, and metafield-audit steps each independently paginate the same product list: fetchProductTags (product-fetcher.server.ts:140-192, 500 products / 50 per page = up to 10 requests), fetchProductPrices (:201-272, up to 10 requests), fetchProductMetafields (:284-353, up to 5 requests). The three queries differ only in selected fields (tags vs variants vs metafields) — one combined query could fetch all three in a single pagination pass (~10 requests instead of ~25). On top of that, `hasProductScope` issues its `products(first: 1)` probe query three times (once per step via checkScope), and runAuditStep (scan-theme.ts:61-66) plus the translation step each redo `db.shop.findUnique` + `unauthenticated.admin(shop.domain)` (a session-storage lookup) — 7 shop lookups and 7 admin-context constructions per scan. This roughly triples Shopify API cost for the product-based detectors on every scan, multiplied across the weekly/daily cron fan-outs.

> **Verifier note:** Real but downgraded: the substantive waste is ~15 redundant Shopify API requests per scan from triple product pagination plus two duplicate scope probes (correct file path is app/services/product-fetcher.server.ts, not app/services/fetchers/). The "7 shop lookups + admin contexts" portion is negligible local-DB cost and largely inherent to Inngest's step model — the proposed cross-step caching of the admin context is not feasible. A merged product fetch is the valid part of the fix, but must account for per-query cost caps (smaller pages) and the differing 250 vs 500 product caps, and accepts coarser retry granularity.

**Recommendation:** Merge the three product audits into a single step that fetches products once with tags + variants(price, compareAtPrice) + metafields in one GraphQL query, then runs all three detectors over the result. Cache the hasProductScope result (and the admin context) once per scan run instead of per step.

<a id="prf-5"></a>
### PRF-5 · ⚪ LOW — Dashboard trend chart issues N+1 groupBy queries (2 per scan, up to 14) and over-fetches unused byType aggregation

**Where:** `app/routes/app._index.tsx:110-113`
**Severity:** reviewer said medium, verifier adjusted to **low**

`Promise.all(completedScansForTrend.map((s) => getFindingSummary(s.id)))` runs getFindingSummary per trend scan. Each call (app/models/finding.server.ts:84-143) executes TWO `finding.groupBy` queries — one by severity, one by findingType — so a 7-scan trend fires 14 aggregate queries on every dashboard load for Standard/Professional shops. The trend code (app._index.tsx:138-157) only reads `summary.bySeverity`; the entire byType aggregation (26 finding types normalized at finding.server.ts:107-137) is computed and discarded 7 times.

> **Verifier note:** Real but minor: the dashboard trend chart runs a bounded (max 14, parallel) set of groupBy queries and wastes the byType aggregation; worth consolidating into one groupBy by ["scanId","severity"], but impact on dashboard load time is small since queries run concurrently on an indexed column and the loader's Shopify API calls dominate latency. Severity: low, not medium.

**Recommendation:** Replace the per-scan loop with a single query: `db.finding.groupBy({ by: ["scanId", "severity"], where: { scanId: { in: trendScanIds } }, _count: true })`, then bucket results by scanId in memory. One DB round-trip instead of 14, and no wasted byType work.

<a id="prf-6"></a>
### PRF-6 · ⚪ LOW — Scan engine re-splits file content per detector and per finding; GHOST_TEXT runs the full 115-signature regex battery on every line

**Where:** `app/services/scan-engine.server.ts:113-127, 585-610, 1919-1943`
**Severity:** reviewer said medium, verifier adjusted to **low**

Each of the ~15 line-based detectors independently calls `lines(file.content)` → `content.split("\n")` (e.g. lines 141, 180, 221, 258, 299, 374, 588, 653, 724...), so every scannable file is split ~15 times. `buildSnippet` (lines 122-127) re-splits the ENTIRE file content again for every individual match — O(matches × fileSize). Worst, `detectGhostTextFragments` (lines 585-610) calls `identifyAppFromTextFragment` on every line of every file, and that helper (app/services/app-lookup.server.ts:136-146) iterates all 115 APP_SIGNATURES × their textPatterns regexes per call; detectGhostCanonical/Title/Robots similarly call `identifyAppFromCode` (full scriptPatterns + cssPatterns sweep) per candidate. For a 300-file theme with ~200k total lines this is tens of millions of regex executions in a single synchronous pass, directly compounding the event-loop blocking in the scan-theme finding.

> **Verifier note:** The structural redundancy is real but the magnitude is overstated roughly 10x. (1) Re-splitting is confirmed: 16 detectors/collectors each call lines(file.content) (scan-engine.server.ts:141, 180, 221, 258, 299, 374, 588, 653, 724, 770, 807, 1092, 1612, 1705, 1816) plus two direct splits (1235, 1434), and buildSnippet (122-127) re-splits the whole file per finding — but buildSnippet only runs per finding/match, which are sparse. (2) The 'full 115-signature regex battery per line' is wrong: identifyAppFromTextFragment (app-lookup.server.ts:136-146) skips signatures without textPatterns via a cheap property check, and only 11 of 115 signatures define textPatterns (~25 regexes total per line), with a pre-filter at scan-engine.server.ts:590 skipping script/render lines. (3) identifyAppFromCode in detectGhostRobots/Canonical/Title runs per regex match (e.g. line 742), not per line — meta-robots candidates are rare. Empirical benchmark at the claim's own worst case (300 files, ~200k lines) ran the entire scanThemeFiles pass in ~1.5s. Real but a low-severity constant-factor inefficiency in a background Inngest job, not a tens-of-millions-of-regex hotspot; the proposed fix (split once, hoist textPatterns subset) is still cheap and worthwhile.

**Recommendation:** Split each file once into a shared lines array passed to all detectors, and have buildSnippet index into that precomputed array instead of re-splitting. For text-fragment lookup, precompile the signature patterns into one combined alternation RegExp (or at minimum hoist the signatures-with-textPatterns subset) so the per-line cost is one regex test instead of hundreds.

<a id="prf-7"></a>
### PRF-7 · ⚪ LOW — Dashboard loader blocks every page view on live Shopify theme API calls with no caching

**Where:** `app/routes/app._index.tsx:88-95`

Every dashboard load calls `fetchMainTheme(admin)` (one GraphQL round-trip) and, for Standard/Professional shops, `fetchAllThemes(admin)` which paginates serially at 50/page (theme-fetcher.server.ts:174-232). These are parallelized with the DB queries, but page latency is still floored at the Shopify API round-trip (~300-800ms) on every navigation back to the dashboard, and the theme list is only used to populate a picker that rarely changes. This also spends shared per-shop rate-limit budget that scans need.

**Recommendation:** Cache the theme list per shop with a short TTL (e.g. 60-300s in-memory keyed by shop domain, or persist on the Shop row refreshed by the themes/publish webhook the app already handles), or stream it with a deferred loader value so first paint is not blocked on Shopify.

<a id="prf-8"></a>
### PRF-8 · ⚪ LOW — Cron fan-out sends all shop events in a single inngest.send() with no chunking (512-event batch cap)

**Where:** `inngest/functions/weekly-scan.ts:57-69`

weekly-scan (lines 57-69) and poll-theme-changes (poll-theme-changes.ts:71-83) both `inngest.send(shops.map(...))` in one call. The code's own comment notes "Inngest batches up to 512 events in a single send() call" — once the Standard or Professional cohort exceeds 512 shops, the single send exceeds the batch limit and the step fails, retrying the entire fan-out. The preceding `db.shop.findMany` is also unbounded (fine at current scale, but it is the same scaling cliff).

> **Verifier note:** Both coordinators (inngest/functions/weekly-scan.ts:57-69, poll-theme-changes.ts:71-83) do send all shop events in one unchunked inngest.send(), and SDK 3.54.0 does not chunk internally (Inngest.js _send posts the whole array; 413 = hard step failure retrying the entire fan-out). However, the "512-event batch cap" is wrong: Inngest's documented limits are 5,000 events per send() request and a 512KB request payload — the code comment "Inngest batches up to 512 events" conflates 512KB with 512 events. With ~100-150 byte events, the real cliff is ~3,400-5,000 paid-plan shops per cohort, not 512. The unbounded findMany and missing chunking remain a genuine (if very distant) scaling cliff, and the misleading comment should be fixed alongside any chunking.

**Recommendation:** Chunk the event array into batches of ≤512 (e.g. a simple for-loop over slices) inside the fan-out step. Optionally page the shop query with cursor + take in the same loop so neither the query result nor the send payload grows unbounded.

<a id="prf-9"></a>
### PRF-9 · ⚪ LOW — Index hygiene: unused Finding severity index, unindexed expireStaleScans query shape, unindexed Session.shop

**Where:** `prisma/schema.prisma:134-135`

Three minor mismatches between declared indexes and actual query shapes: (1) `@@index([severity])` on Finding (schema.prisma:135) is never useful — every Finding query filters by scanId first (finding.server.ts:42-55, 62-66, 152-155), so the index only adds write overhead on the hottest insert path (createMany of all scan findings). (2) `expireStaleScans` (app/models/scan.server.ts:201-214) filters `status IN (...) AND createdAt < cutoff` with no leading-column index (only `@@index([shopId, createdAt])` exists), forcing a full Scan table scan on every daily cron — harmless now, degrades linearly with total scans. (3) Session has no index on `shop` (schema.prisma:20-38) while `deleteShopData` runs `session.deleteMany({ where: { shop: domain } })` (shop.server.ts:165) and the Shopify session storage queries by shop for cleanup.

**Recommendation:** Drop `@@index([severity])` from Finding; add `@@index([status, createdAt])` to Scan for the stale-scan sweep; add `@@index([shop])` to Session. All three are one-line schema changes plus a migration.

---

## Code Quality & DRY

<a id="qlt-1"></a>
### QLT-1 · 🟠 HIGH — Scan-engine detectors repeat the same match-classify-push boilerplate ~30 times in one 1,982-line file

**Where:** `app/services/scan-engine.server.ts:138-1876`

Every per-file detector (detectGhostScripts:138, detectGhostStyles:177, detectGhostSnippets:218, detectGhostSections:255, detectGhostHrefLang:296, detectGhostRobots:721, detectGhostCanonical:1084, detectGhostTitle:1232, detectGhostOg:1432, detectGhostPreconnect:1607, detectGhostFont:1700, detectGhostAjax:1811, etc.) repeats the identical skeleton: iterate lines() -> reset module regex lastIndex -> exec loop -> identifyAppFrom*() -> buildSnippet() -> classifySeverity() -> findings.push({filename, lineNumber, codeSnippet, findingType, severity, appName, description}). The literal findings.push({...}) block appears 31 times. On top of that, Liquid comment-block tracking is re-implemented twice in two different styles: an inline insideComment flag in detectGhostCanonical (1090-1099), detectGhostPreconnect (1612-1619), detectGhostFont (1703-1712), and detectGhostAjax (1814-1823), versus a commentedLines Set built in detectGhostTitle (1237-1245) and detectGhostOg (1436-1444). The LIQUID_CONDITIONAL_RE skip is likewise copy-pasted into 6 detectors. Adding a new detector today means copying ~40 lines of scaffolding; fixing a bug in comment handling means fixing it in 6 places (and it has already drifted into two implementations).

**Recommendation:** Extract three helpers: (1) makeFinding(file, lineNumber, findingType, description, appName?) that does buildSnippet + classifySeverity + object construction; (2) a line-iterator like forEachLineMatch(file, regex, cb, { skipLiquidComments, skipLiquidConditionals }) that owns comment/conditional tracking in one place; (3) a getCommentedLines(content) utility shared by the offset-based detectors. Then split the file into app/services/detectors/*.server.ts (one per finding type) with scan-engine as the orchestrator. Detector logic stays explicit; only the repeated scaffolding is factored out.

<a id="qlt-2"></a>
### QLT-2 · 🟡 MEDIUM — Module-scope /g regexes with manual lastIndex resets — a repeated footgun the code itself warns about 28 times

**Where:** `app/services/scan-engine.server.ts:134-136, 143, 182, 223, etc. (28 reset sites)`
**Severity:** reviewer said high, verifier adjusted to **medium**

Detection regexes are declared at module scope with the /g flag and shared across functions (SCRIPT_SRC_RE is used by both detectGhostScripts:143 and collectUnknownScripts:772; JSON_LD_BLOCK_RE by detectGhostJsonLd:446 and detectJsonLdConflicts:515). Because /g regexes carry lastIndex state, every call site must remember `RE.lastIndex = 0` — there are 28 such resets, each accompanied by an IMPORTANT comment (e.g. lines 134-135, 1538-1540, 1673-1675, 1777-1780). One forgotten reset in a future detector silently skips matches with no test failure unless the exact interleaving is exercised. This is a fragility hotspot, not a style issue — the file documents the hazard 6+ times instead of eliminating it.

> **Verifier note:** The pattern, the 28 reset sites, the cross-function regex sharing (SCRIPT_SRC_RE at lines 143/772, LINK_STYLESHEET_RE at 182/809, JSON_LD_BLOCK_RE at 446/515), and the repeated warning comments are all real. However, the stated failure mode ("one forgotten reset silently skips matches") is weaker than claimed: every exec loop in the file runs to exhaustion with no break statements, and a global regex's lastIndex auto-resets to 0 when exec returns null — so a single forgotten reset would currently be harmless. Stale state requires a second future mistake (an early-exit loop, a bare .test()/single .exec() on a /g regex, or a mid-loop throw). It is a genuine maintainability fragility hotspot worth the matchAll refactor, but not a high-severity reachable defect.

**Recommendation:** Replace exec loops with `for (const match of text.matchAll(RE))` (matchAll throws if the regex is non-global and never mutates shared state observably across calls since it clones internally) — or construct the regex locally per call (`new RegExp(SRC, 'gi')`). Either removes the entire class of bug and deletes 28 resets plus their warning comments. Fold into the forEachLineMatch helper from the detector refactor.

<a id="qlt-3"></a>
### QLT-3 · 🟡 MEDIUM — GraphQL cursor-pagination loop copy-pasted 8 times across 5 fetcher services

**Where:** `app/services/product-fetcher.server.ts:140-353 (also theme-fetcher 174-317, content-fetcher 84-146, translation-fetcher 145-230, redirect-fetcher 74-128)`
**Severity:** reviewer said high, verifier adjusted to **medium**

fetchProductTags (140-192), fetchProductPrices (201-272), fetchProductMetafields (284-353), fetchAllThemes (theme-fetcher 174-232), fetchThemeFiles (theme-fetcher 244-317), fetchPages (content-fetcher 84-146), fetchTranslationSummary (translation-fetcher 145-230), and fetchRedirects (redirect-fetcher 74-128) all repeat the identical ~40-line loop: build {first, after} variables with the same `...(cursor !== null ? { after: cursor } : {})` spread, inline-cast the JSON response shape, check `json.errors?.length` and throw "[service] Failed to fetch X", extract nodes/pageInfo with the same `?? []` / `?? {}` defaults, advance hasNextPage/cursor, call checkRateLimit(json.extensions). The maxItems-cap logic additionally diverges subtly between copies (products.length vs totalFetched counters; redirect-fetcher caps inside the node loop). Separately, the scope-probe helpers hasProductScope (117-128), hasContentScope (content-fetcher 55-66), hasTranslationScope (translation-fetcher 94-105), and hasNavigationScope (redirect-fetcher 28-36) are four byte-identical try/probe-query/return-!errors functions.

> **Verifier note:** Claim is accurate except: the four scope-probe helpers are near-identical, not byte-identical (queries differ; redirect-fetcher omits the data field in its cast), and the proposed generic paginateConnection must also handle fetchThemeFiles' null-theme early-break and checkThrottleStatusFromExtensions call plus fetchTranslationSummary's count-aggregation, making the refactor slightly less drop-in than stated.

**Recommendation:** Add app/services/graphql-pagination.server.ts with a generic `paginateConnection<TNode>(admin, query, variables, selectConnection, { pageSize, maxItems, onPage })` that owns the variables spread, error throw (parameterized service label), nodes/pageInfo extraction, cursor advance, and checkRateLimit call. Each fetcher shrinks to its query string, a node-mapping callback, and any post-filter. Add a single `hasScope(admin, probeQuery)` and define the four scope checks as one-liners. This eliminates ~250 duplicated lines and makes the cap-counting semantics consistent.

<a id="qlt-4"></a>
### QLT-4 · 🟡 MEDIUM — Rate-limit handling split across two modules that both hand-parse extensions.cost.throttleStatus; shared helper lives in theme-fetcher

**Where:** `app/services/theme-fetcher.server.ts:33-57 (and app/lib/rate-limit-monitor.server.ts:76-111)`

checkRateLimit (theme-fetcher 33-57) and checkThrottleStatusFromExtensions (rate-limit-monitor 76-111) both unsafely cast `extensions` and walk extensions.cost.throttleStatus — two independent parsers of the same structure with different validation rigor (the fetcher version uses bare `as Record<string, unknown>` casts with no number checks; the monitor version validates types). Additionally, checkRateLimit is generic backoff infrastructure but lives in theme-fetcher.server.ts, forcing product-fetcher:8, content-fetcher:8, translation-fetcher:14, and redirect-fetcher:8 to import a theme module they otherwise don't care about — and its log line is hardcoded as "[theme-fetcher] Rate limit headroom low" (line 48-51, via console.log not logger), so backoff triggered from a product fetch logs under the wrong subsystem.

**Recommendation:** Move checkRateLimit into app/lib/ next to rate-limit-monitor, extract one `parseThrottleStatus(extensions): ThrottleStatus | null` used by both consumers, switch the console.log to logger.info, and drop the misleading service prefix (or take a caller label parameter). This also fixes the layering oddity of four services importing theme-fetcher for non-theme functionality.

<a id="qlt-5"></a>
### QLT-5 · 🟡 MEDIUM — translation-audit step in scan-theme duplicates runAuditStep's persist/recount/log block

**Where:** `inngest/functions/scan-theme.ts:172-237`

runAuditStep (lines 53-107) was explicitly created to eliminate the check-scope -> fetch -> detect -> deleteMany -> createFindings -> recount -> scan.update -> logger.info boilerplate, and steps 4-8 use it. But the translation-audit step (172-237) re-implements that exact sequence inline: shop lookup + unauthenticated.admin (174-178 vs helper 61-66), scope-check-and-skip logging (185-193 vs 68-77), and the full persist block deleteMany/createFindings/count/update/log (214-234 vs 81-104). The only genuinely unique logic is the empty-translations early return (196-203) and the always-empty installedAppNames pass-through — both of which fit inside a fetchAndDetect callback. Two parallel copies of the idempotency-guard persist logic means a future fix (e.g. wrapping delete+create in a transaction) must be made twice.

**Recommendation:** Route translation-audit through runAuditStep with findingType: GHOST_TRANSLATION and a fetchAndDetect that calls auditTranslations, returns [] when totalTranslations === 0, and invokes detectOrphanedTranslations(audit, []). Deletes ~50 duplicated lines and unifies the idempotency guard.

<a id="qlt-6"></a>
### QLT-6 · 🟡 MEDIUM — Health-score tile and HTML-table CSS duplicated across routes with hardcoded hex values, bypassing the shared.ts token system

**Where:** `app/routes/app.scans.$scanId.tsx:567-721, 1069-1090, 1142-1162 (and app/routes/app._index.tsx:575-788, app.scans._index.tsx:48-69)`

Three separate duplications: (1) The health-score tile CSS in app._index.tsx (.health-score-tile/-number/-label, lines 587-654) and app.scans.$scanId.tsx (.scan-tile--health-*, .scan-tile__big-number/-label, lines 602-652) are the same rules — same 48px/-2px hero number, same pill label, same tint hexes (#c8e6c1/#f1f8ef, #fdf0cd/#fffcf2, #fde8e8/#fef6f6) — under different class names, so a tint change must be made in two files. (2) The bordered/zebra/hover table CSS is pasted four times: .findings-table ($scanId 123-156), .app-map-table ($scanId 1069-1090), .unknown-scripts-table ($scanId 1142-1162), .scan-history-table (scans._index 48-69) — identical th/td border, padding, header background, nth-child(even) rules. (3) app/styles/shared.ts declares itself the "single source of truth" for colors, yet these style blocks hardcode the same hexes dozens of times (#d72c0d, #1a8a3f, #b98900, #6d7175, #202223, #e1e3e5, #8c9196); only scan-history interpolates tokens. Also .dashboard-section-title (app._index 596-601) and .scan-section-title ($scanId 580-585) are identical rules with different names. Per the portfolio design standards (guide/design-standards.md mandates shared.ts usage), this is exactly the drift that file exists to prevent.

**Recommendation:** Extract a HealthScoreTile component (props: score, tone, label, optional delta) used by both routes; extract the table CSS into one exported constant or a DataTable wrapper component next to FindingsTable (which already exists in $scanId — generalize it); replace hardcoded hexes in the remaining <style> blocks with template-interpolated tokens from shared.ts (STATUS_TINTS, TEXT_SUBDUED, BORDER_DEFAULT), as scans._index already demonstrates.

<a id="qlt-7"></a>
### QLT-7 · 🟡 MEDIUM — createScan + Inngest scan/requested dispatch trio implemented 3 times with divergent failure handling

**Where:** `app/routes/app._index.tsx:314-339 (also webhooks.themes.publish.tsx:61-80, inngest/functions/poll-check-shop.ts:153-182)`

The create-scan-then-dispatch sequence appears in three places with three different error policies: the dashboard action (app._index.tsx:314-339) catches createScan errors and returns them, then catches inngest.send failures with console.error and proceeds (scan stuck PENDING but redirect succeeds); the themes/publish webhook (61-80) wraps both calls in one try/catch with logger.warn and returns 200; poll-check-shop (153-182) wraps neither — an inngest.send failure there leaves an orphan PENDING scan that suppresses future polls until watch-stale-scans expires it. The divergence isn't a deliberate per-context choice (nothing documents why dispatch failure is tolerable in one path and unhandled in another), it's drift from copy-adapting.

> **Verifier note:** Mostly accurate, with two refinements: (1) the divergence in the two route files is partially documented intent — app._index.tsx:322-324 explains the best-effort dispatch policy and webhooks.themes.publish.tsx:73-75 explains returning 200 to avoid Shopify retry storms — so "nothing documents why" only holds for poll-check-shop (and the webhook's catch comment misattributes inngest.send failures as "scan already in progress or creation failed"). (2) poll-check-shop is worse than "unwrapped": because createScan and inngest.send share one non-idempotent step.run, Inngest's automatic step retries cannot recover — the retry trips the active-scan guard in scan.server.ts and fails permanently, guaranteeing the orphan PENDING scan.

**Recommendation:** Add a service-level `createAndDispatchScan(shopId, themeId, themeName, quota?)` in app/services (services may import models per the architecture rules) that owns the createScan + inngest.send pairing and one documented failure policy (e.g. mark scan FAILED or log via logger if dispatch fails). The three call sites keep their context-specific gating (quota, plan checks) but share the dispatch core. Also fixes the console.error-instead-of-logger at app._index.tsx:332.

<a id="qlt-8"></a>
### QLT-8 · ⚪ LOW — Dead and vestigial exports: getShopByDomain never used; submission/billing model functions are test-only; translation detector keeps a removed-feature parameter

**Where:** `app/models/shop.server.ts:48-52 (also unknown-script.server.ts:154-203, billing-event.server.ts:48-95, translation-detector.server.ts:46, inngest/functions/scan-theme.ts:206-208)`
**Severity:** reviewer said medium, verifier adjusted to **low**

(1) getShopByDomain (shop.server.ts:48-52) is imported nowhere — not in app code, inngest, scripts, or tests — yet the ShopMetadata doc comment (line 6) still directs readers to it; it also decrypts access tokens, so it's dead security-sensitive surface. (2) updateSubmissionStatus (unknown-script.server.ts:154) and acceptSubmissionsForDomain (:171) are referenced only by their own tests; the scripts/review-submissions.ts admin CLI imports only getSubmissionsByDomain and getSubmissionStats, so the accept/reject half of the review workflow is unreachable. (3) getBillingEventsForShop and getBillingEventStats (billing-event.server.ts:48, 72) are test-only. (4) hasInstalledTranslationApp and the installedAppNames parameter of detectOrphanedTranslations (translation-detector.server.ts:46, 68) are vestigial — scan-theme.ts:206-208 documents that the Permission Audit was removed and always passes [], so the installed-app branch can never execute in production.

**Recommendation:** Delete getShopByDomain and fix the stale doc comment on ShopMetadata. For the submission-review and billing-event functions, either wire them into scripts/review-submissions.ts / the admin metrics page (they look intended for that) or delete them — keeping tested-but-unreachable code inflates the test suite's apparent coverage. Remove the installedAppNames parameter and hasInstalledTranslationApp, simplifying detectOrphanedTranslations to its actually-exercised path; git history preserves the old logic if appInstallations access ever returns.

<a id="qlt-9"></a>
### QLT-9 · ⚪ LOW — getFindingSummary hand-maintains a 26-key FindingType zero-map and duplicates severity normalization from countFindingsBySeverity

**Where:** `app/models/finding.server.ts:98-137 (and 61-78)`

getFindingSummary initializes typeCounts by listing all 26 FindingType members explicitly (lines 107-134) — every new detector requires editing this literal (alongside DEFAULT_SEVERITY in severity-classifier.server.ts and FINDING_TYPE_LABELS in app.scans.$scanId.tsx:50-77, which are at least exhaustively useful). Unlike the Record-typed DEFAULT_SEVERITY map, this block is pure boilerplate: it encodes no information beyond "start at 0". Additionally the severity-counts normalization loop in getFindingSummary (98-105) duplicates countFindingsBySeverity (61-78) — and countFindingsBySeverity itself is only referenced by tests, so the production path and the tested helper have quietly forked.

> **Verifier note:** Minor overstatement only: getFindingSummary is itself directly tested (tests/models/finding.server.test.ts:288-339), so the fork is a DRY/dead-export issue, not a test-coverage gap; also the typeCounts literal is Record&lt;FindingType, number&gt;-typed, so new enum members fail typecheck there rather than silently breaking — the silent-fallback risk applies only to FINDING_TYPE_LABELS.

**Recommendation:** Replace the literal with `Object.fromEntries(Object.values(FindingType).map((t) => [t, 0])) as Record<FindingType, number>` (same for the severity map). Then either have getFindingSummary call countFindingsBySeverity or delete the unused export. FINDING_TYPE_LABELS should gain a `satisfies Record<FindingType, string>` annotation so a new enum member fails typecheck instead of silently falling back to underscore-replacement at runtime ($scanId.tsx:106).

<a id="qlt-10"></a>
### QLT-10 · ⚪ LOW — Logger vs console.* inconsistency — including GDPR audit events logged via raw console.log

**Where:** `app/models/shop.server.ts:161, 171 (also services/theme-fetcher.server.ts:48-51, 286-289; routes/app._index.tsx:332)`

app/lib/logger.server.ts provides structured JSON logging and is used consistently across webhooks, inngest functions, and admin routes — but five call sites bypass it: deleteShopData logs its GDPR delete_shop_data_start/complete events with console.log (shop.server.ts:161, 171), which is the one place structured, greppable logs matter most for compliance evidence; theme-fetcher logs rate-limit backoff and missing-theme conditions with console.log (48-51, 286-289); and the dashboard action logs Inngest dispatch failures with console.error (app._index.tsx:332). These bypasses lose the level/JSON envelope, so log-based alerting (e.g. the monitor-scan-failures pattern) cannot see them.

**Recommendation:** Switch all five sites to logger.info/warn/error with the existing context-object convention. Cheap mechanical fix; consider an ESLint no-console rule (allowlisting logger.server.ts and entry.server.tsx) to prevent regression.

<a id="qlt-11"></a>
### QLT-11 · ⚪ LOW — findUnique-then-update double round-trip repeated 3 times in shop model

**Where:** `app/models/shop.server.ts:90-140`

updateShopPlanByDomain (90-102), updateThemePublishTimestamp (112-123), and dismissReviewPrompt (131-140) all use the same two-query shape: findUnique to check existence, return null if missing, then update. Three copies of the pattern, each doing two DB round-trips where one would do, and the check-then-update is non-atomic (a concurrent shop/redact between the two queries throws an unhandled P2025 instead of returning null — the exact case the null return exists to handle, since these are called from webhook handlers racing uninstall).

> **Verifier note:** All three functions duplicate the non-atomic findUnique-then-update pattern as claimed; the only inaccuracy is that dismissReviewPrompt is called from the dashboard UI action (app/routes/app._index.tsx:246), not a webhook handler — only updateShopPlanByDomain and updateThemePublishTimestamp sit in webhook paths racing uninstall, and a P2025 there causes one 500/retry cycle that resolves on the next delivery.

**Recommendation:** Extract one helper, e.g. `updateShopIfExists(where, data, select)`, that issues a single db.shop.update wrapped in a try/catch returning null on Prisma error code P2025. One round-trip, atomic, and the three functions become one-liners. Explicit error-code handling matches the 'explicit over clever' preference better than the current TOCTOU-prone pre-check.

<a id="qlt-12"></a>
### QLT-12 · ⚪ LOW — URL hostname extraction helper privately re-implemented in 3 modules

**Where:** `app/services/scan-engine.server.ts:1563-1571 (also app/services/app-lookup.server.ts:22-28, app/models/unknown-script.server.ts:69-75)`

Three private copies of try { new URL(url).hostname } catch { return null }: extractDomain in scan-engine.server.ts (1563-1571, with protocol-relative // normalization), safeHostname in app-lookup.server.ts (22-28, without it), and extractDomain in unknown-script.server.ts (69-75, without it). The protocol-relative handling difference is a real behavioral fork: app-lookup's identifyAppFromUrl returns null hostname for `//cdn.judge.me/...` URLs and silently falls back to pattern matching, while scan-engine's preconnect detector handles them correctly — the same input class gets different treatment depending on which copy runs.

> **Verifier note:** Four (not three) private copies of hostname extraction exist; only scan-engine.server.ts:1563 normalizes protocol-relative URLs. The cited Judge.me example is misleading — its /judge\.me/ scriptPattern still matches the full URL string, so it survives the fallback; the real misses are signatures whose cdnDomains lack a URL-matching pattern (e.g., Lucky Orange's cloudfront domain). The most consequential instance is the inline new URL() at scan-engine.server.ts:780-785 and 819-824, which silently drops protocol-relative unknown scripts from collection entirely. Proposed shared app/lib/url.ts extractHostname should replace all four sites.

**Recommendation:** Create app/lib/url.ts exporting one `extractHostname(url: string): string | null` with the protocol-relative normalization (the strictly more capable variant) and use it in all three modules. Small, but it removes a behavioral inconsistency, not just text duplication.

---

## Hardcoded URLs & Links

<a id="url-1"></a>
### URL-1 · 🟠 HIGH — Managed Pricing deep link uses client_id instead of the app handle

**Where:** `app/routes/app.settings.tsx:33-43`

The billing page builds the plan-selection URL as `https://${shopDomain}/admin/charges/${GHOST_CODE_CHARGE_ID}/pricing_plans` with `GHOST_CODE_CHARGE_ID = "3e80de5fa6065400e94de3f1fe7f0c8b"`. That value is the app's client_id (identical to `client_id` in shopify.app.toml line 3), not an app handle — and the code comment calls it a "Charge ID from the Partner Dashboard," a concept that does not exist for this URL. Shopify's Managed Pricing docs (shopify.dev/docs/apps/launch/billing/shopify-app-pricing, verified today) specify the format `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`. The app's actual handle is `ghost-code` (confirmed live: https://apps.shopify.com/ghost-code returns the Ghost Code listing). With the client_id in the handle slot, merchants clicking any upgrade CTA likely land on an admin 404 instead of the plan picker. This is the app's only billing entry point — every upgrade CTA routes here (app/routes/app._index.tsx:969 links to /app/settings; app/routes/app.tsx:33 'Billing' nav link).

**Recommendation:** Replace the client_id with the app handle: `const pricingPlansUrl = \`https://admin.shopify.com/store/${shopDomain.replace(".myshopify.com", "")}/charges/ghost-code/pricing_plans\``; (or keep the legacy `https://${shopDomain}/admin/charges/ghost-code/pricing_plans` redirect form). Fix the misleading comment, and verify by clicking the Upgrade button in a dev store admin.

<a id="url-2"></a>
### URL-2 · 🟡 MEDIUM — Admin API client pinned to 2025-10 while webhooks use 2026-04; 2025-10 expires October 2026

**Where:** `app/shopify.server.ts:26, 44`

`shopifyApp({ apiVersion: ApiVersion.October25 })` and the exported `apiVersion` pin all Admin GraphQL calls to 2025-10, while shopify.app.toml line 12 sets `[webhooks] api_version = "2026-04"`. Two concrete problems: (1) webhook payloads (app_subscriptions/update, themes/publish, etc.) are delivered at the 2026-04 schema while all queries run against 2025-10, so payload shapes and query results can diverge; (2) 2025-10 reaches end of support on 2026-10-01 (~4 months from today, 2026-06-12), after which Shopify silently coerces requests to the oldest supported version. The installed SDK (@shopify/shopify-api 12.3.0 via @shopify/shopify-app-react-router 1.1.1) already exports `ApiVersion.April26 = "2026-04"`, so the fix requires no dependency upgrade.

**Recommendation:** Change both occurrences to `ApiVersion.April26` to match the toml's 2026-04, run the test suite against the new version, and add a release-cadence reminder to bump quarterly.

<a id="url-3"></a>
### URL-3 · ⚪ LOW — App Store review link points to a non-existent #reviews anchor

**Where:** `app/routes/app._index.tsx:529`

The post-scan review banner's 'Leave a Review' button calls `window.open("https://apps.shopify.com/ghost-code#reviews", "_blank")`. The listing URL itself resolves (HTTP 200, verified today), but the listing page's reviews section uses `id="adp-reviews"` — there is no `id="reviews"` element on the page — so the fragment is dead and merchants land at the top of the listing rather than at the reviews section, with no write-review affordance in view.

**Recommendation:** For an embedded app, use the App Bridge Reviews API (`shopify.reviews.request()`) so the review modal opens inside the admin without leaving the app. If keeping a link, use the write-review deep link (`https://apps.shopify.com/ghost-code#modal-show=WriteReviewModal`) or at minimum the real anchor `#adp-reviews`.

<a id="url-4"></a>
### URL-4 · ⚪ LOW — App client_id duplicated as a hardcoded literal outside config

**Where:** `app/routes/app.settings.tsx:33`

`3e80de5fa6065400e94de3f1fe7f0c8b` is hardcoded in the route component, duplicating `client_id` in shopify.app.toml line 3. The client_id is not secret (it ships to the browser as the API key anyway), but the duplication means a future app migration or client_id rotation would silently break this page, and the mislabeled comment ("Charge ID") already shows the duplication caused confusion. Note this becomes moot if the high-severity fix above replaces it with the app handle — but the handle should then be a named constant or env value (`SHOPIFY_APP_HANDLE`), not an inline literal.

**Recommendation:** After fixing the pricing URL, source the app handle from a single shared constant or environment variable rather than an inline string in the route, and delete the incorrect 'Charge ID' comment. All other environment-specific values checked (SHOPIFY_APP_URL, SHOPIFY_API_KEY/SECRET, ADMIN_SHOP_DOMAINS) are correctly read from env, and the remaining external URLs verified live: app.alpenglowsoftware.com (200), apps.shopify.com/ghost-code (200, correct listing), cdn.shopify.com Inter font CSS (200), legal.alpenglowsoftware.com privacy and terms pages (200).

---

## Feature opportunities

Proposed by a product-minded reviewer grounded in existing code; not adversarially verified — treat as a brainstorm shortlist.

| # | Idea | Value | Effort |
|---|------|-------|--------|
| F-1 | Finding lifecycle: dismiss, mark-as-fixed, and false-positive allowlist | high | medium |
| F-2 | Merchant email digest: weekly scan results and new-finding alerts | high | medium |
| F-3 | Branded PDF/HTML Theme Audit Report (Pro) | high | small |
| F-4 | 'Before you uninstall' scan mode (snapshot + diff) | high | large |
| F-5 | Scan asset files (assets/*.js, *.css) — currently a detection blind spot | high | medium |
| F-6 | Render-blocking severity escalation for ghost scripts/styles | medium | small |
| F-7 | Per-app 'leftover weight' leaderboard on the dashboard | medium | small |
| F-8 | Ship the Health Score trend chart (spec already written) | medium | small |

### F-1 · Finding lifecycle: dismiss, mark-as-fixed, and false-positive allowlist  (high value / medium effort)

Findings are currently immutable rows with no status (prisma/schema.prisma Finding model has no status field; no dismiss/ignore action exists in app/routes/app.scans.$scanId.tsx). A merchant who intentionally keeps a tracking pixel or disputes a finding sees the same 'problem' on every scan forever — the fastest path to churn for an audit tool. Add a status enum (ACTIVE/DISMISSED/FIXED/FALSE_POSITIVE) plus a per-shop suppression list keyed by finding fingerprint. The fingerprinting logic already exists in app/services/scan-differ.server.ts (it matches findings across scans to compute new/resolved), so carrying dismissals forward is a natural extension. Bonus: false-positive reports become telemetry that feeds the existing signature-curation pipeline (scripts/review-submissions.ts), directly addressing the failure mode that got competitor Cleanify delisted (per docs/product-strategy.md line 137).

### F-2 · Merchant email digest: weekly scan results and new-finding alerts  (high value / medium effort)

The Standard plan's weekly scheduled scan (inngest/functions/weekly-scan.ts, Sundays 6 AM UTC) and Pro's auto-rescan run silently — results are only visible if the merchant opens the embedded app. app/lib/notifications.server.ts already has the notification scaffolding with Slack/email stubbed (lines 47-72), but it's ops-only. Send merchants a 'Your weekly scan found 3 new issues — health score 82 (-5)' email after scheduled scans, using scan-differ.server.ts output for the new/resolved delta and health-score.ts for the score. The Session model already stores merchant email (prisma/schema.prisma line ~33). This is the single biggest retention lever: it makes the subscription visibly 'work' every week without the merchant remembering the app exists, and the email links straight back into the dashboard.

### F-3 · Branded PDF/HTML Theme Audit Report (Pro)  (high value / small effort)

docs/pricing-and-plans.md (line 144) explicitly names exportable PDF reports as the low-lift precursor to validate an agency tier. The export route (app/routes/app.scans.$scanId.export.tsx) already handles plan gating, auth, and finding serialization for CSV/JSON — adding a ?format=html print-styled report (severity summary, health score, per-app impact, finding details with code snippets) is mostly a template. Merchants hire developers for $200-500 to remove ghost code (product-strategy.md line 37); a shareable report is exactly the artifact they hand to that developer, and agencies running audits for clients will upgrade to Pro for it. Watching uptake also answers the open agency-tier question with real data.

### F-4 · 'Before you uninstall' scan mode (snapshot + diff)  (high value / large effort)

Listed as a future idea in docs/product-strategy.md (line 195) but never scoped. Flow: merchant about to uninstall an app takes a baseline scan, uninstalls, rescans, and Ghost Code diffs to show exactly what got left behind — attributed to the app they just removed. Everything needed exists: the scan engine, scan-differ.server.ts for the comparison, and the App Impact Map for per-app file attribution. This is a bigger bet because it needs a guided UI flow and a way to detect/prompt around the uninstall moment, but it captures a completely different acquisition moment (merchants in app-trial cycles, per the 'tried it for 25 minutes and it trashed my theme' review) and converts the validated 'DANGER, do not install' pain into installs. It also generates highly shareable proof of which popular apps leave the most debris.

### F-5 · Scan asset files (assets/*.js, *.css) — currently a detection blind spot  (high value / medium effort)

isScannableFile() in app/services/scan-engine.server.ts (lines 101-106) only processes .liquid files in templates/, sections/, snippets/, and layout/ — the entire assets/ directory is skipped. But the v1.4 detectors built for exactly this content (GHOST_AJAX fetch/XHR calls to defunct app servers, GHOST_FONT @font-face declarations, GHOST_PIXEL tracking calls) would find far more ghost code in app-dumped .js/.css asset files, which is where page builders and tracking apps leave the bulk of their weight. The theme fetcher already retrieves these files via GraphQL; they're just filtered out before detection. Expanding coverage means more findings per scan — more perceived value on the free tier's marketing-moment first scan — plus orphan detection for asset files never referenced by any template (the file-reference-analyzer.server.ts pattern already does this for snippets).

### F-6 · Render-blocking severity escalation for ghost scripts/styles  (medium value / small effort)

Already identified in docs/product-strategy.md (line 199) but unbuilt: a ghost <script> in <head> without async/defer blocks First Contentful Paint on every page load and deserves HIGH severity, while a deferred footer script is much less urgent. Not a new finding type — enhance detectGhostScripts/detectGhostStyles in scan-engine.server.ts to track head-section context (the detectGhostPixels function at lines 647-688 already demonstrates the insideScript line-tracking pattern needed) and pass a render-blocking signal to classifySeverity in severity-classifier.server.ts, which already accepts contextual hints. Sharper prioritization makes the report feel expert-grade and strengthens the performance story merchants cite in reviews (Lighthouse +30 after cleanup).

### F-7 · Per-app 'leftover weight' leaderboard on the dashboard  (medium value / small effort)

Two shipped features almost meet but don't: the Theme Performance Impact Score (sums external resource KB from scan data) and the App Impact Map (groups findings by app, per docs/product-strategy.md v1.1 table). Combine them into a ranked 'PageFly leftovers add 412 KB to every page load' view — per-app weight, finding count, and severity rolled up. All data exists in the Finding table (appName, findingType, codeSnippet with URLs); this is aggregation and UI on app/routes/app._index.tsx or the scan detail page. It converts an abstract finding list into a concrete villain ranking merchants screenshot and share, and it's the natural seed for the 'speed optimizer paradox' marketing angle (installed perf apps that are net-negative).

### F-8 · Ship the Health Score trend chart (spec already written)  (medium value / small effort)

.specs/health-score-trend-chart.md is status READY FOR REVIEW and fully scoped: an inline SVG/CSS bar chart of health score over time for paid merchants with 3+ completed scans, with empty-state messaging below that threshold. computeHealthScore() in app/lib/health-score.ts is already a pure client-safe function, and the dashboard loader only needs its scan limit raised from 2. This is the cheapest retention feature available: a visible upward trend is the proof the subscription is paying off (and the reason to keep it), while the 3-scan requirement quietly incentivizes free users to upgrade past the 1-scan/month cap described in docs/pricing-and-plans.md. It also gives the weekly email digest (idea 2) its hero image later.

---

## Appendix A — Refuted findings

Claims raised by reviewers that the adversarial verification pass rejected. Listed for transparency:

- **[security] Weekly cron grants Standard-plan shops scheduled scans that bypass quota enforcement, contradicting plan gating config** — The weekly cron is documented, intentional Standard-plan behavior, not a bypass: the canonical pricing doc (docs/pricing-and-plans.md:37, 44, 121, 160) — which the project CLAUDE.md designates as the source of truth for billing/plan-gating — explicitly lists "Weekly scheduled scan: Yes (automatic scan every Sunday 6 AM UTC)" as a Standard feature, with decision-log entries explaining it deliberately reuses poll-check-shop and that the cap is "1 manual scan per week" (line 93). The settings UI sells "Automatic daily scans" as Professional (app/routes/app.settings.tsx:173), which is consistent with Standard getting weekly automation; only the unused scheduledScan flag/comment at app/lib/billing.server.ts:27 is stale (grep shows it is referenced nowhere outside billing.server.ts, so it has zero behavioral effect). The quota-bypass design is also intentional ("ensures no one falls behind even if they forget to scan manually"), and the claimed "blocking their manual scan until the next Monday reset" is exaggerated: the cron fires Sunday 06:00 UTC and the week resets Monday 00:00 UTC (getWeekStartUTC, app/lib/plan-gating.server.ts:8-15), so a cron scan can consume the manual slot for at most 18 hours, and only when the theme actually changed since the last scan (staleness check at inngest/functions/poll-check-shop.ts:131-148 skips otherwise) — in which case the merchant just received a fresh scan anyway. What remains is a stale comment/dead flag and an <18-hour quota wording nit, not a plan-gating or security issue.

## Appendix B — Merged duplicates

Three findings were reported independently by two waves and merged:

- Managed Pricing link (urls + compliance) → kept as [URL-1](#url-1)
- Admin API / webhook version divergence (urls + compliance) → kept as [URL-2](#url-2)
- Encrypted Shop.accessToken never read (security + compliance + quality) → kept as [SEC-1](#sec-1); the broader dead-exports finding remains as its own quality item
