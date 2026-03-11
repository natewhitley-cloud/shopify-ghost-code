import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../models/shop.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

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

  return new Response(null, { status: 200 });
};
