# Ghost Code — Pricing & Plans

> **Last updated:** 2026-03-28
> **Source of truth for:** plan tiers, feature gating, upgrade triggers, pricing decisions.
> Update this file when billing logic, plan features, or pricing changes.

---

## Plan Tiers

### Free ($0)

| Feature                | Limit                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scans per month        | First scan always free (onboarding); then 1/month ongoing                                                                                                    |
| Finding details        | Severity counts + category breakdown (Scripts, Styles, Snippets, Sections, Orphan Assets) + single highest-severity finding shown in full; all others locked |
| Themes                 | 1                                                                                                                                                            |
| Auto-rescan on publish | No                                                                                                                                                           |
| Scan diffing           | No                                                                                                                                                           |

**Purpose:** Let merchants discover they have a problem. The first scan is the marketing moment — generous on surface, tight on actionability. Showing the worst finding with full detail (file, line, snippet) creates maximum urgency while keeping the rest locked behind upgrade.

**App listing features (max 40 chars each):**

1. First scan always free
2. 1 scan per month after first
3. Severity counts + category breakdown
4. Preview of top finding in full
5. Single theme scanning

### Standard ($29/mo, 7-day free trial)

| Feature                | Limit                                           |
| ---------------------- | ----------------------------------------------- |
| Scans                  | 1 manual per week (resets Monday 00:00 UTC)     |
| Finding details        | Full (file, line number, code snippet)          |
| Theme Health Score     | Yes (score + color band + delta between scans)  |
| Weekly scheduled scan  | Yes (automatic scan every Sunday 6 AM UTC)      |
| Monthly re-scan nudge  | Yes (in-app prompt on 1st of each month)        |
| App install nudge      | Yes (in-app banner when a new app is installed) |
| Themes                 | 1                                               |
| Auto-rescan on publish | No                                              |
| Scan diffing           | No                                              |

**Purpose:** The mid-tier workhorse. Merchants get full finding details and weekly cadence — enough to stay on top of orphaned code without unlimited manual scans. The weekly scheduled scan ensures no one falls behind even if they forget to scan manually. The 1/week manual cap creates clear daylight between Standard and Professional (unlimited).

> **Manual-quota exemption (GC-iji):** the weekly cap counts **manual** (merchant-initiated) scans only. The Sunday-6AM scheduled scan and any Professional auto-rescan (theme-publish) are exempt and never consume the manual allowance — a merchant always gets their 1 manual scan/week regardless of how many automatic scans ran. This is enforced by a `Scan.origin` column (`MANUAL` / `SCHEDULED` / `AUTO_PUBLISH`); only `MANUAL` rows are counted in `createScan`'s atomic quota check and in `countScansForShopSince`.

**App listing features (max 40 chars each):**

1. All features in Free
2. Full finding details with code
3. 1 manual scan per week
4. Theme Health Score + delta
5. 7-day free trial

### Professional ($49/mo, 7-day free trial)

| Feature                | Limit                                          |
| ---------------------- | ---------------------------------------------- |
| Scans per month        | Unlimited                                      |
| Finding details        | Full                                           |
| Themes                 | Unlimited                                      |
| Auto-rescan on publish | Yes                                            |
| Scan diffing           | Yes (new / resolved / unchanged between scans) |

**Purpose:** "Set it and forget it" for multi-theme stores. Continuous monitoring with change tracking.

**App listing features (max 40 chars each):**

1. All features in Standard
2. Unlimited scans
3. Unlimited theme scanning
4. Auto-rescan on theme publish
5. Scan diffing (New/Resolved)
6. Daily automatic scans
7. 7-day free trial

---

## Downgrade & Cancellation

- **Professional → Standard**: In-app "Switch to Standard" button on settings page. Uses `replacementBehavior: APPLY_ON_NEXT_BILLING_CYCLE` — merchant keeps Professional features until current billing cycle ends.
- **Paid → Free**: Cancel link to `shopify://admin/settings/billing`. Shopify handles cancellation. Cancellations have NO redirect back to the app, so the plan reverts to free via the on-load reconcile backstop (see Billing Mechanics), not a webhook.
- **Billing events tracked**: All upgrades, downgrades, and cancellations recorded in `BillingEvent` table for analytics.

