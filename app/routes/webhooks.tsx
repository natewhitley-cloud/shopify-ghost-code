import type { ActionFunctionArgs } from "react-router";

import { logger } from "../lib/logger.server";
import { recordWebhookFailure } from "../models/ops-event.server";
import { deleteShopData } from "../models/shop.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        // Ghost Code does not store customer PII — only shop-level scan data about themes.
        // Acknowledge receipt with 200 OK; nothing to report.
        break;
      }

      case "CUSTOMERS_REDACT": {
        // Ghost Code does not store customer PII — only shop-level scan data about themes.
        // Nothing to redact; acknowledge receipt with 200 OK.
        break;
      }

      case "SHOP_REDACT": {
        // Hard-delete all shop data 48 hours after uninstall (GDPR shop/redact).
        // deleteShopData handles sessions, scans (cascade-deletes findings), and shop
        // in a single transaction. Returns null if already deleted (idempotent).
        const deleted = await deleteShopData(shop);
        if (!deleted) {
          logger.warn("Shop not found in DB — nothing to delete", {
            shop,
            webhook: "shop/redact",
          });
        }
        break;
      }

      default: {
        logger.warn("Unrecognized webhook topic", { topic, shop });
        break;
      }
    }
  } catch (err) {
    await recordWebhookFailure({ topic, shop, error: err });
    throw err;
  }

  return new Response(null, { status: 200 });
};
