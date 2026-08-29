# GhostCode — App Store Ads Campaign

Draws from the **shared** $100 Shopify Partner ad credit (one per-account credit, applies before your card across ALL ad spend — NOT per-app) · Created 2026-08-28 · Mirrors the ClearSignal playbook (`bot-analytics-cleanup-app/docs/gtm/ad-campaign.md`, bead `ba-wi4`).

## What this is — a CHEAP slice of the shared credit

A small **signal experiment**, not a growth channel. Goal: learn which framing
merchants click — **exact-problem language** ("leftover code," "orphaned code") vs.
**solution/category** ("theme cleanup," "theme audit") vs. the **Liquid-error** angle
— so listing copy, community answers, and content can follow the demand.

**Budget posture: cheap.** The $100 credit is a single shared pool (ClearSignal's
`ba-wi4` was built but never redeemed, so it's likely intact). GhostCode takes a
**small slice (~$25–35)** so ClearSignal's experiment keeps most of it. Run at the
**$5/day floor** and pause at ~$30 spend, or cap the run at ~6 days. If both apps'
campaigns are ever live at once, they drain the same $100 together — so sequence them,
or watch the combined spend.

**Grade on CTR-by-cluster and effective CPC — NOT installs/CPI.** GhostCode's terms are
long-tail/low-comp (like ClearSignal's ~$1 AI terms, far under the $7–35 first-price
assumption), so ~$30 still buys ~25–40 clicks — a real CTR read across the trimmed
cluster set, though too few for a reliable CPI.

## Pre-flight before clicking Redeem (90-day clock starts on redeem)

The 90-day expiry begins when you click **Redeem in Partner Dashboard → Bills** — not
before. Do not redeem until all are true:

- [ ] **Credit actually exists for GhostCode.** The Partner ad credit may be one-time
      per partner (ClearSignal's `ba-wi4` may have consumed it). Check Partner
      Dashboard → Settings → Bills / Credits. If there's no credit, this is **real
      spend** — decide the budget deliberately before proceeding.
- [ ] **Delist issue resolved / review passed.** Do not drive paid installs into an app
      whose core scan just failed review. Wait for the resubmission to clear.
- [ ] Listing name/subtitle/description final (the `GhostCode` rename + PAS description
      from `marketing-plan.md` §4 live and review-passed).
- [ ] Screenshots current on the live listing.
- [ ] Pricing set; first-run + scan→**Complete** flow verified in prod.
- [ ] Daily budget set to $10–12.

## Targeting

| Setting        | Value                                | Why                                                                       |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| App            | GhostCode                            | (not ClearSignal)                                                         |
| Placement      | **Search results**                   | Only placement with keyword control — required to test the framing angles |
| Device         | **Desktop only**                     | Theme-code cleanup is a desktop admin task                                 |
| Geo            | **US + Canada**                      | English forum language; CA adds cheap volume without muddying the read     |
| Daily budget   | **$5/day** (Shopify floor)           | Cheap slice; pause at ~$30 spend or ~6 days                               |
| Targeted plans | All merchants                        | (Cleanup pain scales with install history, not plan)                      |
| Name           | `ghostcode-leftover-code-search-cheap` | Internal only                                                             |

**Ad copy (proposed):** "GhostCode: Theme Cleanup" —
_"Find & remove leftover code from apps you uninstalled — scan free."_

## Keywords (all Broad match) — trimmed for a cheap run

At $5/day, a **focused 6-keyword set** gives a cleaner read than spreading spend thin.
Bids are **starting points** — set each to Shopify's live Desktop suggestion in the UI
if it differs. `$1.00` = expected floor for these long-tail terms. We want CTR *per
cluster*.

| #   | Keyword                | Bid   | Cluster                    | Notes                                                                 |
| --- | ---------------------- | ----- | -------------------------- | --------------------------------------------------------------------- |
| 1   | leftover app code      | $1.50 | **Marquee (exact problem)**| The single most valuable CTR read — forum-verbatim pain               |
| 2   | orphaned code          | $1.25 | Exact problem              | Category-defining term; also a listing keyword                        |
| 3   | leftover code          | $1.25 | Exact problem              | Exact phrase merchants type in threads                                |
| 4   | theme cleanup          | $1.25 | Solution / category        | Your #1 listing keyword — the one solution term worth the read        |
| 5   | liquid error snippet   | $1.10 | Broken-reference / errors  | Distinct high-intent read (broken `render` from an uninstalled app)   |
| 6   | ghost code             | $1.50 | Brand / defense            | Defends the term vs. GhostSweep ("Ghost Code Scanner" subtitle)       |

**Held back (add only if budget allows / a second round):** `remove app code`,
`uninstalled app code` (redundant with the marquee cluster), `app cleanup`, `theme
audit` (extra solution terms), `theme speed` (generic control — contested by
speed-optimizer apps).
**Never:** `site speed`, `custom code` (opposite intent — merchants wanting to *add*
code), `app development`.

## Negative keywords

Broad match will otherwise pull the **opposite** intent (merchants wanting to *add*
code, or *build* apps). Configure:

`add` · `insert` · `inject` · `custom` (block "add/insert custom code" intent) ·
`build` · `develop` · `developer` · `create` (block app-building intent) ·
`optimizer` · `booster` · `hyperspeed` (block speed-optimizer intent bleeding in via
`theme speed`) · `malware` · `security` (block security-scanner intent — adjacent but
wrong app).

## Billing mechanics (from shopify.dev ad-billing doc)

- Credit applies automatically **before** your card. Card is charged only after the
  $100 credit is exhausted → watch spend near the end of the run.
- Credit covers full ad cost while available; invoice shows credit used per cycle.
- Ads billed on a 30-day cycle or at the $100 threshold.

## Results tracking (fill in during/after the run)

Pull from Partner Dashboard → ad report. Effective CPC = spend ÷ clicks.

| Keyword              | Cluster        | Impr. | Clicks | CTR | Spend | Eff. CPC | Installs |
| -------------------- | -------------- | ----- | ------ | --- | ----- | -------- | -------- |
| leftover app code    | Exact problem  |       |        |     |       |          |          |
| orphaned code        | Exact problem  |       |        |     |       |          |          |
| leftover code        | Exact problem  |       |        |     |       |          |          |
| theme cleanup        | Solution       |       |        |     |       |          |          |
| liquid error snippet | Errors         |       |        |     |       |          |          |
| ghost code           | Brand          |       |        |     |       |          |          |
| **TOTAL**            |                |       |        |     |       |          |          |

### Read-out (what we learned)

- **Exact-problem vs. solution vs. errors** — which cluster earned the highest CTR?
  That framing wins the listing subtitle and community-answer language.
- **Does the errors angle ("liquid error snippet") convert?** If yes, it's a whole
  content lane (per-error landing pages) the forum threads already validate.
- **Brand defense** — is `ghost code` being contested by GhostSweep? Watch its CPC.
- **Effective CPC vs. the ~$1 assumption** — did broad match / competition inflate it?
- **Verdict:** is paid a viable channel, or does the signal point GTM to
  content/community (where the forum-thread demand already lives)?