---

## Upgrade Triggers

### Free → Standard

1. **Scan limit hit** — First scan is always free. After that, free users get 1/month; hitting that limit surfaces an upgrade prompt. Monthly quota resets on the 1st of each calendar month.
2. **Finding details locked** — Free users see severity counts, category breakdown (Scripts/Styles/Snippets/Sections/Orphan Assets), and a single highest-severity finding in full. All remaining findings are locked server-side. An upgrade banner explains what's behind the paywall.

### Standard → Professional

3. **Scan limit hit on Standard** — Standard plan allows 1 manual scan per week (resets Monday 00:00 UTC). Weekly limit reached surfaces an upgrade prompt to Professional (unlimited). Combined with auto-rescan being Pro-only, this creates meaningful upgrade pressure for active merchants.
4. **Auto-rescan skipped** — Theme publish webhooks arrive but scans are silently skipped on non-Pro plans. Standard shops get a weekly scheduled scan but miss same-day feedback when they publish a theme. Passive trigger (user doesn't see it unless they notice scans aren't auto-running).
5. **Scan diffing unavailable** — Standard users don't see "New / Resolved / Unchanged" diff badges. Pro users get change tracking.
6. **Multi-theme gating** — Defined in code (`canUseMultipleThemes()`) but not yet enforced in UI. Future feature.

---

## Billing Mechanics

- All billing goes through **Shopify's native billing API** (merchants pay via their Shopify invoice)
- Plan stored as string on `Shop` model in Prisma (`plan` field, default `"free"`)
- Plan changes are detected on app load — the `APP_SUBSCRIPTIONS_UPDATE` webhook is **DEAD as of 2026-04-28** (Shopify stopped sending it for App Pricing apps)
- Unknown plan names or non-ACTIVE subscription statuses default to `"free"` (safe fallback)
- **Plan reconciliation (source of truth):** with the webhook gone, plan state is driven entirely from the app-load loader (`app/routes/app.tsx`), which always corrects `Shop.plan` from Shopify's `currentAppInstallation.activeSubscriptions` query (`app/services/billing-reconciler.server.ts`) — the URL `plan_handle` param is NEVER trusted to grant a tier. Zero active subscriptions → `free`; if multiple are active, the highest tier wins. Reconciliation never blocks app load (errors are logged and the stored plan stands). It runs on two triggers:
  - **Redirect fast-path:** when a merchant selects/confirms a plan, Shopify redirects back with a `plan_handle` param. Its PRESENCE forces an immediate reconcile (bypassing the freshness window) so upgrades grant right away. Because this correction is merchant-initiated, it records a `BillingEvent` (restoring the analytics the webhook used to produce).
  - **Backstop:** otherwise, reconcile only when the stored plan is older than a **1-hour** freshness window (`Shop.planReconciledAt`, tunable). This covers out-of-redirect changes (cancellations, freezes, expirations, which have no redirect). Routine backstop corrections are logged but do **not** create `BillingEvent` rows, to avoid polluting conversion/churn analytics.
  - Both triggers stamp `planReconciledAt`, resetting the freshness clock. Plan-name → tier mapping lives in `app/lib/billing.server.ts` (`resolvePlanFromSubscription`).
- Test mode: `SHOPIFY_BILLING_TEST=true` env var; dev store uses test charges automatically

---

## Key Files

