import type { ActionFunctionArgs } from "react-router";

import { logger } from "../lib/logger.server";
import { OPS_EVENT_TYPES, recordOpsEvent } from "../models/ops-event.server";
import { markShopUninstalled } from "../models/shop.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  // Record the uninstall event (best-effort — never throws) so we retain an
  // uninstall record and a data source for the operator digest (gc-bny).
  await recordOpsEvent({
    eventType: OPS_EVENT_TYPES.SHOP_UNINSTALLED,
    key: shop,
    message: "app/uninstalled",
  });

  // Revoke access (delete Sessions) and stamp Shop.uninstalledAt, but KEEP the
  // Shop + scan data. The full hard-delete stays deferred to shop/redact so the
  // 48h GDPR grace window is honored (gc-grd). Idempotent: found=false if the
  // shop row is already gone.
  const { found } = await markShopUninstalled(shop);
  if (!found) {
    logger.warn("Shop not found in DB — nothing to mark uninstalled", {
      shop,
      webhook: "app/uninstalled",
    });
  }

  return new Response(null, { status: 200 });
};
