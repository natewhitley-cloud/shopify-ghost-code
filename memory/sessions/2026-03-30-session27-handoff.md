## Session Handoff: 2026-03-30 (session 27) — Marketing, Market Research, Portfolio Strategy, Design Standards

### What Got Done

1. **Trend chart component extraction** — extracted HealthScoreTrendChart + HealthScoreTrendEmptyState from app._index.tsx into dedicated component. Each component owns its own CSS. 25 new tests.
2. **Marketing plan** — created `docs/marketing-plan.md` with 15 forum threads to respond to, 3 draft forum responses, Shopify Community launch post, listing optimization review (app name keyword, PAS description, keyword swap), review collection strategy, content marketing plan, post-approval launch sequence, metrics to track.
3. **Market research agent** — created `~/shopify/.claude/agents/market-research.md` for recurring ecosystem analysis. 6-phase workflow: scrape refresh → delta analysis → forum scanning → competitive monitoring → pricing/packaging analysis → opportunity identification. Includes continuity rules, competitor watchlist, TOS compliance section.
4. **First research cycle** — refreshed DB (6,004 apps, 82K+ reviews, 467 switching mentions). Generated delta report, market analysis, and switching analysis. Scanned community forums and competitive landscape across all 4 portfolio spaces.
5. **Two new app ideas discovered** — Tax Integrity Monitor (#11, feasibility validated, `read_all_orders` gate) and Inventory Integrity Monitor (#12, standard scopes, limited by missing InventoryAdjustmentGroup query). Both added to ideas tracker.
6. **Shipping Cost Intelligence deep dive** — full API feasibility spike, reframed from "Bill Auditor" (blocked) to Path C+D hybrid MVP (automated revenue dashboard + monthly CSV upload for true costs). Product concept doc written at `strategy/shipping-cost-intelligence-concept.md`.
7. **Ember confirmed blocked** — Shopify subscriptions API can't read third-party data. Removed from active portfolio. Updated tracker, MEMORY.md, delta report, market research agent.
8. **Design standards alignment** — created `app/styles/shared.ts` with full design token system. Replaced 92 inline hex values across 4 route files. Updated `guide/design-standards.md` with CSS-in-style guidance, SVG chart pattern, per-app deviations table.
9. **Review data analysis** — 3,946 new reviews scraped. Uninstall complaint rate nearly doubled (7.9% → 15.6%). Identified 3 new feature ideas from review evidence: Visual Impact tags (GC-oak, P3), Request Cleanup action (GC-c4g, P3), Theme Integrity Check (GC-6av, P4).

### Key Decisions

- **Portfolio priority stack**: Ghost Code → Bot Analytics → Tax Integrity Monitor → Shipping Cost Intelligence → Accessibility Scanner → Inventory Integrity Monitor. Tax Integrity jumped to #3 based on quantified financial pain, proven API path, and zero competition.
- **App name should include keyword**: "Ghost Code: Theme Audit" recommended — uses 13 of 20 unused characters for free App Store SEO. Update in Partner Dashboard before review decision lands (GC-fh0, P1).
- **PAS description rewrite approved**: Problem-Agitate-Solution structure, 493 chars, no emdashes. Update alongside app name (GC-rcj, P1).
- **Keyword swap**: "theme speed" → "leftover code" — higher intent match for Ghost Code's value prop.
- **Shipping Cost Intelligence reframed**: Not a "bill auditor" (API blocked). MVP is automated revenue dashboard (Path D, instant value on install) + monthly CSV upload for true costs (Path C). $0 Free / $19 Pro pricing.
- **Ember removed from active portfolio**: Shopify subscriptions API limitation is a hard blocker. Market demand validated but technical path closed.
- **shared.ts adopted for Ghost Code**: Copied from Bot Analytics baseline, adapted with Ghost Code-specific tokens (48px heroStat, severityBadge utility, trend chart tone colors).

### In-Progress Work

None — all work completed, working tree clean (only tackline session files uncommitted).

### Uncommitted Changes

Only tackline session files — no code changes.

### Blocked Work

None blocked in beads.

### Open Questions

- **Shopify app review status**: Submitted session 25, typically 3-7 business days. No action until response.
- **Billing CSV format**: Exact column headers for Shopify billing export are undocumented. Need to purchase a test shipping label in dev store to validate. Not urgent — Shipping Cost Intelligence is behind Ghost Code and Bot Analytics.

### Recommended Next Steps

1. **P1 — Update app listing in Partner Dashboard** (GC-fh0 + GC-rcj): App name to "Ghost Code: Theme Audit", description to PAS version, keyword swap "theme speed" → "leftover code", verify SEO title/meta description. Do before review decision lands.
2. **Check Shopify Partner Dashboard** for app review status
3. **After app approval**:
   - Set `SENTRY_DSN` in Railway
   - Flip `SHOPIFY_BILLING_TEST=false` in Railway
   - Set `ENABLE_TREND_CHART=true` in Railway (GC-ur6)
   - Update upgrade CTA link to App Store URL (GC-a9j)
   - Post launch post in Shopify Community "Show Your App"
   - Respond to 2-3 forum threads (drafts in marketing-plan.md)
   - Activate $100 App Store ad credit
4. **EIN retry** — try IRS online ~2026-04-01 or call 1-800-829-4933
5. **Tax Integrity Monitor gate**: Apply for `read_all_orders` scope via Partner Dashboard. Binary answer determines if #3 in portfolio stack is buildable.
6. **While waiting**: Start work on Bot Analytics Cleanup (App 2) — next in portfolio queue
7. **Run market research cycle** in ~2 weeks using the market research agent

### Risks & Warnings

- **`SHOPIFY_BILLING_TEST=true`** still set in Railway — MUST flip to `false` before going live
- **`SENTRY_DSN`** not set — Sentry is a no-op until configured
- **`ENABLE_TREND_CHART`** not set in Railway — trend chart is invisible until toggled on
- **Operating Agreement** still missing IP Assignment clause
- **GC-viy and GC-kis** are stale beads (trend chart spec and parent) — can be closed since the feature is implemented and extracted to component

---

## Handoff state

**Source**: /handoff
**Input**: Session 27 — marketing, market research, portfolio strategy, design standards

### Items (5)

1. **Unfinished work** — 0 tasks in-progress
   - All work completed and pushed

2. **Key decisions** — 7 decisions made this session
   - decisions: portfolio priority stack, app name keyword, PAS description, keyword swap, shipping cost intelligence reframe, Ember blocked, shared.ts adoption
   - rationale preserved: yes — in handoff note + MEMORY.md + ideas tracker

3. **Resumable agents** — none

4. **Open questions** — 2 unresolved
   - questions: Shopify app review status (external), billing CSV format (deferred validation)
   - blockers: external (Shopify review team), deferred (not next priority)

5. **Risks flagged** — 4 risks
   - risks: SHOPIFY_BILLING_TEST still true, SENTRY_DSN not set, ENABLE_TREND_CHART not set, Operating Agreement missing IP clause
   - confidence: CONFIRMED

### Summary

Session 27 was a strategy session — zero code sprints, all marketing and portfolio planning. Created the marketing plan and market research agent as durable assets. First research cycle discovered Tax Integrity Monitor (#3 in stack, feasibility validated) and Inventory Integrity Monitor (#6). Shipping Cost Intelligence was reframed from blocked to a viable MVP. Design standards alignment completed (shared.ts + 92 inline replacements). The highest-priority next action is updating the app listing in Partner Dashboard (GC-fh0, GC-rcj) before the review decision lands. After that, check review status and either address feedback or start Bot Analytics Cleanup.
