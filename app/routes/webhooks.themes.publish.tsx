import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain, updateThemePublishTimestamp } from "../models/shop.server";
import { createScan } from "../models/scan.server";
import { canUseAutoRescan } from "../lib/plan-gating.server";
import { inngest } from "../../inngest/client";
import { logger } from "../lib/logger.server";

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

  const themeId = `gid://shopify/Theme/${payload.id}`;
  const themeName = String(payload.name ?? "");

  const scan = await createScan(shopRecord.id, themeId, themeName);

  await inngest.send({
    name: "scan/requested",
    data: {
      shopId: shopRecord.id,
      themeId,
      scanId: scan.id,
    },
  });

  return new Response(null, { status: 200 });
};
