# Ghost Code — the "so what / now what" reframe

**Status:** proposal / strategy (drafted 2026-09-02, autonomous session while Nathan away). Not built. Tracking bead: see end.

## The problem in one line

Ghost Code's *detection* is world-class (26 detectors, 115 signatures — the moat). Its *communication* stops at data: the merchant arrives anxious ("what's running on my store?") and leaves with homework ("45 findings, 21 High / 14 Medium / 10 Low, Theme Health 0/100"). It's a lab report, not a decision. We answer **"what did we find"** brilliantly and under-serve **"so what does it cost me"** and **"now what do I do."**

## The merchant's actual job (the anchor)

Not "get a list." The job is emotional first: **"Tell me nothing is running on my store that I didn't intend — and if there is, get rid of it without hiring a developer."** Desired end-state = **confidence**: a store that's fast, correctly found, behaves as intended, nothing rogue. The journey is `anxiety → clarity → action → resolution`. GC nails *clarity-as-data* and stalls before action and resolution.

## So what — reframe the hero from SEVERITY to CONSEQUENCE

Merchants don't think in "High/Medium/Low." They think in stakes. Reorganize the 26 finding types onto a consequence axis (severity becomes the within-lane sort). Grounded mapping of all 26 types → consequence (full table in the mockup + agent analysis):

| Consequence lane | # types | The merchant "so what" | Urgency skew |
|---|---|---|---|
| **Customers see it** | 6 | Shoppers may see leftover widgets, a fake "sale" price, or broken sections | Act-now |
| **Found by Google & AI** | 9 | Search engines *and* AI shopping agents get wrong or blocked info about your store | Compounding |
| **Speed** | 5 | Every page carries dead code from apps you removed, slowing the store | Act-now (constant) |
| **Still tracking you** | 1 (GHOST_PIXEL, HIGH) | A removed app may still be collecting your visitors' data | Act-now |
| **Housekeeping** | 5 | Harmless leftover clutter — clean up when convenient | Whenever |

Each number becomes a *consequence with a stake attached* — which is the "so what" that already lives in the marketing copy but never made it into the product. A merchant who reads *"2 findings may be showing customers the wrong price"* knows what to click first.

### Decisions resolved (Nathan's taxonomy questions)
- **Multiplicity:** primary + secondary tags. ~10 of 26 types legitimately span two lanes (a tracker script = Speed + Privacy). Hero counts by **primary** (clean addition, no double-count); secondary tags drive filtering.
- **Certainty:** the type→lane mapping is code-deterministic (high confidence). Whether a finding is *actively* harming is lower and context-dependent — so copy says **"affects X"** (category truth), reserving "is costing you" for verifiable cases. Three types are genuinely uncertain-if-orphaned (GHOST_METAFIELD, GHOST_TAG, GHOST_TRANSLATION) → soft copy ("worth a check"), which matches their Housekeeping/Whenever tier.
- **Urgency:** model as **Act-now** (active harm) / **Compounding** (worsens the longer it sits) / **Whenever** (cosmetic) — not calendar deadlines. Correlates with lane + severity.

## Now what — the three moves that close the loop

1. **Prioritize by consequence + urgency**, not just severity. Surface a "Start here" — the highest-urgency lane — instead of a flat 45-row table.
2. **Guided remediation.** The per-finding "how to remove" copy already exists (`finding-remediation.ts`). Surface it as a do-this-first path with the app attributed, not buried in a table cell.
3. **Proof of resolution.** Re-scan → the trend chart shows the count drop. This engine is *already built* (`HealthScoreTrendChart`) and underused — it's the payoff that turns anxiety into confidence. Make "re-scan to confirm it's gone" an explicit step.

## Where the agentic bet fits

The **"Found by Google & AI"** lane is the growth story. It's the largest lane (9 types), and it's where the agentic epic (`gc-47c`) surfaces to the merchant: the Offer price/availability conflict detector, the AI-crawler-block detector, and the agentic so-what copy all populate this lane. So agentic isn't a separate product — it's the highest-momentum lane of the core reframe. Positioning wedge: *"Is your store feeding AI shopping agents the wrong price?"*

## Health score reframe (smaller)

"0/100 CRITICAL" is abstract. Pair the score with (a) the dominant consequence ("mostly hurting: how you're found by Google & AI") and (b) the trend direction (already computed: "Improving"). The number stays; the *meaning* gets attached.

## Correctness issue found while mapping (independent of the reframe)

Four finding-type LABELS misdescribe their detector's real behavior — worth fixing for merchant trust:
- `GHOST_PRICE` label "Price Markup" → actually persistent Admin-API compare-at (strikethrough) pricing, not schema markup.
- `GHOST_TAG` label "Theme Tags" → actually a **product** tag (Admin API), not theme code.
- `GHOST_PAGE` label "Page Templates" → actually an Admin content **Page**, not a template file.
- `GHOST_ROBOTS` label "Robots.txt Rules" → actually a **meta robots** directive in theme markup, not the robots.txt file.

## Recommended sequencing

1. Ship `gc-47c.7` (agentic so-what copy) — it's the first, cheapest thread of this whole reframe.
2. Build the **consequence-axis hero** (this doc's core) as its own epic — mockup attached for review.
3. Layer the agentic detectors (`gc-47c.5/.9/.8`) into the "Found by Google & AI" lane.
4. Fold in guided-remediation + re-scan-proof as the "now what."
