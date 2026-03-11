import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { PLAN_STANDARD, PLAN_PROFESSIONAL } from "../shopify.server";
import { updateShopPlanByDomain } from "../models/shop.server";
import { PLANS } from "../lib/billing.server";

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

// ---------------------------------------------------------------------------
// Webhook action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // The payload shape from Shopify:
  // {
  //   app_subscription: {
  //     admin_graphql_api_id: "gid://shopify/AppSubscription/123",
  //     name: "Standard",
  //     status: "ACTIVE",
  //     ...
  //   }
  // }
  const subscription = (payload as any)?.app_subscription;

  if (!subscription) {
    // Malformed payload — log but return 200 to avoid Shopify retries.
    console.error(
      `app/subscriptions/update: missing app_subscription in payload for ${shop}`,
    );
    return new Response(null, { status: 200 });
  }

  const planName: string | undefined = subscription.name;
  const status: string | undefined = subscription.status;

  const newPlan = resolvePlanFromSubscription(planName, status);

  console.log(
    `app/subscriptions/update: shop=${shop} planName=${planName} status=${status} → setting plan=${newPlan}`,
  );

  const updated = await updateShopPlanByDomain(shop, newPlan);

  if (!updated) {
    // Shop not found in DB — this can happen if a webhook fires before the
    // shop has been installed (race condition) or after shop/redact. Safe to
    // return 200 since there is nothing to update.
    console.warn(
      `app/subscriptions/update: shop ${shop} not found in DB, skipping plan update`,
    );
  }

  // ALWAYS return 200. Non-200 causes Shopify to retry indefinitely.
  return new Response(null, { status: 200 });
};
