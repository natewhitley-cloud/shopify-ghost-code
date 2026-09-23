# GhostCode — App Store Listing v2

> **Created:** 2026-09-03
> **Supersedes:** `marketing-plan.md §4` (that section predates the GhostCode rename, the
> s34 consequence-axis reframe, and the gc-47c agentic AI wedge).
> **Positioning decision (Nathan, 2026-09-03):** Hybrid. Keep the searchable cleanup terms
> in the head of every field for ranking; carry the consequence/AI differentiation in the
> body for conversion. You cannot rank for AI demand that does not exist yet, so images and
> body copy sell the differentiator instead of keywords.

---

## Why this doc exists

The product moved twice since the last listing pass and the listing did not follow:

1. **Consequence-axis reframe (s34, gc-8s3):** the dashboard leads with consequence lanes
   (Customers see it / Found by Google & AI / Speed / Still tracking you / Housekeeping),
   not High/Med/Low severity.
2. **Agentic AI wedge (gc-47c):** "Is your store feeding AI shopping agents the wrong
   price?" is the differentiator and the growth story.

**Competitive context:** `GhostSweep` (subtitle literally "Ghost Code Scanner") and
`ghostcode.app` both launched within ~6 weeks and both ride the name. A shopper comparing
three near-identical "ghost code" apps decides on (a) reviews and (b) the clearest "so
what." The reframe + AI wedge is the only separator, so it must be visible in screenshot 1.

---

## Copy (paste-ready for Partner Dashboard)

Char counts are against Shopify's field limits.

> **Counts reconciled 2026-09-12 against current code:** FindingType enum = **31 defined**
> (added `CHECKOUT_SUNSET`, `JSON_LD_INVALID`, and `JSON_LD_PRICE_CONFLICT` is now flag-ON).
> ~**30 are merchant-active** on a typical plan: `JSON_LD_PRICE_CONFLICT` needs the optional
> `read_products` scope and `CHECKOUT_SUNSET` is Standard+. App signatures = **114** ("100+"
> is safe). Surfaces unchanged at **8**. **Decision (2026-09-12): stop chasing the exact
> number**: all copy below now uses soft **"30+ checks / 100+ signatures"** so releases
> don't force a listing edit.

### App name (30 max) — 24 chars
```
GhostCode: Theme Cleanup
```
Adds the #1 search keyword, dodges the "generic name" reviewer flag, and "cleanup"
separates GhostCode from the "scanner" crowd.

### Subtitle / tagline (62 max) — 58 chars
```
Remove leftover app code: fix theme speed, SEO & AI errors
```

### App introduction (100 max) — 90 chars
```
Scan your theme for orphaned code left by uninstalled apps, then see what it's costing you.
```

### Description (500 max) — 498 chars
```
Every app you uninstall leaves code behind: scripts, tracking pixels, SEO tags, and metadata across your theme. You can't see it, but it slows your pages, feeds wrong info to Google and AI agents, and pings services you dropped. GhostCode scans 8 surfaces with 30+ checks and attributes every fragment to the app that left it, with file, line, and snippet. Findings are grouped by what they actually cost you, not by severity. Track your health score, re-scan to confirm it's gone. First scan free.
```

### Keywords (5 slots)
Swaps "theme speed" (wrong intent, owned by speed-optimizer apps) for "leftover code".
```
theme cleanup · orphaned code · leftover code · app cleanup · theme audit
```
Do NOT spend a slot on "AI" terms yet: merchant search volume for that is near-zero. Sell
the AI angle in images and body copy instead.

### Feature bullets (5)
```
1. See what leftover code is costing you, grouped by consequence not severity
2. Every fragment traced to the app that left it, with file, line, and snippet
3. Catch schema prices that disagree with your live price before AI quotes it
4. 30+ checks across 8 theme surfaces, 100+ app signatures
5. Track your health score and re-scan to confirm it's gone. First scan free
```

### Timely hook: checkout.liquid sunset (do NOT put in the hero)

