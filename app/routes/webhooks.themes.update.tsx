import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { createScan } from "../models/scan.server";
import { canUseAutoRescan } from "../lib/plan-gating.server";
import { inngest } from "../../inngest/client";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const shopRecord = await getShopByDomain(shop);

  if (!shopRecord) {
    // Shop not in our DB — no action needed. Return 200 to avoid retries.
    console.warn(`themes/update: shop ${shop} not found in DB, skipping`);
    return new Response(null, { status: 200 });
  }

  // Auto-rescan is a Professional-plan feature. Free and Standard shops get
  // the webhook but we silently skip the scan rather than returning an error.
  if (!canUseAutoRescan(shopRecord.plan)) {
    return new Response(null, { status: 200 });
  }

  const themeId = String(payload.id);
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