| File                                               | Role                                                         |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `app/lib/billing.server.ts`                        | Plan definitions, feature matrix, constants, plan mapper     |
| `app/services/billing-reconciler.server.ts`        | On-load plan reconciliation against Shopify (drift guard)    |
| `app/lib/plan-gating.server.ts`                    | Gating functions (canStartScan, canViewFindingDetails, etc.) |
| `app/shopify.server.ts`                            | Billing config with Shopify (prices, trial days)             |
| `app/routes/app.settings.tsx`                      | Settings UI with upgrade buttons                             |
| `app/routes/webhooks.app.subscriptions.update.tsx` | Webhook handler for plan changes                             |
| `app/models/billing-event.server.ts`               | BillingEvent recording and query functions                   |
| `tests/lib/plan-gating.server.test.ts`             | Comprehensive gating tests                                   |
| `inngest/functions/weekly-scan.ts`                 | Weekly scan coordinator (Standard plan, Sunday 6 AM UTC)     |
| `inngest/functions/poll-theme-changes.ts`          | Daily scan coordinator (Professional plan)                   |
| `inngest/functions/poll-check-shop.ts`             | Per-shop worker (shared by both coordinators)                |

---

## Pricing Considerations & Future Options

### Current assessment

- Free → Standard gate is strong: hiding details creates real urgency
- Standard → Professional gap ($30) may feel steep for incremental value (auto-rescan + diffing)
- 7-day trial on both paid tiers lowers friction

### Options to consider

- **Lower Standard to $19/mo** to maximize free-to-paid conversion, keep Pro at $49
- **Annual discount** (e.g., $249/yr Standard, $499/yr Pro) — common in Shopify apps, improves retention
- **Usage-based pricing** — charge per theme on Standard instead of hard-capping at 1

### Open questions

- Monitor post-launch willingness-to-pay on Pro ($49/mo). If conversion rate is strong and churn is low, consider raising to $59. Watch for agency/developer buyers who may tolerate a higher price point.
- **Agency tier (post-launch):** Is there demand for an agency-focused tier above Pro? Watch for agencies adopting Pro at scale (multiple stores per billing email, export/reporting feature requests). An agency tier would require a multi-store dashboard (significant architecture change — separate web surface outside Shopify admin), white-label reporting, and flat per-agency pricing. Low-lift precursor: add exportable PDF reports to Pro and watch uptake. Do not design for this pre-launch.
- Should auto-rescan be surfaced more actively (e.g., "a theme was published but auto-rescan is a Pro feature")? Research shows behavioral triggers convert 3–4x better than generic nudges — strong post-launch candidate.
- Is multi-theme gating worth enforcing in the UI before launch, or defer to post-launch data?

---

## Decision Log

| Date       | Decision                                                                      | Rationale                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-03-10 | Initial pricing: $0 / $29 / $59                                               | Aligned with Shopify ecosystem norms for utility apps                                                                                                                                                        |
| 2026-03-10 | 7-day trial on both paid tiers                                                | Standard for Shopify apps; reduces friction                                                                                                                                                                  |
| 2026-03-10 | Free limit: 1 scan/month                                                      | Low enough to push upgrades, high enough to demonstrate value                                                                                                                                                |
| 2026-03-10 | Finding details hidden on free (not findings themselves)                      | Showing counts creates urgency; fully hiding scans would reduce perceived value                                                                                                                              |
| 2026-03-10 | Free tier: first scan always free, then 1/month                               | Generous onboarding moment; research confirms this model is standard in Shopify audit tools. Mitigated by keeping findings locked — value is visible, not actionable.                                        |
| 2026-03-10 | Free tier: show highest-severity finding in full + count + category breakdown | "Peek" architecture outperforms pure gating per SaaS research. Count creates urgency; category breakdown signals comprehensiveness; single full finding makes the problem tangible.                          |
| 2026-03-11 | Standard: weekly scheduled scan (Sunday 6 AM UTC)                             | Differentiates Standard from Free without encroaching on Pro's daily auto-rescan. Reuses the existing poll-check-shop worker — no new per-shop logic needed. `scheduledScan: boolean` added to PlanFeatures. |
| 2026-03-10 | Pro price: $49/mo (down from $59)                                             | $49 better fits market comparables and reduces the Standard→Pro gap. Monitor post-launch — raise to $59 if willingness-to-pay signals support it.                                                            |
| 2026-03-22 | Standard: 1 scan/week (down from unlimited)                                   | Creates clear upgrade path to Professional (unlimited). Weekly cadence matches the scheduled scan rhythm. Prevents unlimited-scan abuse on mid-tier while keeping the plan useful for most merchants.        |
