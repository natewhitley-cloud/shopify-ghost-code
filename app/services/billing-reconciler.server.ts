/**
 * Billing reconciliation service (CMP-2 / GC-fur).
 *
 * Problem
 * -------
 * The APP_SUBSCRIPTIONS_UPDATE webhook — historically this app's primary
 * plan-state writer — is DEAD as of 2026-04-28: Shopify stopped sending it for
 * apps on Shopify App Pricing. Plan state is now driven by two mechanisms, both
 * routed through this reconciler:
 *   1. Redirect fast-path: when a merchant selects/confirms a plan Shopify
 *      redirects back with a `plan_handle` param, which triggers an immediate
 *      reconcile in app/routes/app.tsx (bypassing the freshness guard).
 *   2. On-load reconcile: a periodic backstop that self-corrects drift from
 *      out-of-redirect changes (cancellations, freezes, expirations).
 *
 * Approach (Option A — lazy on-load reconciliation with a freshness guard)
 * -----------------------------------------------------------------------
 * On app load, query Shopify for the actual active subscriptions, resolve the
 * effective plan, and correct the stored plan if it drifted. The freshness guard
 * bounds how often the extra GraphQL round-trip runs; the redirect fast-path
 * ignores it so an upgrade is granted immediately.
 *
 * This service NEVER throws on a Shopify failure: it logs and leaves the stored
 * plan untouched so reconciliation can never break the app load.
 */

import {
  PLAN_AMOUNTS,
  PLAN_RANK,
  PLANS,
  determineBillingEventType,
  resolvePlanFromSubscription,
} from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { isAccessDeniedError, type GraphQLResponseError } from "../lib/scope-check.server";
import { recordBillingEvent } from "../models/billing-event.server";
import { stampPlanReconciledAt, updateShopPlanByDomain } from "../models/shop.server";
import type { AdminApiContext } from "../types/shopify";

/**
 * Freshness window for the on-load reconcile backstop. The app-load loader only
 * queries Shopify for the shop's active subscriptions when the stored plan has
 * not been reconciled within this window (or has never been reconciled).
 *
 * The redirect fast-path (app/routes/app.tsx, triggered by the `plan_handle`
 * param) now handles the acute upgrade case immediately, so this window is only
 * the backstop for out-of-redirect changes — cancellations, freezes, and
 * expirations, which have NO redirect. 1h bounds how long those can over-grant
 * before self-correcting while limiting extra Admin API round-trips. Tunable.
 */
export const PLAN_RECONCILE_FRESHNESS_MS = 1 * 60 * 60 * 1000; // 1 hour

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
 * Query Shopify for the shop's current active subscriptions.
 *
 * Returns the subscription list on success, or null on any transport-level or
 * GraphQL error. All failures are logged internally. This function never throws.
 */
async function fetchActiveSubscriptions(
  admin: AdminApiContext,
  shopDomain: string,
): Promise<ActiveSubscription[] | null> {
  let json: ReconcileResponse;
  try {
    const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    json = (await response.json()) as ReconcileResponse;
  } catch (err) {
    // Transport-level failure (network, timeout, 5xx). Never throw — the stored
    // plan stands until the next reconcile attempt.
    logger.error("billing-reconcile-request-failed", {
      shop: shopDomain,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const errors = json.errors ?? [];
  if (errors.length > 0) {
    const accessDenied = errors.some(isAccessDeniedError);
    // Never expose raw GraphQL errors to the merchant — log internally only.
    logger.error("billing-reconcile-graphql-error", {
      shop: shopDomain,
      accessDenied,
      error: errors[0]?.message ?? "unknown GraphQL error",
    });
    return null;
  }

  return json.data?.currentAppInstallation?.activeSubscriptions ?? [];
}

/**
 * Reconcile a shop's stored plan against Shopify's actual active subscriptions.
 *
 * On success (match or drift correction) `planReconciledAt` is stamped via the
 * shop model so the freshness clock resets. On any Shopify error the function
 * logs and returns without touching the stored plan — it NEVER throws.
 *
 * BillingEvent recording is gated on `options.recordEvent` (default false):
 *
 *   - Routine on-load reconciles (recordEvent omitted/false) deliberately do NOT
 *     record a BillingEvent. A routine reconcile is an internal data-integrity
 *     repair, not a merchant-initiated action; recording it would pollute
 *     conversion/churn analytics. We log the correction instead.
 *   - The redirect fast-path passes `recordEvent: true`. That correction IS
 *     merchant-initiated (they just confirmed a plan and Shopify redirected back
 *     with `plan_handle`), so we record a BillingEvent — restoring the analytics
 *     the now-dead APP_SUBSCRIPTIONS_UPDATE webhook used to produce. Recording is
 *     fire-and-forget and never blocks or breaks the reconcile.
 *
 *   On Admin API failure with recordEvent: true, exactly one retry is attempted.
 *   A permanent loss is otherwise possible — backstop reconciles run with
 *   recordEvent: false and will not re-record the missed event.
 */
export async function reconcileShopPlan(
  admin: AdminApiContext,
  shop: { domain: string; plan: string },
  options: { recordEvent?: boolean } = {},
): Promise<ReconcileResult> {
  let subscriptions = await fetchActiveSubscriptions(admin, shop.domain);

  if (subscriptions === null) {
    // Failed. For the redirect fast-path (recordEvent: true), a lost BillingEvent
    // is permanent — backstop reconciles run with recordEvent: false and will not
    // re-record. Retry exactly once; routine backstop reconciles do NOT retry.
    if (options.recordEvent) {
      logger.warn("billing-reconcile-redirect-retry", { shop: shop.domain });
      subscriptions = await fetchActiveSubscriptions(admin, shop.domain);
      logger.info("billing-reconcile-redirect-retry-outcome", {
        shop: shop.domain,
        succeeded: subscriptions !== null,
      });
    }
    if (subscriptions === null) {
      return { status: "skipped-error" };
    }
  }

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

  if (options.recordEvent) {
    recordReconcileBillingEvent(updated.id, shop.plan, effectivePlan);
  }

  return { status: "corrected", fromPlan: shop.plan, toPlan: effectivePlan };
}

/**
 * Record a BillingEvent for a merchant-initiated (redirect-triggered) drift
 * correction, mirroring what the deprecated APP_SUBSCRIPTIONS_UPDATE webhook did.
 *
 * Fire-and-forget: failures are logged but never propagated — recording is
 * observability infrastructure and must never interrupt or break app load.
 */
function recordReconcileBillingEvent(shopId: string, fromPlan: string, toPlan: string): void {
  const eventType = determineBillingEventType(fromPlan, toPlan);
  if (eventType === null) return;

  const amount = PLAN_AMOUNTS[toPlan] ?? null;
  const recordedToPlan = toPlan === PLANS.FREE ? null : toPlan;

  recordBillingEvent({ shopId, eventType, fromPlan, toPlan: recordedToPlan, amount })
    .then(() => {
      logger.info("billing-event-recorded", {
        shopId,
        eventType,
        fromPlan,
        toPlan: recordedToPlan,
      });
    })
    .catch((err: unknown) => {
      logger.error("Failed to record billing event", {
        shopId,
        eventType,
        fromPlan,
        toPlan,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
