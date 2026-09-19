# Handoff — 2026-09-18 — GA4 listing tracking + listing SEO + category finding

Discovery/GTM session (no code changes). Focus: measure and improve App Store listing discovery.

## GA4 listing tracking — DONE
- **Why:** Partner Dashboard shows only post-install funnel (installs/uninstalls/earnings/merchant-growth). It does NOT expose listing views, install-conversion, or acquisition sources. Partner API doesn't either. GA4 on the listing is the ONLY path.
- **Wired:** new GA4 Property `Ghost Code` (one account, one property per app) → Web data stream (URL `apps.shopify.com`). Measurement ID + Measurement Protocol API secret pasted into Partner Dashboard → Apps → Ghost Code → Distribution → Manage listing → "Tracking information".
- **5 event-scoped custom dimensions registered** (Admin → Property settings → Data display → Custom definitions): `surface_type` (search/category/home = discovery source, the key one), `surface_detail`, `surface_inter_position`, `surface_intra_position` (ASO ranking position), `locale`.
- **Shopify auto-fires** (no Google Tag/GTM needed — listing is Shopify's page): `view_item` (listing view), `add_to_cart` (install click), `shopify_app_install` (server-side via Measurement Protocol), `shopify_app_ad_click`.
- **Gotchas:** data is forward-only + ~24h lag; custom dims only apply to data collected AFTER creation; view results in GA4 **Explore** tab (surface_type = rows, view_item/shopify_app_install = values), NOT standard Reports. Stream "Website URL" field is cosmetic metadata (no filtering) — left as `apps.shopify.com`, doesn't matter.
- Reusable across portfolio: repeat for ClearSignal, FraudPilot, TaxDelta.

## Category — NO CHANGE (investigated, dead end)
- Current: `Store design → Site optimization → Site optimization - Other`.
- Site optimization has ONLY 3 leaves: SEO, Accessibility (killed for GC, gc-y0i no WTP), Site optimization - Other. **No "Page speed" leaf exists.**
- Decision: positioning = **Store performance** (Nathan's call). For that framing, `Site optimization → Other` is already the best available slot. No appeal target exists. Category is NOT the discovery lever here.
- (Considered + rejected: Analytics/pixel category — Nathan: "isn't really analytics"; Privacy & security — real trust-and-security browse rail exists but Nathan chose performance over it.)

## Listing SEO edits — APPLIED by Nathan
- **Name:** `GhostCode: Theme Cleanup` — UNCHANGED (Nathan keeping it; avoids re-review).
- **Tagline:** `Remove leftover app code slowing your speed, SEO & AI` (53 chars).
- **Intro:** `Scan your theme for orphaned code from uninstalled apps that slows pages and misleads Google & AI.` (98 chars).
- **Details (500-char cap, net-zero swap):** `it slows your pages` → `it slows page speed` (gains "page speed" exact-match keyword, no content lost; stays ~499).
- **Bullet 1:** `See how leftover app code hurts page speed, grouped by consequence, not severity` (80 chars).
- Kept the AI/schema differentiator ("schema prices before AI quotes it") — unique term nobody ranks for.

## Biggest discovery lever is NOT text — REVIEWS
- Ghost Code = **0.0 stars / 0 reviews.** Shopify search ranking weights reviews + install velocity more than keyword text. First 5–10 reviews will move rank more than any copy tweak. Separate push when ready (post-install review nudge — see reusable-nudge-telemetry-funnel pattern).

## Next session (unchanged backlog)
- gc-1we (P1) external dead-man's-switch (cron wiring pending; H3 code live-inert).
- Digest-count DRY fix: `countNewUnknownScripts` helper in `unknown-script.server.ts` → swap into `operator-digest.ts:717`. Not beaded yet.
