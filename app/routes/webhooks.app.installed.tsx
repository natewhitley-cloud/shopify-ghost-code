import type { ActionFunctionArgs } from "react-router";

import { inngest } from "../../inngest/client";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { createScan } from "../models/scan.server";
import { upsertShop } from "../models/shop.server";
import { authenticate, unauthenticated } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  // Look up the offline access token that the Shopify SDK stored during OAuth.
  // The Session table is managed by PrismaSessionStorage; offline sessions use
  // the shop domain as part of their ID ("offline_<shop>").
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session) {
    logger.error("No offline session found — cannot create shop record", {
      shop,
      webhook: "app/installed",
    });
    // Return 200 so Shopify doesn't retry. The shop record will be created on
    // next authenticate.admin() call from the merchant.
    return new Response(null, { status: 200 });
  }

  // Always create/update the shop record first — even if auto-scan fails,
  // the merchant needs a shop row to use the dashboard.
  // Re-read the latest session to get the freshest access token (token
  // rotation is enabled via expiringOfflineAccessTokens).
  const freshSession = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });
  const shopRecord = await upsertShop(shop, (freshSession ?? session).accessToken);

  // Fetch the main (active) theme and kick off the auto-scan.
  // Wrapped in try/catch because unauthenticated.admin() or admin.graphql()
  // can fail if the offline session token isn't ready yet. Auto-scan is
  // best-effort — the merchant can trigger one manually from the dashboard.
  try {
    const { admin } = await unauthenticated.admin(shop);

    const { fetchMainTheme } = await import("../services/theme-fetcher.server");
    const mainTheme = await fetchMainTheme(admin);

    if (!mainTheme) {
      logger.warn("No main theme found — skipping auto-scan", {
        shop,
        webhook: "app/installed",
      });
      return new Response(null, { status: 200 });
    }

    const scan = await createScan(shopRecord.id, mainTheme.id, mainTheme.name);

    await inngest.send({
      name: "scan/requested",
      data: {
        shopId: shopRecord.id,
        themeId: mainTheme.id,
        scanId: scan.id,
      },
    });
  } catch (err) {
    logger.warn("Failed to fetch theme or create auto-scan — merchant can scan manually", {
      shop,
      webhook: "app/installed",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return new Response(null, { status: 200 });
};
