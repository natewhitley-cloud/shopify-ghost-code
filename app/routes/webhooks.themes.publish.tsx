import { ScanOrigin } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";

import { logger } from "../lib/logger.server";
import { canUseAutoRescan } from "../lib/plan-gating.server";
import { recordWebhookFailure } from "../models/ops-event.server";
import { getShopMetadata, updateThemePublishTimestamp } from "../models/shop.server";
import { dispatchScan } from "../services/scan-dispatch.server";
import { fetchMainTheme } from "../services/theme-fetcher.server";
import { authenticate, unauthenticated } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  try {
    const shopRecord = await getShopMetadata(shop);

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

    // Fetch the current MAIN theme via GraphQL instead of relying on the webhook
    // payload.id. The webhook fires for the theme being published, but the payload
    // ID may not be immediately queryable via the theme files API (e.g. theme store
    // themes with delayed asset availability). Querying MAIN guarantees we get the
    // theme Shopify considers active and whose files are accessible.
    const { admin } = await unauthenticated.admin(shop);
    const mainTheme = await fetchMainTheme(admin);

    if (!mainTheme) {
      logger.warn("themes/publish webhook — no MAIN theme found via API, skipping auto-rescan", {
        shop,
        webhookThemeId: payload.id,
      });
      return new Response(null, { status: 200 });
    }

    const themeId = mainTheme.id;
    const themeName = mainTheme.name;

    try {
      // dispatchScan creates the scan record and fires scan/requested. A createScan
      // failure (active scan, quota exceeded) is propagated here; inngest.send
      // failures are logged inside dispatchScan (best-effort) and do NOT reach
      // this catch, preventing Shopify retry storms caused by transient send errors.
      // AUTO_PUBLISH origin: this auto-rescan is exempt from the manual weekly
      // quota (GC-iji) so it never blocks the merchant's own manual scan.
      await dispatchScan(shopRecord.id, themeId, themeName, { origin: ScanOrigin.AUTO_PUBLISH });
    } catch (err) {
      // createScan threw — scan already in progress or quota exceeded.
      // Log and return 200 to prevent Shopify retry storms.
      logger.warn("Auto-rescan skipped — scan already in progress or creation failed", {
        shop,
        webhook: "themes/publish",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    await recordWebhookFailure({ topic, shop, error: err });
    throw err;
  }

  return new Response(null, { status: 200 });
};
