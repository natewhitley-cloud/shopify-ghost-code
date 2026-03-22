# Ghost Code — Product Strategy

Research-driven feature ideas, messaging angles, and positioning insights.
Updated from market research (2026-03-22). Source data: `~/shopify/strategy/market-research/`.

---

## Core positioning

**Primary pain:** Apps leave code, data, and metadata behind after uninstall. Merchants don't know it's there, can't find it, and are being hurt by it — in page speed, SEO rankings, and Google crawl budget.

**Tagline candidate:** *"Your store is running things you didn't install."*

**Portfolio framing (Data Integrity Suite):**
> Ghost Code = *what your apps left behind in your store*
> Bot Analytics = *what fake traffic left behind in your data*
> Together: "Clean what you can see, and clean what you can't."

---

## Validated pain points (from review data)

### Orphaned code after uninstall — cross-category signal

Documented across pricing, wholesale, SEO, search, and translation categories:

- **Transcy (translation):** Generated 743 hreflang conflicts still active after removal. Merchant explicitly used the phrase *"Orphaned 'Ghost Code'"* in their review. The term is already in merchant vocabulary — no education needed.
- **Shopify Translate & Adapt (Shopify's own app):** Leaves translation data in metafields after uninstall. Merchant: *"I have been crawled 166,583 times in the last year by [Google] and all of it has layers of old and outdated and partial translation."* Shopify support confirmed on record: *"You're absolutely right — translation data persists after uninstall."*
- **AI Search & Product Filter:** *"DANGER, do not install... I had to pay someone to remove the code that was left AFTER the uninstall."* — Merchant incurred direct developer cost after 25 minutes of use.
- **Hyperspeed (speed optimization):** After uninstalling, merchant's Lighthouse score *improved by 30 points*. Speed optimization apps can themselves be net-negative for performance.
- **BOLD Discounts:** *"Sales are STUCK ON MY PRODUCTS even without the app installed."* — Discount data, not just scripts, persists after removal.
- **BSS B2B:** *"App messes with the code of your site... had to rebuild theme from scratch."*

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

Shopify support confirmed in a community thread: *"When you delete an app, it instantly loses access to your store, so it cannot clean up the code."* This is the architectural root cause, acknowledged by Shopify — and also confirmation that Shopify will not fix this at the platform level. Use in positioning: "Even Shopify acknowledges the architecture leaves this behind. We built the tool they didn't."

Additionally: there is no Shopify App Store policy requiring developers to clean up theme code on uninstall. The review process doesn't audit cleanup behavior. This is structural and permanent.

### Security anxiety as a trigger (Disputifier breach, Jan 2026)

The Disputifier breach ($12K in unauthorized refunds, 108↑ Reddit) primed merchants to ask *"what apps are still running on my store?"* This is the best acquisition moment in Ghost Code's history. Top community comment was literally: *"audit your apps and what permissions you've granted them."* App Permission Audit tab is the direct product response.

---

## Feature roadmap signals

### 1. SEO damage scanner (high priority — underserved angle)

The speed angle is *weaker* than the SEO angle. Expand detection beyond JavaScript orphans to:

- **Orphaned hreflang tags** — translation apps leave these; causes Google to receive contradictory language signals across all URLs
- **Translation metafields** — Shopify Translate & Adapt confirmed it leaves these after uninstall; causes mass URL crawling on bad content
- **Duplicate/conflicting meta tags** — multiple SEO apps installed over time each inject meta; stacking creates conflicts
- **Orphaned schema markup** — structured data snippets injected by review, product, or FAQ apps

**Positioning:** "Your store has invisible SEO damage from apps you already removed." More alarming than load time, harder to ignore, directly affects ad spend efficiency.

### 2. "Before you uninstall" scan mode (differentiated workflow)

Ghost Code is currently reactive — it finds damage after it's done. A proactive scan *before* removing an app to show what it will leave behind is a completely different use case. Solves the "I tried it for 25 minutes and it trashed my theme" pattern. Particularly useful for merchants going through app trial cycles.

### 3. Speed optimizer paradox detection

When an installed "performance" app is net-negative for store speed (adds more weight than it removes), surface it explicitly. The Hyperspeed finding is the proof of concept — Lighthouse improved 30 points on uninstall. Counter-intuitive, shareable, and directly actionable.

### 4. App Permission Audit tab (in progress)

See `docs/architecture-spec.md` for implementation details and API constraints. Key constraint: Shopify API exposes what permissions apps *requested*, not what they *used* — scope as "what each app can access."

### 5. Checkout Extensibility compatibility check (time-bound)

August 2024 mandate (main checkout) + August 2025 mandate (Thank You/Order Status pages). Flag apps not yet migrated from checkout.liquid. Window closing — most useful as Ghost Code feature tab within 6 months of launch; standalone app opportunity has passed.

---

## Messaging angles (ranked by potency)

| Message | Why it works |
|---|---|
| "You're paying a developer to clean up what your apps left behind." | Puts a dollar figure on the pain. Developer quotes are $200–500+. |
| "Even Shopify's own apps leave data behind." | Removes the "only bad apps do this" objection. Translate & Adapt is the proof. |
| "Ghost code is costing you Google rankings, not just load time." | SEO damage → lost revenue. More specific than speed. |
| "743 hreflang conflicts from an app you uninstalled months ago." | Specific number from real review. Specificity = credibility. |
| "Your store is running things you didn't install." | Core brand statement. Taps the Disputifier-primed anxiety. |

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
- `~/shopify/strategy/app-ideas-tracker.md` (Ghost Code entry + Permission Audit entry)
