# Pending Beads — awaiting beads-lineage reconciliation (2026-07-01)

These are file-and-forget captures. They are NOT in the `bd` DB, because the live
Dolt DB is in the anomalous 168-world lineage and is frozen until reconciled (see
`handoff-2026-07-01-session17.md`). Convert each to a real bead via `bd create`
once the canonical lineage is chosen.

---

## BEAD-1 — App Store listing SEO / discoverability pass (post-launch)

- **type:** task
- **priority:** P2
- **labels:** gtm, aso, listing
- **context:** Ghost Code approved + live 2026-07-01. Live listing reviewed at
  https://apps.shopify.com/ghost-code. Grounded in `docs/marketing-plan.md`
  (ASO audit, lines 153–210) and `docs/product-strategy.md` (positioning, line 246).

### Body

Improve App Store search ranking + Google discoverability for the live listing.
Ordered by impact:

1. **App name — add a keyword (re-review gated).** Currently "Ghost Code" (10/30
   chars, zero keywords). Research says ~70% of installs come from App Store search
   and the name is the strongest ranking signal; Shopify's AI already flagged the
   name as generic. Recommend **"Ghost Code: Theme Audit"** — accurate to a
   detect/report tool, avoids the "cleanup/remove" overpromise on a 0-review listing.
   Alt (higher volume, higher overpromise risk): "Ghost Code - Theme Cleanup" — hold
   until GC-c4g (cleanup-request action) ships and makes "cleanup" true.
   NOTE: changing an approved app's name triggers a listing re-review — one-time cost
   for a permanent ranking gain. This is the item gating the others; batch any other
   re-review-worthy listing changes with it. (Supersedes/absorbs GC-fh0.)

2. **Keyword slots — swap "theme speed" → "leftover app code" (or "code after
   uninstall").** Current 5: theme cleanup, orphaned code, theme speed, app cleanup,
   theme audit. "theme speed" loses to dedicated speed apps (Hyperspeed, Boostify);
   swap for a thin-competition term where Ghost Code is the direct answer. Free, no
   re-review.

3. **Fix tagline overpromise.** Live tagline is "Find and **remove** leftover app
   code…" but the app detects/reports, it does not remove (GC-c4g unbuilt). On a
   0-review listing, "it doesn't actually remove anything" is the most likely 1-star.
   Change verb to "Find and **fix**" / "**Detect** leftover app code…". Keeps SEO
   keywords, drops the promise. Free, no re-review.

4. **Verify SEO title + meta description (Partner Dashboard).** Controls Google
   ranking for "shopify remove app code" etc. Ensure the SEO title leads with
   "leftover app code" / "remove app code," not the brand name. Free, no re-review.

### Strategic note (from product-strategy.md:246)
No natural browse category — discovery is search-driven. Two fronts:
- **Cause-aware** ("leftover app code," "code after uninstall") — thin competition,
  we're the direct answer. Own these via name + keyword slots.
- **Symptom-aware** ("slow store," "improve SEO") — high volume, brutal competition;
  let the *tagline* reach for these, don't burn keyword slots fighting speed apps.

### Ceiling / dependency
All keyword tuning is capped by **social proof**: at 0 reviews the listing is buried
regardless of copy. Highest-leverage discoverability work is actually getting the
**first 5–10 reviews** (see GC-cjo demo store + early-adopter outreach) — sequence
that ahead of, or alongside, the re-review-gated name change.

### Definition of done
- New app name live (post re-review) OR explicit decision to keep "Ghost Code"
- Keyword slot #3 swapped
- Tagline verb corrected
- SEO title/meta verified to lead with primary keyword
