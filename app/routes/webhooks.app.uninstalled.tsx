import type { ActionFunctionArgs } from "react-router";

import { logger } from "../lib/logger.server";
import { deleteShopData } from "../models/shop.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  // Delete all Ghost Code data for this shop atomically.
  // deleteShopData handles sessions, scans (cascade-deletes findings), and shop
  // in a single transaction. Returns null if the shop is already gone (idempotent).
  const deleted = await deleteShopData(shop);
  if (!deleted) {
    logger.warn("Shop not found in DB — nothing to delete", {
      shop,
      webhook: "app/uninstalled",
    });
  }

  return new Response(null, { status: 200 });
};
