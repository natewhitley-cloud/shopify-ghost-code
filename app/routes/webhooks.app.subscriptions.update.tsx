import type { ActionFunctionArgs } from "react-router";

import {
  PLANS,
  PLAN_AMOUNTS,
  determineBillingEventType,
  resolvePlanFromSubscription,
} from "../lib/billing.server";
import { logger } from "../lib/logger.server";
import { recordBillingEvent } from "../models/billing-event.server";
import { recordWebhookFailure } from "../models/ops-event.server";
import { getShopMetadata, updateShopPlanByDomain } from "../models/shop.server";
import { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// DEPRECATED as of 2026-04-28.
//
// Shopify STOPPED sending the APP_SUBSCRIPTIONS_UPDATE webhook on that date for
// apps on Shopify App Pricing (formerly Managed Pricing). This handler is no
// longer invoked. It is retained only for pre-cutover safety / historical
// reference — do NOT rely on it for plan state. Plan state is now driven by the
// redirect fast-path + on-load reconcile in app/routes/app.tsx (see
// app/services/billing-reconciler.server.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Webhook action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  try {
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

    // -------------------------------------------------------------------------
    // Record billing event — non-blocking: failures must not break the webhook.
    // -------------------------------------------------------------------------

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
  } catch (err) {
    await recordWebhookFailure({ topic, shop, error: err });
    throw err;
  }

  // ALWAYS return 200. Non-200 causes Shopify to retry indefinitely.
  return new Response(null, { status: 200 });
};
