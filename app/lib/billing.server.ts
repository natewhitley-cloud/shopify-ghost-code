// Import PLANS for local use and re-export for existing server imports.
import { PLANS } from "./plans";
export { PLANS };

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
      };
  }
}
