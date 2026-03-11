import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete all shop data when a merchant requests data deletion (48 hours after uninstall).
  // Finding deletion cascades from Scan deletion via Prisma onDelete: Cascade.
  await db.scan.deleteMany({ where: { shop: { domain: shop } } });
  await db.shop.deleteMany({ where: { domain: shop } });
  await db.session.deleteMany({ where: { shop } });

  return new Response(null, { status: 200 });
};
