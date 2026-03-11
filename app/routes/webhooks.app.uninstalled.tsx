import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete all Ghost Code data for this shop atomically.
  // deleteShopData handles sessions, scans (cascade-deletes findings), and shop
  // in a single transaction. Returns null if the shop is already gone (idempotent).
  const deleted = await deleteShopData(shop);
  if (!deleted) {
    console.warn(`app/uninstalled: shop ${shop} not found in DB, nothing to delete`);
  }

  return new Response(null, { status: 200 });
};