`CHECKOUT_SUNSET` (shipped 2026-09-12, Standard+) flags reliance on the deprecated
`checkout.liquid` mechanism. **Framing note (corrected 2026-09-23, gc-oam):** the sunset is
fully in the PAST for every store. checkout.liquid stopped rendering for the Information,
Shipping, and Payment steps on Aug 13, 2024, and for the Thank you and Order status pages on
Aug 28, 2025 (shopify.dev checkout-liquid layout docs). "Beat the deadline" is the wrong
tense for everyone; the hook is present-harm ("checkout.liquid no longer renders; code it
held has already stopped running"). No Plus/non-Plus split: the detector cannot know plan. Keep it out of the hero regardless: it's Standard+
gated (free scanners never see it) and isn't strictly "leftover code from an uninstalled
app," so leading with it blurs the core promise. Use it in three places:

1. **Standard-plan feature copy (Managed Pricing):** add an upgrade reason. Managed Pricing
   feature bullets are capped at **40 chars**, so use `Catch checkout.liquid sunset risks`
   (34/40). This detector (and Broken Links) are Standard-only but currently unnamed in the
   Standard pricing card (see the "Pricing-card gap" note below).
2. **Forum / content angle:** a "checkout.liquid no longer renders; here's how to find
   every script that already stopped running" post (see `marketing-plan.md §1`). Highest-leverage home for it.
3. **Not** an App Store Ads keyword: near-zero merchant search volume (sell it in body/content).

### Pricing-card gap (Managed Pricing, 40 chars/bullet)

The live Standard card sells **mechanics** (full detail, scan cadence, trend) but names none
of its **outcome** detectors. Two flagship Standard-only detectors are invisible at the $29
decision point: **Broken Links** (`DANGLING_REFERENCE`) and **checkout.liquid sunset**
(`CHECKOUT_SUNSET`). For ad-driven traffic deciding whether to pay, concrete outcomes beat
"more detail." Candidate bullets (all ≤40):

- `Catch broken links from old apps` (32): names Broken Links
- `Catch checkout.liquid sunset risks` (37): names checkout sunset, present-harm
- `Weekly auto-scan + findings trend` (33): folds cadence + trend into one benefit line

Also update `docs/pricing-and-plans.md` in the same pass; its Standard/Free listing bullets
have drifted from the live cards ("Findings grouped by impact" and "Findings trend over time"
are live; the doc still says "Severity counts" and "Theme Health Score + delta").

### SEO title (60 max, Google) — 60 chars
```
GhostCode: Find & Remove Leftover App Code in Shopify Themes
```

### Meta description (160 max, Google) — 157 chars
```
Scan your Shopify theme for orphaned code left by uninstalled apps. 30+ checks, 100+ app signatures, file-level attribution, AI & SEO fixes. First scan free.
```

### Category
Site optimization > Other. No change, best available fit (no "theme audit" category exists).

---

## Visual media (highest-leverage change)

Two distinct slots — do NOT duplicate the hero in the screenshots. Current shots also
likely show the pre-s34 severity hero (and the 0/100 score tile) that no longer exists in
the product, so they misrepresent what a merchant will see. Reshoot everything. Burn the
caption into each image.

### Feature media — hero (1 image + a headline, 64 chars max)

Pick one headline (both validated ≤64 chars):

- **A (recommended):** consequence-lane dashboard —
  `See what leftover app code costs you, grouped by impact` (55)
- **B (max differentiation):** the "Found by Google & AI" lane —
  `Is your store feeding AI agents the wrong price?` (48)

Recommend A: it's the product's actual face and the reframe that separates GhostCode from
GhostSweep / ghostcode.app, with AI given its own screenshot right below. Go B only to bet
the whole above-the-fold on the AI wedge.

### Screenshots (4–5, must not repeat the hero)

Assuming hero **A**:

| # | What to show | Caption |
|---|---|---|
| 1 | One finding: file + line + snippet + app attribution | "We trace every fragment to the app that left it" |
| 2 | The "Found by Google & AI" lane | "Catch wrong prices before Google and AI agents do" |
| 3 | Health score + trend / re-scan | "Clean it up, re-scan, watch your score climb" |
| 4 | Free-scan entry point | "Your first scan is free" |
| 5 (optional) | Scan diff (New / Resolved) — sells Pro | "Compare scans: see what's new and what's fixed" |

If you go hero **B**, swap screenshot 2 for the consequence-lane dashboard
("Findings grouped by what they cost you, not severity") so the reframe still appears.

Shot 2 (the AI lane) is the entire differentiation versus GhostSweep and ghostcode.app.
Do not cut it.

---

## Next steps (in order)

1. **Confirm the live name in Partner Dashboard.** If it still reads "Ghost Code" (two
   words), rename to "GhostCode: Theme Cleanup" before any review decision. Shopify may
   lock the name after approval.
2. **Reshoot screenshots** per the brief above. Biggest conversion lever, most likely
   stale.
3. **Wire the in-app review prompt** (`marketing-plan.md §5`) if not live. With two
   fast-followers, the review race is the moat and outweighs copy tuning.
4. **Fix the stale Free-plan feature copy in Managed Pricing:** "Severity counts + category
   breakdown" predates the s34 consequence reframe. Change to "Findings grouped by impact,
   with counts" (33/40). No other plan/limit/gating change is needed for recent releases.
5. **Reconcile the counts in `product-strategy.md` and `marketing-plan.md` too** — they
   still say "26 finding types / 115 signatures / 8 surfaces" and will drift again.

---

## Caveat

All "current listing" claims are from repo docs, not the live Partner Dashboard. Confirm
against the actual dashboard before assuming any field's present value.
