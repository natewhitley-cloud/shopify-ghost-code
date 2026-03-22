import type { ActionFunctionArgs } from "react-router";

import { inngest } from "../../inngest/client";
import { logger } from "../lib/logger.server";
import { canUseAutoRescan } from "../lib/plan-gating.server";
import { createScan } from "../models/scan.server";
import { getShopByDomain, updateThemePublishTimestamp } from "../models/shop.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  const shopRecord = await getShopByDomain(shop);

  if (!shopRecord) {
    // Shop not in our DB — no action needed. Return 200 to avoid retries.
    logger.warn("Shop not found in DB — skipping auto-rescan", {
      shop,
      webhook: "themes/publish",
    });
    return new Response(null, { status: 200 });
  }

  // Always record the publish timestamp so the dashboard can surface a nudge
  // banner (for non-Pro shops). For Pro shops, this also stays up-to-date even
  // though they get auto-rescan instead of a nudge.
  await updateThemePublishTimestamp(shop);

  // Auto-rescan is a Professional-plan feature. Free and Standard shops get
  // the webhook but we only record the timestamp (done above) and return 200.
  if (!canUseAutoRescan(shopRecord.plan)) {
    logger.info("Theme published — timestamp recorded, auto-rescan skipped (non-Pro plan)", {
      shop,
      plan: shopRecord.plan,
    });
    return new Response(null, { status: 200 });
  }

  // Validate payload.id before constructing the theme GID.
  // If missing or invalid, log a warning and return 200 (webhooks must always
  // return 200 to prevent Shopify retry storms).
  if (!payload.id || (typeof payload.id !== "number" && typeof payload.id !== "string")) {
    logger.warn("themes/publish webhook missing or invalid payload.id — skipping", {
      shop,
      payloadId: payload.id,
    });
    return new Response(null, { status: 200 });
  }

  const themeId = `gid://shopify/Theme/${payload.id}`;
  const themeName = String(payload.name ?? "");

  try {
    const scan = await createScan(shopRecord.id, themeId, themeName);

    await inngest.send({
      name: "scan/requested",
      data: {
        shopId: shopRecord.id,
        themeId,
        scanId: scan.id,
      },
    });
  } catch (err) {
    // createScan throws if a scan is already in progress (TOCTOU guard).
    // Log and return 200 to prevent Shopify retry storms.
    logger.warn("Auto-rescan skipped — scan already in progress or creation failed", {
      shop,
      webhook: "themes/publish",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response(null, { status: 200 });
};
