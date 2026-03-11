import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../models/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Hard-delete all shop data 48 hours after uninstall (GDPR shop/redact).
  // deleteShopData handles sessions, scans (cascade-deletes findings), and shop
  // in a single transaction. Returns null if already deleted (idempotent).
  const deleted = await deleteShopData(shop);
  if (!deleted) {
    console.warn(`shop/redact: shop ${shop} not found in DB, nothing to delete`);
  }

  return new Response(null, { status: 200 });
};
