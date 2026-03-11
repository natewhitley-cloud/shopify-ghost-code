import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Delete all Ghost Code data for this shop.
  // Finding deletion cascades from Scan deletion via Prisma onDelete: Cascade,
  // so only scan + shop rows need to be explicitly deleted here.
  // deleteMany is a no-op when no rows match — safe for repeated delivery.
  await db.scan.deleteMany({ where: { shop: { domain: shop } } });
  await db.shop.deleteMany({ where: { domain: shop } });

  return new Response();
};
