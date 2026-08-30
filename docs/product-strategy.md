# Ghost Code — Product Strategy

Research-driven feature ideas, messaging angles, and positioning insights.
Updated from market research (2026-03-22). Source data: `~/shopify/strategy/market-research/`.

---

## Core positioning

**Primary pain:** Apps leave code, data, and metadata behind after uninstall. Merchants don't know it's there, can't find it, and are being hurt by it — in page speed, SEO rankings, and Google crawl budget.

**Tagline candidate:** _"Your store is running things you didn't install."_

**Portfolio framing (Data Integrity Suite):**

> Ghost Code = _what your apps left behind in your store_
> Bot Analytics = _what fake traffic left behind in your data_
> Together: "Clean what you can see, and clean what you can't."

---

## Validated pain points (from review data)

### Orphaned code after uninstall — cross-category signal

Documented across pricing, wholesale, SEO, search, and translation categories:

- **Transcy (translation):** Generated 743 hreflang conflicts still active after removal. Merchant explicitly used the phrase _"Orphaned 'Ghost Code'"_ in their review. The term is already in merchant vocabulary — no education needed.
- **Shopify Translate & Adapt (Shopify's own app):** Leaves translation data in metafields after uninstall. Merchant: _"I have been crawled 166,583 times in the last year by [Google] and all of it has layers of old and outdated and partial translation."_ Shopify support confirmed on record: _"You're absolutely right — translation data persists after uninstall."_
- **AI Search & Product Filter:** _"DANGER, do not install... I had to pay someone to remove the code that was left AFTER the uninstall."_ — Merchant incurred direct developer cost after 25 minutes of use.
- **Hyperspeed (speed optimization):** After uninstalling, merchant's Lighthouse score _improved by 30 points_. Speed optimization apps can themselves be net-negative for performance.
- **BOLD Discounts:** _"Sales are STUCK ON MY PRODUCTS even without the app installed."_ — Discount data, not just scripts, persists after removal.
- **BSS B2B:** _"App messes with the code of your site... had to rebuild theme from scratch."_

### Paid developer cleanup is the measurable cost

Multiple reviews document hiring developers to remove orphaned code. Ghost Code's value prop includes the developer time saved — estimated $200–500+ per incident. Make this explicit in pricing/positioning.

### Live site correctness failures — not just a performance issue

Community forum (2026-03-22): An A/B testing app (ShopLift) was fully uninstalled but continued routing live traffic to a split-test theme. Customers saw a different storefront than the merchant intended. The thread is marked "URGENT" and remained unresolved. This is distinct from the performance/SEO angle — orphaned code can actively alter checkout behavior, redirect customers, and run experiments the merchant has no idea are still active. "Your store is running things you didn't install" is not metaphorical — it is literally true in these cases.

This is the highest-severity use case and should feature in onboarding and App Store listing copy.

### Manual workarounds Ghost Code eliminates

From community forum threads — what merchants are currently doing without Ghost Code:

1. Manually scanning `theme.liquid`, `footer.liquid`, sections, and snippets file by file
2. Searching for `{% comment %}` blocks containing app names
3. Grepping for JS patterns like `window.BOLD = window.BOLD || {}`
4. Contacting each uninstalled app's developer individually to request cleanup
5. Hiring Shopify Experts to audit and clean ($200–500+)
6. Duplicating the entire theme before making any changes as a hedge

Ghost Code eliminates all six steps in a single scan. Frame this explicitly in onboarding: "Here's what you were doing before."

### Shopify staff on-record confirmation

Shopify support confirmed in a community thread: _"When you delete an app, it instantly loses access to your store, so it cannot clean up the code."_ This is the architectural root cause, acknowledged by Shopify — and also confirmation that Shopify will not fix this at the platform level. Use in positioning: "Even Shopify acknowledges the architecture leaves this behind. We built the tool they didn't."

Additionally: there is no Shopify App Store policy requiring developers to clean up theme code on uninstall. The review process doesn't audit cleanup behavior. This is structural and permanent.

### Security anxiety as a trigger (Disputifier breach, Jan 2026)

The Disputifier breach ($12K in unauthorized refunds, 108↑ Reddit) primed merchants to ask _"what apps are still running on my store?"_ This is the best acquisition moment in Ghost Code's history. Top community comment was literally: _"audit your apps and what permissions you've granted them."_

---

## What v1 detects

Ghost Code v1 ships with 26 finding types across 115 app signatures (915 tests):

### Theme-file detectors (read_themes scope)

| Finding Type      | Severity | Description                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------ |
| GHOST_SCRIPT      | HIGH     | External `<script src>` tags from app CDNs                                     |
| GHOST_PIXEL       | HIGH     | Inline tracking code (fbq, gtag, ttq, pintrk, etc.) — 12 tracker patterns      |
| GHOST_ROBOTS      | HIGH     | Orphaned `<meta name="robots" content="noindex">` directives blocking SEO      |
| GHOST_HREFLANG    | HIGH     | Orphaned `<link rel="alternate" hreflang>` from translation apps               |
| JSON_LD_CONFLICT  | HIGH     | Conflicting JSON-LD blocks — same @type, different data on same page           |
| GHOST_TEXT        | HIGH     | Orphaned widget markup (review widgets, trust badges, wishlist buttons)        |
| GHOST_STYLE       | MEDIUM   | External `<link rel="stylesheet">` tags                                        |
| GHOST_SNIPPET     | MEDIUM   | `{% render %}` / `{% include %}` of known app snippets                         |
| DUPLICATE_META    | MEDIUM   | Duplicate meta tags with same name/property from stacked SEO apps              |
| GHOST_JSON_LD     | MEDIUM   | Orphaned `<script type="application/ld+json">` blocks from review/FAQ/SEO apps |
| GHOST_LAYOUT      | MEDIUM   | Orphaned page builder layout files (theme.pagefly.liquid, etc.)                |
| GHOST_TRANSLATION | MEDIUM   | Orphaned translations via Shopify Translations API                             |
| GHOST_SECTION     | LOW      | `{% section %}` of known app sections                                          |
| ORPHAN_ASSET      | LOW      | Unreferenced snippet files (requires app attribution)                          |
| SETTINGS_DRIFT    | LOW      | Stale section references in settings_data.json pointing to nonexistent files   |

### API-based detectors (optional scopes — graceful degradation when not granted)

| Finding Type    | Severity | Scope                        | Description                                                                             |
| --------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| GHOST_PRICE     | HIGH     | read_products                | Persistent compare-at pricing left by uninstalled discount apps — direct revenue impact |
| GHOST_REDIRECT  | MEDIUM   | read_online_store_navigation | Orphaned URL redirects from SEO apps (pattern + bulk detection)                         |
| GHOST_PAGE      | MEDIUM   | read_content                 | Orphaned pages created by apps (pagefly-_, gempages-_, etc.)                            |
| GHOST_TAG       | LOW      | read_products                | Orphaned product tags from apps (\_\_bold, loyalty-, recharge-, etc.)                   |
| GHOST_METAFIELD | LOW      | read_products                | Orphaned metafields in known app namespaces (app-owned metafields invisible)            |

---

## The cleanup gap is structural — and already baked in

Modern Shopify apps that use Theme App Extensions (introduced ~2023) get auto-cleaned by Shopify on uninstall. Apps like Transcy, BOLD Discounts, and newer installs leave nothing behind. This is good news for the platform but does _not_ eliminate Ghost Code's market:

1. **The damage is already done.** Most growth-stage merchants have 3–5 years of app install/uninstall history. The orphaned code from older apps (pre-Theme App Extensions) is already in their themes. Ghost Code cleans what's already there.
2. **Many popular apps still inject directly.** PageFly creates `layout/theme.pagefly.liquid` (a full theme copy), `sections/pagefly-section.liquid`, and `snippets/pagefly-main-js.liquid`. These are not Theme App Extensions — they're direct theme file edits that persist forever after uninstall.
3. **Theme App Extensions are opt-in, not enforced.** Shopify does not require developers to use them. There is no App Store policy mandating cleanup on uninstall, and the review process doesn't audit cleanup behavior. Apps that modify theme files directly will continue to ship.
4. **The long tail is massive.** The Shopify App Store has 13,000+ apps. Theme App Extension adoption is concentrated in top apps with active development. Thousands of smaller, older, or abandoned apps still use direct theme injection.

**Positioning implication:** Ghost Code is not selling prevention — it's selling remediation. The problem is already in the store. Frame it as "clean up what's already there" rather than "protect against future damage." This also makes the market self-qualifying: merchants who have tried many apps over time are the exact right audience.

---

## Signature expansion strategy

The scanner currently has 94 hardcoded app signatures across 15 categories. Three paths to expand coverage:

### Community-driven learning loop (v1.1 — the flywheel)

When a scan finds unattributed ghost code (e.g., an external `<script src>` we can't match to a known app), surface it in an "Unknown Findings" section. Add a "Do you know which app left this?" input. Store submissions in a new table (`signature_submissions`: url/pattern, merchant-provided app name, shop_id, timestamp). Review submissions manually, validate, and promote to the signature DB.

Every merchant who scans teaches the system something. No ML, no automation risk — human-curated pipeline fed by real data. Start manual, automate later if volume justifies it.

### Market research DB cross-reference (v1.2 — prioritization)

Cross-reference existing 64 signatures against the 2,008 apps in the market research DB (`~/shopify/strategy/market-research/data/shopify_apps.db`) to find high-install-count, high-complaint apps we're missing. The DB has app names, pricing, reviews, and categories — no technical signals (CDN domains, script URLs), so it can't auto-generate signatures, but it tells us _where to look next_.

Also: query 1-2 star reviews for "uninstall," "leftover," "code," "broken" to surface apps merchants explicitly complain about. One-time effort, likely nets 5-10 new high-confidence signatures.

### Why not auto-removal?

Cleanify Code (the only prior competitor) was delisted — reviews mentioned false positive suggestions. Auto-removal amplifies every false positive from an annoyance into a production incident. Merchants already duplicate themes before manual edits out of fear. Ghost Code's value is _detection_, not modification. Make scan reports actionable enough (exact file, line, code block) that removal is easy for merchants or their devs. Revisit only after 500+ installs with zero false-positive reports.

---

## Post-launch roadmap

### v1.1 — Quick wins from existing data

| Feature                             | Effort | Status                       | Description                                                                                                                                                                              |
| ----------------------------------- | ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App Code Attribution Map**        | Low    | **Shipped** (App Impact Map) | UI view showing which theme files each app touched, with finding counts and types. Data derived from existing scan results.                                                              |
| **Tracking Script Privacy Callout** | Low    | **Shipped**                  | Sub-classify existing GHOST_SCRIPT findings: if CDN domain is a known tracker (Meta Pixel, TikTok, Snapchat, etc.), flag as "Privacy: this script may still be collecting visitor data." |
| **Unknown Finding Feedback Loop**   | Medium | **Shipped**                  | "Do you know which app left this?" inline input on unattributed findings. Submissions stored with review status tracking. CLI curation script at `scripts/review-submissions.ts`.        |
| **Theme Performance Impact Score**  | Medium | **Shipped**                  | Sum external script/stylesheet weight from scan data. Shows "apps are adding X KB of external resources to every page load."                                                             |

### v1.2 — New detection capabilities

| Feature                                    | Effort | Status                          | Description                                                                                                                              |
| ------------------------------------------ | ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Orphaned Webhook Detection**             | Medium | **Not feasible**                | Shopify isolates webhook subscriptions per-app — each app can only see its own webhooks. Same architectural blocker as Permission Audit. |
| **Persistent UI Text Fragments**           | Medium | **Shipped** (GHOST_TEXT)        | Pattern-match Liquid templates for known widget text left by uninstalled apps.                                                           |
| **Translation Metafield Detection**        | Medium | **Shipped** (GHOST_TRANSLATION) | Query translations via Shopify Translations API. `read_translations` optional scope.                                                     |
| **Market Research DB Signature Expansion** | Low    | Partially done                  | Signature DB expanded from 56 to 94 apps across 15 categories.                                                                           |
| **Settings Data Drift**                    | Low    | **Shipped** (SETTINGS_DRIFT)    | Stale section refs in settings_data.json pointing to nonexistent section files.                                                          |
| **Inline Tracking Pixel Detection**        | Low    | **Shipped** (GHOST_PIXEL)       | Inline fbq, gtag, ttq, pintrk, etc. — 12 tracker patterns with per-file dedup.                                                           |
| **JSON-LD Conflict Detection**             | Low    | **Shipped** (JSON_LD_CONFLICT)  | Same @type with different data = conflicting signals for Google.                                                                         |
| **Page Builder Layout Detection**          | Low    | **Shipped** (GHOST_LAYOUT)      | Orphaned theme.pagefly.liquid, theme.gempages.liquid, etc.                                                                               |
| **Orphaned Robots Directives**             | Low    | **Shipped** (GHOST_ROBOTS)      | Static noindex/nofollow meta robots left by SEO apps.                                                                                    |
| **Orphaned Product Tags**                  | Medium | **Shipped** (GHOST_TAG)         | App-prefixed tags (\_\_bold, loyalty-, recharge-). `read_products` optional scope.                                                       |
| **Persistent Discount Prices**             | Medium | **Shipped** (GHOST_PRICE)       | Compare-at pricing left by discount apps. `read_products` optional scope.                                                                |
| **Orphaned Pages**                         | Medium | **Shipped** (GHOST_PAGE)        | App-created pages (pagefly-_, gempages-_). `read_content` optional scope.                                                                |
| **Orphaned Metafields**                    | Medium | **Shipped** (GHOST_METAFIELD)   | Known app namespaces on products. `read_products` optional scope.                                                                        |
| **Orphaned Redirects**                     | Medium | **Shipped** (GHOST_REDIRECT)    | SEO app redirect patterns + bulk detection. `read_online_store_navigation` optional scope.                                               |

### v1.3 — SEO integrity detection (Shipped)

Critical SEO detectors using existing `read_themes` scope — no new scopes needed. These target the most damaging SEO problems caused by orphaned app code.

| Feature             | Effort | Impact       | Description                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GHOST_CANONICAL** | Medium | **Critical** | SEO apps override `<link rel="canonical">` in theme layouts. After uninstall, orphaned logic outputs malformed/missing canonical URLs → Google indexes wrong URL variants, causing duplicate content. Broken canonicals are the single most damaging SEO problem possible. Community threads document merchants losing organic traffic after uninstalling SEO apps because canonical signals became inconsistent.                         |
| **GHOST_TITLE**     | Medium | **Critical** | SEO apps override `<title>` tags with custom logic. After uninstall, titles become blank or show raw Liquid variables (e.g., `{{ seo_title_format }}`). Google displays store URLs instead of proper titles in search results. Shopify Community: _"the page title tag in the tab headers used for SEO isn't showing"_ after uninstalling an SEO app. Title tags are the single most important on-page SEO element.                       |
| **GHOST_OG**        | Medium | **High**     | Social/SEO apps inject Open Graph + Twitter Card meta tags via snippets in `theme.liquid`. After uninstall, broken/empty OG tags → Facebook/Twitter show wrong images, blank descriptions, or fallback previews. Directly impacts click-through from social channels. Detection: find duplicate/conflicting `og:*` and `twitter:*` properties, OG tags referencing undefined Liquid variables, orphaned snippet includes for social meta. |

**Why this tier matters:** These three detectors address the gap between "your store is slow" (current detection) and "your store is invisible to Google" (what merchants fear most). Together with existing GHOST_ROBOTS, DUPLICATE_META, JSON_LD_CONFLICT, and GHOST_REDIRECT, they complete Ghost Code's SEO integrity story.

### v1.4 — Performance artifact detection (Shipped)

Resource-level performance detectors. All use `read_themes` scope.

| Feature              | Effort | Impact          | Description                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GHOST_PRECONNECT** | Low    | **Medium**      | Apps add `<link rel="preconnect">`, `<link rel="dns-prefetch">`, `<link rel="preload">` for their CDNs. After uninstall, browser wastes connection slots on defunct domains. Shopify's own perf docs warn about excessive preconnect hints stealing priority from legitimate resources. Detection: cross-reference preconnect domains against known app CDNs. |
| **GHOST_FONT**       | Medium | **Medium**      | Apps load custom fonts via `@font-face` or Google Fonts links. After uninstall, 100-500ms of wasted download + CLS from font-display issues. Detection: find `@font-face` declarations and font service links whose `font-family` is never referenced in active CSS.                                                                                          |
| **GHOST_AJAX**       | Medium | **Medium-High** | App JavaScript makes `fetch()`/`XMLHttpRequest` calls to defunct app servers. Wasted network requests on every page load + privacy concern (data leaking to old endpoints). Detection: parse inline/external JS for fetch/XHR patterns pointing to known app API domains. Combines performance impact with privacy angle.                                     |

### Future ideas (unscheduled)

**"Before you uninstall" scan mode:** Proactive scan _before_ removing an app to show what it will leave behind. Different use case from current reactive scanning. Solves "I tried it for 25 minutes and it trashed my theme." Useful for merchants in app trial cycles.

**Speed optimizer paradox detection:** When an installed "performance" app is net-negative for store speed (adds more weight than it removes), surface it explicitly. Hyperspeed finding is the proof of concept — Lighthouse improved 30 points on uninstall. Counter-intuitive, shareable, directly actionable.

**Render-blocking severity enhancement:** Not a new finding type — enhance existing GHOST_SCRIPT/GHOST_STYLE severity classification to flag render-blocking variants (in `<head>` without `async`/`defer`) as HIGH, since they block First Contentful Paint.

**Lazy-loading LCP regression:** Detect `loading="lazy"` on above-fold hero images in first sections. App-injected lazy loading on LCP images adds ~0.5s. Heuristic-dependent (requires guessing which sections are above-fold), so higher false positive risk.

---

## Other leftover artifact types (research inventory)

Merchant-reported persistent artifacts after app uninstall — status of detection coverage:

| Artifact                                 | Evidence                                                                       | Status                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Translation metafields**               | Shopify Translate & Adapt confirmed; 166K bad Google crawls                    | **Shipped** — GHOST_TRANSLATION                                                                                                                                                                        |
| **Persistent UI text fragments**         | Payment badge text appearing 2 years post-uninstall                            | **Shipped** — GHOST_TEXT                                                                                                                                                                               |
| **Custom tags on products/orders**       | "Some apps leave behind meta fields, Tags or code"                             | **Shipped** — GHOST_TAG (read_products optional scope)                                                                                                                                                 |
| **Discount/pricing data**                | BOLD Discounts: "Sales are STUCK ON MY PRODUCTS"                               | **Shipped** — GHOST_PRICE (read_products optional scope)                                                                                                                                               |
| **SEO sabotage code**                    | SearchPie: rankings flatlined to 0 within 2 days                               | **Partially shipped** — GHOST_ROBOTS, DUPLICATE_META, JSON_LD_CONFLICT, GHOST_REDIRECT cover theme + redirect side. Canonical/title tag overrides shipped in v1.3 (GHOST_CANONICAL, GHOST_TITLE). Server-side redirects not visible. |
| **Tracking pixels (sneaky persistence)** | "The number of sneaky tracking scripts were beyond astonishing"                | **Shipped** — GHOST_SCRIPT (external) + GHOST_PIXEL (inline, 12 tracker patterns)                                                                                                                      |
| **Orphaned webhooks**                    | Apps lose API access on uninstall but webhooks may persist                     | **Not feasible** — Shopify isolates webhook subscriptions per-app                                                                                                                                      |
| **Orphaned canonical/title overrides**   | SEO apps override canonical + title tags; orphaned logic after uninstall       | **Shipped** — v1.3 (GHOST_CANONICAL, GHOST_TITLE)                                                                                                                                                      |
| **Orphaned Open Graph tags**             | Social apps inject OG/Twitter Card meta; broken after uninstall                | **Shipped** — v1.3 (GHOST_OG)                                                                                                                                                                          |
| **Orphaned resource hints**              | Apps add preconnect/preload for their CDNs; wastes connections after uninstall | **Shipped** — v1.4 (GHOST_PRECONNECT)                                                                                                                                                                  |
| **Orphaned font declarations**           | Apps load custom fonts; persist after uninstall (100-500ms wasted)             | **Shipped** — v1.4 (GHOST_FONT)                                                                                                                                                                        |
| **Orphaned AJAX calls**                  | App JS makes fetch/XHR to defunct app servers                                  | **Shipped** — v1.4 (GHOST_AJAX)                                                                                                                                                                        |

---

## Messaging angles (ranked by potency)

| Message                                                             | Why it works                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| "You're paying a developer to clean up what your apps left behind." | Puts a dollar figure on the pain. Developer quotes are $200–500+.                                                      |
| "Even Shopify's own apps leave data behind."                        | Removes the "only bad apps do this" objection. Translate & Adapt is the proof.                                         |
| "Ghost code is costing you Google rankings, not just load time."    | SEO damage → lost revenue. v1 detects hreflang, meta, and JSON-LD — this is backed by shipped features, not vaporware. |
| "743 hreflang conflicts from an app you uninstalled months ago."    | Specific number from real review. Specificity = credibility.                                                           |
| "Your store is running things you didn't install."                  | Core brand statement. Taps the Disputifier-primed anxiety.                                                             |

---

## Competitive landscape

- **Cleanify Code** — only prior competitor, now **delisted** from App Store. Market gap is uncontested.
- **Shopify itself** — does not clean up after apps on uninstall. Confirmed by Shopify support quotes in reviews. Platform will not fix this.
- **Speed optimization apps** (Hyperspeed, Boostify) — adjacent but focused on active optimization, not cleanup. Some are themselves leaving orphaned code.

---

## App Store discovery note

Ghost Code has no natural Shopify App Store category — neither "orphaned code" nor "theme audit" exists as a browse category. Discovery will be search-driven. Target keywords from organic merchant language: "ghost code," "orphaned code," "code left after uninstall," "app cleanup," "theme cleanup after uninstall."

---

## Research sources

- `~/shopify/strategy/market-research/reports/2026-03-21-market-analysis.md`
- `~/shopify/strategy/market-research/reports/2026-03-21-reddit-community-sentiment.md`
- `~/shopify/strategy/market-research/reports/2026-03-22-deep-dive-analysis.md`
- `~/shopify/strategy/market-research/community-forum-pain-points-2026-03.md` (community forum threads — live correctness failures, workaround inventory, Shopify staff quotes)
- `~/shopify/strategy/app-ideas-tracker.md` (Ghost Code entry)
