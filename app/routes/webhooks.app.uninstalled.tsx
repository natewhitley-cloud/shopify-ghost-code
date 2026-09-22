import type { ActionFunctionArgs } from "react-router";

import { logger } from "../lib/logger.server";
import { recordWebhookFailure } from "../models/ops-event.server";
import { markShopUninstalledWithEvent } from "../models/shop.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  try {
    // Record the uninstall event (best-effort — never throws) AND revoke access +
    // stamp Shop.uninstalledAt, via the SHARED uninstall path (gc-dyt) so this
    // webhook and the periodic install-status reconciler can't drift. The event's
    // metadata.source is "webhook" here (vs "reconciler" for the backstop). We
    // KEEP the Shop + scan data: the full hard-delete stays deferred to
    // shop/redact so the 48h GDPR grace window is honored (gc-grd). Idempotent:
    // found=false if the shop row is already gone.
    const { found } = await markShopUninstalledWithEvent(shop, {
      source: "webhook",
      message: "app/uninstalled",
    });
    if (!found) {
      logger.warn("Shop not found in DB — nothing to mark uninstalled", {
        shop,
        webhook: "app/uninstalled",
      });
    }
  } catch (err) {
    await recordWebhookFailure({ topic, shop, error: err });
    throw err;
  }

  return new Response(null, { status: 200 });
};
