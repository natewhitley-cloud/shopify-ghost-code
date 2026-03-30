# Ghost Code — Marketing Plan

Pre-launch and post-launch marketing plan. $0 budget actions first, paid actions second.

**Last updated**: 2026-03-29

---

## 1. Forum Threads to Respond To

High-intent Shopify Community threads where a helpful response (with a natural Ghost Code mention) would be welcome. Sorted by relevance.

### Tier 1: Direct match — merchants asking exactly what Ghost Code solves

| Thread | Angle |
|---|---|
| [How to remove leftover code from an uninstalled app?](https://community.shopify.com/c/shopify-discussions/how-to-remove-leftover-code-from-an-uninstalled-app/td-p/1037318) | High-traffic solved thread. The existing answers are "contact the app developer" or "manually search theme.liquid." Respond with the manual steps (be genuinely helpful) and mention Ghost Code automates the search across all theme files, settings, and metadata. |
| [Leftover code from uninstalled app — how do I remove it?](https://community.shopify.com/t/leftover-code-from-uninstalled-app-how-do-i-remove-it-from-my-website/294871/3) | Merchant doesn't know where to look. Explain the common hiding spots (theme.liquid, snippets/, sections/, assets/) and mention Ghost Code scans all 8 surfaces including ones merchants miss (translations, metafields, redirects). |
| [Can leftover app code be detected in our theme?](https://community.shopify.com/t/can-leftover-app-code-be-detected-in-our-theme/164034) | The title IS Ghost Code's value prop. Answer: yes, by searching for app-specific patterns — scripts, render/include statements, CSS, tracking pixels. Mention you built a tool that does this automatically with 100+ app signatures. |
| [URGENT: Old app code still running after uninstall](https://community.shopify.com/t/urgent-old-app-code-still-running-after-uninstall/403717/3) | Highest-severity case — an uninstalled app was still routing live traffic. This validates "Your store is running things you didn't install." Respond with empathy and concrete steps. Mention Ghost Code can detect these kinds of orphaned scripts. |
| [How to remove left-over code from uninstalled apps?](https://community.shopify.com/t/how-to-remove-left-over-code-from-uninstalled-apps/250058/1) | Classic thread. The current advice is "contact the developer." Add the manual audit steps, then mention Ghost Code for merchants who've installed/uninstalled many apps. |
| [Cleaning up old app code](https://community.shopify.com/t/cleaning-up-old-app-code/333196) | Merchant knows they have the problem but doesn't know the scope. Explain that code hides in more places than theme.liquid — settings, translations, metafields. Ghost Code finds it all. |
| [How can I remove unused code from uninstalled apps?](https://community.shopify.com/t/how-can-i-remove-unused-code-from-uninstalled-apps/238921) | Similar to above. Lead with the manual approach, then position Ghost Code as the automated version. |

### Tier 2: Speed/performance threads where orphaned code is a likely cause

| Thread | Angle |
|---|---|
| [Site speed dropped from 52 to 36](https://community.shopify.com/c/site-speed/site-speed-dropped-from-a-52-to-a-36/td-p/1682186) | Speed drop threads get lots of traffic. Don't lead with Ghost Code — lead with "one common cause merchants miss is leftover code from apps you've uninstalled." Offer the manual check approach and mention Ghost Code for a thorough audit. |
| [Where can I find codes added to my theme by previously downloaded apps?](https://community.shopify.com/c/site-speed/where-can-i-find-the-codes-that-have-been-added-to-my-theme-by/td-p/1674326) | Merchant is in the "Site Speed" category and explicitly asking about app code in their theme. Perfect fit. |
| [Where to remove added codes from apps I have downloaded?](https://community.shopify.com/c/site-speed/where-to-remove-the-added-codes-to-the-page-by-apps-i-have/td-p/1703975) | Same angle — merchant knows apps added code, doesn't know where to find it all. |
| [Left over code from app](https://community.shopify.com/c/site-speed/left-over-code-from-app/td-p/1581837) | Posted in the Site Speed category — merchant connecting orphaned code to performance. |

### Tier 3: Liquid error threads caused by orphaned snippets

| Thread | Angle |
|---|---|
| [Liquid error: Could not find asset snippets/wlm-head](https://community.shopify.com/c/shopify-scripts/how-to-remove-liquid-error-snippets-wlm-head-line-16-could-not/td-p/1969007) | App was uninstalled but left a render tag pointing to a deleted snippet. Explain the fix (remove the render/include line) and mention Ghost Code detects these broken references automatically. |
| [Liquid error: Could not find asset snippets/opinew_review_stars](https://community.shopify.com/c/technical-q-a/liquid-error-could-not-find-asset-snippets-opinew-review-stars/td-p/1777555) | Same pattern — Opinew app uninstalled, snippet reference remains. |
| [How to remove Liquid error: Could not find asset snippets/lookbooks-app.liquid](https://community.shopify.com/c/Shopify-Design/Liquid-error-Could-not-find-asset-snippets-lookbooks-app-liquid/td-p/308060) | Lookbooks app — same orphaned snippet pattern. |
| [How to remove leftover code from uninstalled Rivo app?](https://community.shopify.com/t/how-to-remove-leftover-code-from-uninstalled-rivo-app/285737) | App-specific cleanup request. Respond with how to find Rivo's code patterns, mention Ghost Code recognizes Rivo by signature. |

### Response Guidelines

- **Lead with help, not product.** Answer the question first with manual steps.
- **Be specific.** Name the files to check (theme.liquid, snippets/, sections/), the patterns to search for (render/include tags, `<script src>` tags with app CDN domains).
- **Mention Ghost Code naturally.** "I built a tool that automates this" or "There's an app called Ghost Code that scans all 8 surfaces including ones that are easy to miss (translations, metafields, redirects)."
- **Don't link your app directly** in most Shopify forums. Mention it by name — merchants can search the App Store. Link from your forum profile instead.
- **Only respond to threads with recent activity** (last 12 months) or high view counts. Old threads with no recent replies won't reach anyone.
- **Don't respond to all threads at once.** Space them out over 1-2 weeks to look natural.

---

## 2. Draft Forum Responses

### Response A: For "how do I remove leftover code" threads

> Great question — this is more common than most merchants realize. When you uninstall an app, it loses access to your store immediately, so it can't clean up after itself. Shopify has confirmed this is by design.
>
> Here's how to find leftover code manually:
>
> 1. **theme.liquid** (Layouts folder) — scroll through and look for `<script>` tags or `{% render %}` / `{% include %}` statements that reference apps you no longer use
> 2. **snippets/** folder — look for files prefixed with app names (e.g., `bold-`, `loox-`, `stamped-`)
> 3. **sections/** folder — same pattern, app-named section files
> 4. **assets/** folder — JS and CSS files from old apps (e.g., `judgeme-widget.js`)
>
> But code in theme files is just the tip of the iceberg. Apps can also leave behind tracking pixels, SEO meta tags, JSON-LD schemas, translation entries, metafields, and redirects — and those are harder to find manually.
>
> I built Ghost Code to automate this. It runs 26 checks across 8 different surfaces (theme files, settings, translations, metafields, and more) and recognizes 100+ apps by signature, so it tells you exactly which app left each fragment. The first scan is free if you want to see what's hiding in your theme.
>
> Always duplicate your theme before removing any code, just in case.

### Response B: For speed/performance threads

> One cause that often gets overlooked: leftover code from apps you've uninstalled.
>
> When you remove an app, the code it injected into your theme stays behind — scripts, stylesheets, tracking pixels, and more. Each one adds to your page weight and blocking time, even though the app isn't doing anything anymore.
>
> Quick check: open your theme code editor (Online Store > Themes > Edit code), go to `theme.liquid`, and read through it. Look for `<script>` tags loading from domains you don't recognize, or `{% render %}` statements referencing app snippets. Those are likely leftovers.
>
> If you've installed and uninstalled several apps over time, it adds up. I've seen themes with 10+ orphaned scripts from apps the merchant forgot they ever tried.
>
> For a thorough audit, Ghost Code scans your entire theme (not just theme.liquid) and identifies each leftover fragment by the app that created it. The first scan is free — might be worth a look to see if that's contributing to your speed issues.

### Response C: For Liquid error threads

> This error means your theme is trying to render a snippet file that doesn't exist anymore. It usually happens when an app is uninstalled — the app's snippet file gets removed, but the `{% render %}` or `{% include %}` tag in your theme code that calls it is still there.
>
> To fix it:
>
> 1. Go to Online Store > Themes > Edit code
> 2. Search your theme files for the snippet name mentioned in the error (e.g., `wlm-head` or `opinew_review_stars`)
> 3. You'll find a line like `{% render 'snippet-name' %}` — delete that entire line
> 4. Save the file
>
> Always duplicate your theme first as a backup.
>
> If you suspect there might be more leftover code from other uninstalled apps (there usually is), Ghost Code can scan your entire theme and flag all orphaned references at once. The first scan is free.

---

## 3. Launch Post (Shopify Community — "Show Your App")

**Title:** Ghost Code — Find the code uninstalled apps left behind in your theme

**Body:**

> Hi everyone,
>
> I built Ghost Code because I kept seeing the same question in these forums: "How do I remove leftover code from an uninstalled app?"
>
> The short answer is: manually, file by file, if you even know where to look. Most merchants don't — and most don't realize how much code apps leave behind beyond just theme.liquid.
>
> **What Ghost Code does:**
>
> It scans your theme for orphaned code left by apps you've uninstalled. Not just scripts and stylesheets — it checks 8 different surfaces including tracking pixels, SEO tags, JSON-LD schemas, translation entries, metafields, and redirects.
>
> It runs 26 detection checks per scan and recognizes 100+ apps by their code signatures. Every finding tells you: which app left it, which file, which line, and shows the actual code snippet so you know exactly what you're looking at.
>
> **Why it matters:**
>
> Every leftover script and stylesheet adds to your page load time. Orphaned SEO tags can conflict with your current setup. Tracking pixels keep firing to services you're no longer using. And in some cases, uninstalled apps can still actively alter your storefront behavior.
>
> This isn't a speed optimization app that works around bloated code — it finds the root cause so you can remove it.
>
> **How it works:**
>
> 1. Install Ghost Code (read-only access — it only needs `read_themes`)
> 2. Run a scan (first scan is always free)
> 3. Review findings with file names, line numbers, and source app attribution
> 4. Remove the code you don't need — with confidence, because you know exactly what each piece is
>
> Track your theme health score over time, compare scans to see what's changed, and export findings as CSV to hand to your developer.
>
> **Pricing:**
>
> - Free: 1 scan/month, severity counts + one full finding
> - Standard ($29/mo): Weekly scans, full finding details, health score tracking
> - Professional ($49/mo): Unlimited scans, unlimited themes, auto-rescan when you publish a new theme
>
> I'd love feedback from anyone who tries it. I'm a solo developer and actively improving the app based on what merchants tell me.
>
> Thanks for reading.

---

## 4. Listing Optimization Review

### Current listing (as submitted)

| Field | Current Value | Assessment |
|---|---|---|
| **App name** | Ghost Code | Misses a keyword opportunity. 30 char limit — "Ghost Code" is only 10 chars. |
| **Subtitle** | "Find and remove leftover app code slowing down your theme" | Good — problem-focused, includes "leftover app code" and "theme." 57 chars. |
| **Keywords (5 slots)** | theme cleanup, orphaned code, theme speed, app cleanup, theme audit | Solid mix. See recommendations below. |
| **Description** | Option A from listing doc (462/500 chars) | Strong. Covers scan scope, app signatures, file/line attribution, export. |
| **Features** | 5 items | Reviewed in listing doc — good coverage. |
| **Category** | Site optimization > Other | Best available fit. No "theme audit" category exists. |
| **SEO title** | Set (unknown exact text) | Need to verify — should include primary keyword. |
| **Meta description** | Set (unknown exact text) | Need to verify — should be benefit-focused with keywords. |

### Recommendations

#### App Name: Add a keyword (HIGH IMPACT)

**Current:** "Ghost Code" (10 chars)
**Recommended:** "Ghost Code: Theme Audit" (23 chars) or "Ghost Code - Theme Cleanup" (26 chars)

Your research notes that 70% of app installs come from App Store search. The app name is the strongest ranking signal you control. You have 20 unused characters — adding a keyword phrase is free SEO.

Shopify's AI flagged "Ghost Code" as potentially generic (session 25 handoff noted you ignored it). If the reviewer also flags the name, you'll need to change it anyway — might as well add a keyword descriptor.

**Risk:** Shopify may not allow changing the name after approval. If you can update it before the review decision, do it. If not, note it for future iteration.

**Options:**
- A) "Ghost Code: Theme Audit" — positions the app clearly, "theme audit" is a keyword
- B) "Ghost Code - Theme Cleanup" — more action-oriented, "theme cleanup" is your #1 keyword
- C) "Ghost Code" (keep as-is) — cleaner brand, but misses the SEO opportunity

#### Keywords: Swap one for higher intent (MEDIUM IMPACT)

**Current 5:** theme cleanup, orphaned code, theme speed, app cleanup, theme audit

**Recommendation:** Consider swapping "theme speed" for "leftover code" or "uninstall cleanup." Merchants searching "theme speed" are looking for speed optimization apps (Hyperspeed, Boostify) — not cleanup tools. Your subtitle already contains the speed angle. Use the keyword slot for a term where Ghost Code is the direct answer.

**Suggested 5:**
1. theme cleanup (keep — your #1 term)
2. orphaned code (keep — exact problem language)
3. leftover code (swap in — merchants use this exact phrase in forums)
4. app cleanup (keep — broad but relevant)
5. theme audit (keep — category-defining term)

#### Description: Minor polish (LOW IMPACT)

The current description (Option A) is strong. One tweak: lead with the pain, not the feature. The current opening is "Every app you uninstall can leave code behind" — good. But consider making the first line even more visceral:

**Current (462 chars):**
> Every app you uninstall can leave code behind — scripts, styles, snippets, SEO tags, tracking pixels, orphaned metafields, and more. Ghost Code runs 26 checks across your theme files, settings, translations, and store data to find it all. It recognizes 100+ apps by signature and tells you exactly which app left each fragment, in which file, at which line. Track your theme health score over time, compare scans to see progress, and export findings as CSV or JSON.

**PAS rewrite (approved, 493 chars):**
> Every app you uninstall leaves code behind. Scripts, styles, tracking pixels, SEO tags, and metadata buried across your theme. You can't see it, but it's slowing your pages, conflicting with your SEO, and firing requests to services you stopped using. Cleaning it up manually means searching file by file, if you even know where to look. Ghost Code scans 8 surfaces in your theme with 26 checks and attributes every fragment to the app that left it, with file, line, and code snippet. First scan is free.

Update in Partner Dashboard alongside the app name change (GC-fh0).

#### SEO Title and Meta Description: Verify

These fields are in the Partner Dashboard but weren't captured in the listing doc. They matter for Google search results when merchants search outside the App Store.

**Recommended SEO title (60 chars):**
"Ghost Code - Find & Remove Leftover App Code in Shopify Themes"

**Recommended meta description (160 chars):**
"Scan your Shopify theme for orphaned code left by uninstalled apps. 26 checks, 100+ app signatures, file-level attribution. First scan free."

#### Demo Store URL (OPTIONAL, post-approval)

Not currently set. A demo store showing Ghost Code results on a real theme would boost conversion — merchants can see the value before installing. Consider setting up a demo store with pre-seeded scan results after approval.

---

## 5. Review Collection Strategy

### In-app review prompt (build post-approval)

**Trigger:** After the merchant's first completed scan that finds 3+ findings.

**UI:** Non-blocking banner at the top of the dashboard, dismissable. Shows once per shop.

**Copy:**
> Ghost Code found {findingCount} issues in your theme. If this was helpful, we'd love a quick review on the App Store. [Leave a Review] [Dismiss]

**Implementation notes:**
- Track `hasSeenReviewPrompt` in shop record (boolean, default false)
- Only show if `status === 'COMPLETED'` and `findingCount >= 3` and `!hasSeenReviewPrompt`
- "Leave a Review" links to the app's App Store review page
- "Dismiss" sets `hasSeenReviewPrompt = true`
- Never show again after dismissal — no nagging

### Support-driven reviews

After resolving a support ticket positively, follow up with:

> Glad we could help! If you have a moment, a review on the App Store helps other merchants find Ghost Code. No pressure at all — just appreciate the feedback either way.

### Milestone prompt (alternative, less aggressive)

Instead of first-scan, trigger after the merchant's **3rd completed scan** (they're clearly getting recurring value). Same UI, same dismissal logic.

### What's prohibited (Shopify policy)

- Incentivizing reviews (discounts, free months, extended trials)
- Fake or misleading reviews
- Exchanging reviews for financial gain
- Guilt-tripping or creating urgency around reviews
- Requiring a review to access features

---

## 6. Content Marketing (While Waiting for Approval)

### Blog Post 1: Problem-awareness

**Title:** "Is Leftover App Code Slowing Down Your Shopify Store?"

**Target keywords:** leftover app code shopify, shopify theme slow, uninstalled app code

**Outline:**
1. The problem: what happens when you uninstall a Shopify app (code stays)
2. Where the code hides (theme.liquid, snippets, assets, but also translations, metafields, redirects)
3. Real examples from community forums (anonymized)
4. How to check manually (step-by-step guide)
5. When to consider an automated tool (mention Ghost Code for thorough audits)

**Publish on:** alpenglowsoftware.com blog (or dev.to / Medium if blog isn't set up yet)

### Blog Post 2: How-to guide

**Title:** "How to Find and Remove Ghost Code from Your Shopify Theme"

**Target keywords:** remove ghost code shopify, clean shopify theme, remove old app code

**Outline:**
1. What is "ghost code" (define the term)
2. Step-by-step manual audit (with screenshots)
3. Common app patterns to search for (BOLD, Loox, Judge.me, Stamped, etc.)
4. What to do after you find it (backup, remove, verify)
5. How Ghost Code automates the entire process

### Loom Video

**Title:** "I Scanned a Shopify Theme and Found 15 Orphaned Scripts"

**Format:** 60-90 seconds, screen recording of Ghost Code scanning a theme and showing results. Conversational voiceover, not polished — authenticity matters.

**Use for:** App Store feature media supplement, YouTube, embed in blog posts, Shopify Community profile.

---

## 7. Post-Approval Launch Sequence

| Timing | Action | Cost |
|---|---|---|
| Day 1 | Publish launch post in Shopify Community "Show Your App" | $0 |
| Day 1 | Respond to 2-3 highest-traffic forum threads (Tier 1) | $0 |
| Day 2-3 | Respond to 2-3 more threads (space them out) | $0 |
| Week 1 | Publish blog post #1 | $0 |
| Week 1 | Record and publish Loom video | $0 |
| Week 2 | Activate $100 App Store ad credit — search ads on "theme cleanup", "app cleanup", "orphaned code" at $5/day | $0 (credit) |
| Week 2 | Publish blog post #2 | $0 |
| Week 3-4 | Respond to any new forum threads that appear | $0 |
| Month 2 | If data exists: publish "We scanned X stores and found..." data report | $0 |
| Month 3 | If 50+ installs + 5+ reviews: apply for Built for Shopify badge | $0 |
| Month 4+ | Consider affiliate program (25% rev share) if PMF confirmed | Rev share only |

---

## 8. Metrics to Track

| Metric | Target | How to measure |
|---|---|---|
| App Store impressions | Baseline | Partner Dashboard analytics |
| Install rate (impressions -> installs) | >5% | Partner Dashboard |
| Trial-to-paid conversion | >25% | DB query (shops with active subscription / total installs) |
| First-scan completion rate | >80% | DB query (completed scans / total installs) |
| 30-day retention | >50% | DB query (shops still installed after 30 days) |
| Reviews | 5+ in first 3 months | App Store listing |
| Average rating | >4.5 stars | App Store listing |
| Monthly churn | <5% | DB query |
| Ad CPI (cost per install) | <$5 | App Store ads dashboard |
