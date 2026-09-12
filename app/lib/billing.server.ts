import { logger } from "./logger.server";
import { APP_HANDLE, PLANS } from "./plans";
import type { BillingEventType } from "../models/billing-event.server";
// Re-export PLANS so existing server-side import sites need no change.
export { PLANS };

// ---------------------------------------------------------------------------
// Managed Pricing URL
// ---------------------------------------------------------------------------

/**
 * Build the Shopify Managed Pricing ("Select a plan") URL for a shop.
 *
 * Correct format (verified against the live admin):
 *   https://admin.shopify.com/store/{storeHandle}/charges/{appHandle}/pricing_plans
 *
 * `storeHandle` is the shop's myshopify subdomain — the session shop domain
 * with a trailing `.myshopify.com` stripped (e.g. `nw-dev-store-2.myshopify.com`
 * → `nw-dev-store-2`). If the domain does not match that suffix we fall back to
 * using it verbatim rather than emitting a malformed URL.
 */
export function buildPricingPlansUrl(shopDomain: string): string {
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;
}

// ---------------------------------------------------------------------------
// Shopify subscription → internal plan mapping
//
// Shared by the APP_SUBSCRIPTIONS_UPDATE webhook (maps ONE subscription from
// the webhook payload) and the billing reconciler (resolves a LIST of active
// subscriptions queried from Shopify). Extracted here to keep both call sites
// behaviorally identical — a missed/stale webhook and an on-load reconcile must
// classify the same subscription state the same way.
// ---------------------------------------------------------------------------

/** Shopify's only "subscription is live" status. Everything else → FREE. */
export const SHOPIFY_SUBSCRIPTION_ACTIVE = "ACTIVE";

/** Plan rank for upgrade/downgrade detection and tie-breaking. Higher = higher tier. */
export const PLAN_RANK: Record<string, number> = {
  [PLANS.FREE]: 0,
  [PLANS.STANDARD]: 1,
  [PLANS.PROFESSIONAL]: 2,
};

/**
 * Map a Shopify plan name + status to the internal plan string stored on Shop.
 *
 * - ACTIVE + known plan name → the matching tier (Standard or Professional)
 * - Anything else (cancelled, declined, expired, unknown name) → FREE
 *
 * The plan-name constants (`PLANS.STANDARD` / `PLANS.PROFESSIONAL`) are the same
 * strings Shopify sends as the subscription name (they mirror the Managed
 * Pricing plan names and `PLAN_STANDARD` / `PLAN_PROFESSIONAL` in
 * shopify.server.ts), so a direct comparison is safe.
 */
export function resolvePlanFromSubscription(
  planName: string | undefined,
  status: string | undefined,
): string {
  if (status !== SHOPIFY_SUBSCRIPTION_ACTIVE) {
    return PLANS.FREE;
  }

  switch (planName) {
    case PLANS.STANDARD:
      return PLANS.STANDARD;
    case PLANS.PROFESSIONAL:
      return PLANS.PROFESSIONAL;
    default:
      // Unknown plan name — treat as downgrade to free rather than silently
      // granting paid features.
      return PLANS.FREE;
  }
}

// ---------------------------------------------------------------------------
// Billing-event classification
//
// Shared by the (now-deprecated) APP_SUBSCRIPTIONS_UPDATE webhook and the
// billing reconciler's redirect fast-path, so a merchant-initiated plan change
// is classified and priced identically regardless of which path recorded it.
// ---------------------------------------------------------------------------

// Plan price table — under Managed Pricing, prices are configured in the
// Shopify Partner Dashboard, not in code. These hardcoded amounts MUST be
// manually kept in sync with Partner Dashboard pricing; any drift will
// silently corrupt BillingEvent.amount records with wrong values.
// Used to populate BillingEvent.amount for upgrade/reactivation events.
export const PLAN_AMOUNTS: Record<string, number | undefined> = {
  [PLANS.STANDARD]: 29,
  [PLANS.PROFESSIONAL]: 49,
  // FREE has no recurring charge amount
};

/**
 * Resolve the recurring charge amount to record on a BillingEvent for `plan`,
 * guarding against silent PLAN_AMOUNTS drift.
 *
 * PLAN_AMOUNTS is a hand-maintained mirror of Partner Dashboard pricing. We
 * cannot detect a *value* drift (e.g. Standard changed $29 -> $39 in the
 * Dashboard) at runtime without querying each subscription's price, which would
 * need extra Admin API fields we deliberately don't fetch (gc-7wj: keep it light,
 * no new queries/scopes). What we CAN catch cheaply is a *structural* drift: a
 * plan Shopify reports as paid (rank above FREE) that has no entry here — which
 * would otherwise silently record amount=null. That signals PLAN_AMOUNTS fell out
 * of sync with PLANS and must be updated. We log a warn rather than throwing so
 * billing-event recording (fire-and-forget) is never interrupted.
 *
 * Returns the configured amount, or null when unmapped (FREE, or an unmapped
 * paid plan — the latter also warns).
 */
