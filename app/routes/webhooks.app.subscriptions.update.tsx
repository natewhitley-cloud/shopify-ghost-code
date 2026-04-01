import type { ActionFunctionArgs } from "react-router";

import { PLANS } from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { type BillingEventType, recordBillingEvent } from "../models/billing-event.server";
import { getShopMetadata, updateShopPlanByDomain } from "../models/shop.server";
import { authenticate, PLAN_STANDARD, PLAN_PROFESSIONAL } from "../shopify.server";

// ---------------------------------------------------------------------------
// Plan price table — amounts match billing config in shopify.server.ts.
// Used to populate BillingEvent.amount for upgrade/reactivation events.
// ---------------------------------------------------------------------------

const PLAN_AMOUNTS: Record<string, number | undefined> = {
  [PLANS.STANDARD]: 29,
  [PLANS.PROFESSIONAL]: 49,
  // FREE has no recurring charge amount
};

// ---------------------------------------------------------------------------
// Shopify subscription status → internal plan tier mapping
// ---------------------------------------------------------------------------

// Shopify sends `APP_SUBSCRIPTIONS_UPDATE` whenever a subscription is
// activated, cancelled, declined, or expires. The payload includes:
//   app_subscription.status  — ACTIVE | CANCELLED | DECLINED | EXPIRED | FROZEN | PENDING
//   app_subscription.name    — the plan name string we set in billing config
//
// We map ACTIVE subscriptions to the corresponding plan tier.
// All non-ACTIVE statuses revert the shop to FREE.

const SHOPIFY_SUBSCRIPTION_ACTIVE = "ACTIVE";

// Plan rank for upgrade/downgrade detection. Higher rank = higher tier.
const PLAN_RANK: Record<string, number> = {
  [PLANS.FREE]: 0,
  [PLANS.STANDARD]: 1,
  [PLANS.PROFESSIONAL]: 2,
};

/**
 * Map a Shopify plan name + status to the internal plan string stored on Shop.
 *
 * - ACTIVE + known plan name → the matching tier (Standard or Professional)
 * - Anything else (cancelled, declined, expired, unknown name) → FREE
 */
function resolvePlanFromSubscription(
  planName: string | undefined,
  status: string | undefined,
): string {
  if (status !== SHOPIFY_SUBSCRIPTION_ACTIVE) {
    return PLANS.FREE;
  }

  switch (planName) {
    case PLAN_STANDARD:
      return PLANS.STANDARD;
    case PLAN_PROFESSIONAL:
      return PLANS.PROFESSIONAL;
    default:
      // Unknown plan name — treat as downgrade to free rather than silently
      // granting paid features. Logs below will surface this for investigation.
      return PLANS.FREE;
  }
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
 * "upgrade" here — the distinction is cosmetic and the tester can refine
 * this logic later with additional DB context if needed.
 */
function determineBillingEventType(fromPlan: string, toPlan: string): BillingEventType | null {
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

// ---------------------------------------------------------------------------
// Webhook action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  // The payload shape from Shopify:
  // {
  //   app_subscription: {
  //     admin_graphql_api_id: "gid://shopify/AppSubscription/123",
  //     name: "Standard",
  //     status: "ACTIVE",
  //     ...
  //   }
  // }
  const subscription = (payload as Record<string, unknown>)?.app_subscription as
    | { name?: string; status?: string }
    | undefined;

  if (!subscription) {
    // Malformed payload — log but return 200 to avoid Shopify retries.
    logger.error("Missing app_subscription in payload", {
      shop,
      webhook: "app/subscriptions/update",
    });
    return new Response(null, { status: 200 });
  }

  const planName: string | undefined = subscription.name;
  const status: string | undefined = subscription.status;

  const newPlan = resolvePlanFromSubscription(planName, status);

  logger.info("Resolving plan from subscription", {
    shop,
    webhook: "app/subscriptions/update",
    planName,
    status,
    newPlan,
  });

  // Fetch the current shop record to capture the old plan before updating.
  // We need the old plan to classify the billing event type correctly.
  const existingShop = await getShopMetadata(shop);

  const updated = await updateShopPlanByDomain(shop, newPlan);

  if (!updated) {
    // Shop not found in DB — this can happen if a webhook fires before the
    // shop has been installed (race condition) or after shop/redact. Safe to
    // return 200 since there is nothing to update.
    logger.warn("Shop not found in DB — skipping plan update", {
      shop,
      webhook: "app/subscriptions/update",
    });
    // ALWAYS return 200. Non-200 causes Shopify to retry indefinitely.
    return new Response(null, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Record billing event — non-blocking: failures must not break the webhook.
  // ---------------------------------------------------------------------------

  if (existingShop) {
    const fromPlan = existingShop.plan;
    const eventType = determineBillingEventType(fromPlan, newPlan);

    if (eventType !== null) {
      const amount = PLAN_AMOUNTS[newPlan] ?? null;

      recordBillingEvent({
        shopId: updated.id,
        eventType,
        fromPlan,
        toPlan: newPlan === PLANS.FREE ? null : newPlan,
        amount,
      })
        .then(() => {
          logger.info("billing-event-recorded", {
            shopId: updated.id,
            eventType,
            fromPlan,
            toPlan: newPlan === PLANS.FREE ? null : newPlan,
          });
        })
        .catch((err: unknown) => {
          // Log the error but do NOT re-throw — billing event recording is
          // observability infrastructure and must never interrupt the plan update.
          logger.error("Failed to record billing event", {
            shopId: updated.id,
            eventType,
            fromPlan,
            toPlan: newPlan,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  // ALWAYS return 200. Non-200 causes Shopify to retry indefinitely.
  return new Response(null, { status: 200 });
};
