# Session Handoff: 2026-09-12 (App Store listing + ads keywords + pricing card)

Repo: ~/shopify/ghost-code-app @ e5b4cd9 (main). **Working tree has 2 uncommitted doc edits** (see below).

> **2026-09-16 UPDATE (Nathan):** Screenshots reshot DONE and App Store Ads ($1-CPC Tier 1 terms) LIVE. Creative was refreshed before traffic went on, so the stale-hero risk below is RESOLVED. Steps 1 and 2 in "Recommended next steps" are complete.

## Session scope
Non-code session. Two asks: (1) low-cost App Store Ads keywords, (2) listing/messaging tweaks
reflecting the 3 detectors shipped last session (CHECKOUT_SUNSET, JSON_LD_INVALID,
JSON_LD_PRICE_CONFLICT). Expanded into a pricing-card fix and a stale-copy bead once the live
listing/pricing was reviewed.

## What got done
- **Ads keywords (Shopify App Store Ads, confirmed platform).** Nathan verified Tier 1 niche
  terms bid at **$1.00** (great; ~100 clicks on the $100 shared pool). Recommended set:
  `leftover code`, `app cleanup`, `orphaned code`, `remove app code`, `uninstalled app`, plus
  candidates `remove leftover code`, `leftover app code`, `clean theme code`, `code cleanup`,
  `liquid error`, and one defensive slot on `ghost code`. **Skip** `theme audit` ($10-25) and
  the whole seo/speed band. New-feature terms (checkout.liquid, structured data) are near-zero
  volume: sell in body/content, not ads. Track installs-per-keyword, not clicks.
- **Listing copy edits (`docs/gtm/listing-v2.md`, uncommitted):** count 27 to "30+ checks"
  everywhere (description 498/500, meta 157/160, bullet 4); feature bullet 3 rewritten to the
  now-live price-conflict story ("Catch schema prices that disagree with your live price before
  AI quotes it", 74 chars); added a "Timely hook" section and a "Pricing-card gap" section;
  refreshed the count-reconcile note (enum now 31, ~30 merchant-active).
- **Pricing card (decision 1A applied):** `docs/pricing-and-plans.md` (uncommitted) Standard
  listing bullets now name the two Standard-only *outcome* detectors instead of mechanics:
  Broken Links (`Catch broken links from old apps`, 32) and checkout sunset
  (`Catch checkout.liquid sunset risks`, 34), plus `Weekly auto-scan + findings trend` (33).
  Also reconciled the drifted Free bullet to the live "Findings grouped by impact, with counts".
  **Nathan applied these in Partner Dashboard -> Managed Pricing this session (confirmed done).**
- **Bead filed:** `gc-oam` (P1) for the stale checkout.liquid copy (see below).

## Key decisions
- **Ad platform = Shopify App Store Ads; surface to tweak = App Store listing** (Nathan chose
  both). Not Google, not an external marketing site (none exists in repo).
- **Soft counts ("30+ checks / 100+ signatures")** instead of exact numbers, to stop chasing
  the count every release. (Listing doc's own long-standing recommendation.)
- **Standard card = name detectors, not mechanics (1A).** Ad-driven visitors need concrete
  paid reasons; the old card read as "Free but more."
- **checkout.liquid is a secondary/content hook, NOT the hero.** It's Standard+ gated and not
  strictly "leftover code from an uninstalled app," so it would blur the core promise.
- **File-not-fix on the passed sunset date (2A):** don't derail the listing/ads work.

## Patterns & discoveries
- **Managed Pricing feature bullets cap at 40 chars** (not 80). I had this wrong in the doc
  earlier; corrected. All new pricing bullets verified <=40.
- **The checkout.liquid hard-block date has PASSED.** `SUNSET_DATE = "around August 13, 2026"`
  in `app/services/checkout-sunset-detector.server.ts:45`; today is 2026-09-12. So future/
  "imminent" tense in the in-app copy is now stale for Plus stores. This drove both the
  tense-neutral marketing framing and bead gc-oam.
- **Freemium wall:** Free shows file/line/snippet only for the single top finding; the listing
  headline bullet 2 implies it's universal. Judged an acceptable preview model (accept, not
  fix), but ~100 ad clicks land on Free and hit that wall.

## Uncommitted changes (biggest risk)
- `docs/gtm/listing-v2.md` and `docs/pricing-and-plans.md` are modified but NOT committed.
  Docs-only, in `docs/` (should be deploy-path-ignored, so safe to batch). Nathan did not ask
  to commit this session. **Next session: commit these** (suggested: `docs: refresh listing
  counts, price-conflict bullet, and Standard pricing-card detectors`).

## Open questions / deferred
- **Em-dash scrub:** I introduced em-dashes into both doc edits, against Nathan's standing
  no-em-dash rule. Offered to scrub; deferred. Do this in the same pass as the commit.
- **checkout.liquid forum post:** offered, not yet written. Reframe = "the sunset date passed
  last month, here's how to find checkout.liquid code that's already dead." Needs no dashboard
  access; good organic-discovery companion to the ads.

## Recommended next steps (leverage order)
1. ~~**Screenshots (Nathan's action, top lever).**~~ **DONE 2026-09-16:** reshot before ads.
2. ~~**Then flip on the ads** (Nathan).~~ **DONE 2026-09-16:** $1-CPC Tier 1 terms LIVE.
3. **Commit the 2 doc edits** + em-dash scrub. *(← now the top open action)*
4. **Draft the checkout.liquid forum post** (I can do this anytime).
5. **gc-oam:** reframe in-app checkout.liquid copy to tense-accurate (present-harm for Plus).

## Risks & warnings
- **bd dolt push is DOWN** (per prior handoff) -> gc-oam and any bead changes are LOCAL-ONLY,
  unsynced. Re-check if the Dolt store is back and sync.
- ~~**Don't turn ads on before screenshots** are refreshed~~ **RESOLVED 2026-09-16:** screenshots
  reshot first, then ads went live. No stale-creative exposure.
- All "live listing" facts came from Nathan's pasted preview + repo docs, not a direct Partner
  Dashboard read. Confirm any field value against the actual dashboard before assuming.
