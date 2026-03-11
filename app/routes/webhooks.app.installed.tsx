import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { upsertShop } from "../models/shop.server";
import { createScan } from "../models/scan.server";
import { inngest } from "../../inngest/client";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Look up the offline access token that the Shopify SDK stored during OAuth.
  // The Session table is managed by PrismaSessionStorage; offline sessions use
  // the shop domain as part of their ID ("offline_<shop>").
  const session = await db.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session) {
    console.error(
      `app/installed: no offline session found for ${shop} — cannot create shop record`,
    );
    // Return 200 so Shopify doesn't retry. The shop record will be created on
    // next authenticate.admin() call from the merchant.
    return new Response(null, { status: 200 });
  }

  // Fetch the main (active) theme and kick off the auto-scan.
  // Wrapped in try/catch because unauthenticated.admin() or admin.graphql()
  // can fail if the offline session token isn't ready yet. Auto-scan is
  // best-effort — the merchant can trigger one manually from the dashboard.
  try {
    const { admin } = await unauthenticated.admin(shop);

    const response = await admin.graphql(
      `{
        themes(first: 1, roles: MAIN) {
          nodes {
            id
            name
          }
        }
      }`,
    );

    const data = await response.json();
    const mainTheme = data?.data?.themes?.nodes?.[0];

    if (!mainTheme) {
      // No main theme found — create the shop record anyway so the merchant
      // can trigger scans manually from the dashboard.
      console.error(
        `app/installed: no main theme found for ${shop}, skipping auto-scan`,
      );
      await upsertShop(shop, session.accessToken);
      return new Response(null, { status: 200 });
    }

    // Create or update the shop row. On re-install the access token may have
    // rotated, so upsertShop updates it in place.
    const shopRecord = await upsertShop(shop, session.accessToken);

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
    console.warn(
      `app/installed: failed to fetch theme or create auto-scan for ${shop} — merchant can scan manually`,
      err,
    );
  }

  return new Response(null, { status: 200 });
};