export function resolvePlanAmount(plan: string): number | null {
  const amount = PLAN_AMOUNTS[plan];
  if (amount === undefined) {
    if ((PLAN_RANK[plan] ?? 0) > PLAN_RANK[PLANS.FREE]) {
      logger.warn("billing-plan-amount-missing", {
        plan,
        message:
          "Paid plan has no PLAN_AMOUNTS entry — PLAN_AMOUNTS may be out of sync with " +
          "Partner Dashboard pricing; BillingEvent.amount will be recorded as null.",
      });
    }
    return null;
  }
  return amount;
}

/**
 * Determine the billing event type by comparing old and new plan tiers.
 *
 * Rules:
 *   - new plan is FREE and old plan was FREE → no meaningful event, return null
 *   - new plan is paid, old plan was FREE (including first install) → upgrade
 *   - new plan is FREE, old plan was paid → cancellation
 *   - new plan rank > old plan rank → upgrade
 *   - new plan rank < old plan rank → downgrade
 *   - same rank → null (no-op, e.g. ACTIVE webhook for unchanged plan)
 *
 * "Reactivation" occurs when a shop returns to ANY paid plan after being on
 * FREE. Because we can't distinguish "first subscribe" from "reactivate after
 * cancellation" without a full billing history query, we classify both as
 * "upgrade" here — the distinction is cosmetic and can be refined later with
 * additional DB context if needed.
 */
export function determineBillingEventType(
  fromPlan: string,
  toPlan: string,
): BillingEventType | null {
  const fromRank = PLAN_RANK[fromPlan] ?? 0;
  const toRank = PLAN_RANK[toPlan] ?? 0;

  if (fromRank === toRank) return null;

  if (toPlan === PLANS.FREE) {
    return "cancellation";
  }

  if (fromPlan === PLANS.FREE) {
    return "upgrade";
  }

  return toRank > fromRank ? "upgrade" : "downgrade";
}

// Feature flags per plan. Used to gate UI and service-layer behavior.
export type PlanFeatures = {
  maxScansPerMonth: number;
  maxScansPerWeek: number;
  showFindingDetails: boolean;
  maxThemes: number;
  autoRescan: boolean;
  scanDiffing: boolean;
  /** Whether the plan receives any form of scheduled (automatic) scanning. */
  scheduledScan: boolean;
  /**
   * Whether the plan includes dangling-reference (Broken Links) detection.
   * Paid-only (Standard and above); Free does not get this audit (gc-m4h.7).
   */
  canDetectDanglingReferences: boolean;
  /**
   * Whether the plan includes checkout-extensibility sunset (Checkout Sunset)
   * detection. Paid-only (Standard and above); Free does not get this audit
   * (gc-b3c), mirroring canDetectDanglingReferences.
   */
  canDetectCheckoutSunset: boolean;
};

export function getPlanFeatures(planName: string): PlanFeatures {
  switch (planName) {
    case PLANS.STANDARD:
      return {
        maxScansPerMonth: Infinity,
        maxScansPerWeek: 1,
        showFindingDetails: true,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: true, // Weekly scheduled scan, Sunday 6 AM UTC via weekly-scan cron
        canDetectDanglingReferences: true, // Standard+ (gc-m4h.7)
        canDetectCheckoutSunset: true, // Standard+ (gc-b3c)
      };
    case PLANS.PROFESSIONAL:
      return {
        maxScansPerMonth: Infinity,
        maxScansPerWeek: Infinity,
        showFindingDetails: true,
        maxThemes: Infinity,
        autoRescan: true,
        scanDiffing: true,
        scheduledScan: true, // Daily via poll-theme-changes coordinator
        canDetectDanglingReferences: true, // Standard+ (gc-m4h.7)
        canDetectCheckoutSunset: true, // Standard+ (gc-b3c)
      };
    default: // FREE — no active Shopify subscription
      return {
        maxScansPerMonth: 1,
        // Infinity signals "no weekly cap" — getScanUsage skips the weekly
        // check and falls through to the monthly limit instead.
        maxScansPerWeek: Infinity,
        showFindingDetails: false,
        maxThemes: 1,
        autoRescan: false,
        scanDiffing: false,
        scheduledScan: false,
        canDetectDanglingReferences: false, // Free does NOT get dangling-reference detection (gc-m4h.7)
        canDetectCheckoutSunset: false, // Free does NOT get checkout-sunset detection (gc-b3c)
      };
  }
}
