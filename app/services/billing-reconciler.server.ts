/**
 * Billing reconciliation service (CMP-2 / GC-fur).
 *
 * Problem
 * -------
 * Plan state is otherwise set SOLELY from the APP_SUBSCRIPTIONS_UPDATE webhook.
 * A missed, out-of-order, or stale webhook silently drifts the stored plan from
 * Shopify's truth — over- or under-granting features with nothing to
 * self-correct.
 *
 * Approach (Option A — lazy on-load reconciliation with a freshness guard)
 * -----------------------------------------------------------------------
 * On app load, if the shop's plan has not been reconciled within the freshness
 * window, query Shopify for the actual active subscriptions, resolve the
 * effective plan, and correct the stored plan if it drifted. The freshness guard
 * bounds how often the extra GraphQL round-trip runs.
 *
 * This service NEVER throws on a Shopify failure: it logs and leaves the stored
 * plan untouched so reconciliation can never break the app load.
 */

import { PLAN_RANK, PLANS, resolvePlanFromSubscription } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { isAccessDeniedError, type GraphQLResponseError } from "../lib/scope-check.server";
import { stampPlanReconciledAt, updateShopPlanByDomain } from "../models/shop.server";
import type { AdminApiContext } from "../types/shopify";

/**
 * Freshness window for plan reconciliation. The app-load loader only queries
 * Shopify for the shop's active subscriptions when the stored plan has not been
 * reconciled within this window (or has never been reconciled). Bounds how often
 * the extra GraphQL round-trip runs on app load.
 */
export const PLAN_RECONCILE_FRESHNESS_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * True when the stored plan is stale and should be reconciled against Shopify.
 * Null (never reconciled) always counts as stale.
 */
export function isPlanReconcileStale(
  planReconciledAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (planReconciledAt === null) return true;
  return now.getTime() - planReconciledAt.getTime() >= PLAN_RECONCILE_FRESHNESS_MS;
}

// `activeSubscriptions` is a plain list field on AppInstallation (NOT a
// connection), so there is no pagination to handle.
const ACTIVE_SUBSCRIPTIONS_QUERY = `
  {
    currentAppInstallation {
      activeSubscriptions {
        name
        status
      }
    }
  }
`;

type ActiveSubscription = { name?: string; status?: string };

type ReconcileResponse = {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: ActiveSubscription[] | null;
    } | null;
  } | null;
  errors?: GraphQLResponseError[];
};

/**
 * Resolve the effective plan from the list of currently-active subscriptions.
 *
 * Shopify returns ONLY active subscriptions (typically 0 or 1). We defensively
 * handle the multi-subscription case by resolving each and selecting the HIGHEST
 * tier (by plan rank), so a shop is never under-granted while any paid
 * subscription is active. Zero active subscriptions → FREE.
 */
export function resolveEffectivePlan(subscriptions: ActiveSubscription[]): string {
  let bestPlan: string = PLANS.FREE;
  let bestRank = PLAN_RANK[PLANS.FREE];

  for (const sub of subscriptions) {
    const plan = resolvePlanFromSubscription(sub.name, sub.status);
    const rank = PLAN_RANK[plan] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      bestPlan = plan;
    }
  }

  return bestPlan;
}

export type ReconcileResult =
  | { status: "corrected"; fromPlan: string; toPlan: string }
  | { status: "matched"; plan: string }
  | { status: "skipped-error" }
  | { status: "shop-not-found" };

/**
 * Reconcile a shop's stored plan against Shopify's actual active subscriptions.
 *
 * On success (match or drift correction) `planReconciledAt` is stamped via the
 * shop model so the freshness clock resets. On any Shopify error the function
 * logs and returns without touching the stored plan — it NEVER throws.
 *
 * Drift corrections deliberately do NOT record a BillingEvent: BillingEvents
 * capture merchant-initiated billing actions sourced from the webhook (the
 * canonical signal). A reconciliation is an internal data-integrity repair;
 * recording it would pollute conversion/churn analytics and risk double-counting
 * if the originally-missed webhook later arrives. We log the correction instead.
 */
export async function reconcileShopPlan(
  admin: AdminApiContext,
  shop: { domain: string; plan: string },
): Promise<ReconcileResult> {
  let json: ReconcileResponse;
  try {
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    json = (await response.json()) as ReconcileResponse;
  } catch (err) {
    // Transport-level failure (network, timeout, 5xx). Never throw — the stored
    // plan stands until the next reconcile attempt.
    logger.error("billing-reconcile-request-failed", {
      shop: shop.domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped-error" };
  }

  const errors = json.errors ?? [];
  if (errors.length > 0) {
    const accessDenied = errors.some(isAccessDeniedError);
    // Never expose raw GraphQL errors to the merchant — log internally only.
    logger.error("billing-reconcile-graphql-error", {
      shop: shop.domain,
      accessDenied,
      error: errors[0]?.message ?? "unknown GraphQL error",
    });
    return { status: "skipped-error" };
  }

  const subscriptions = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const effectivePlan = resolveEffectivePlan(subscriptions);

  if (effectivePlan === shop.plan) {
    // No drift — still stamp so the freshness clock resets.
    const stamped = await stampPlanReconciledAt(shop.domain);
    if (!stamped) return { status: "shop-not-found" };
    return { status: "matched", plan: effectivePlan };
  }

  // Drift detected — correct the stored plan. updateShopPlanByDomain also stamps
  // planReconciledAt.
  const updated = await updateShopPlanByDomain(shop.domain, effectivePlan);
  if (!updated) return { status: "shop-not-found" };

  logger.warn("billing-reconcile-corrected-drift", {
    shop: shop.domain,
    fromPlan: shop.plan,
    toPlan: effectivePlan,
    activeSubscriptionCount: subscriptions.length,
  });

  return { status: "corrected", fromPlan: shop.plan, toPlan: effectivePlan };
}
