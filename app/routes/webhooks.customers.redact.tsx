import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Ghost Code does not store customer PII — only shop-level scan data about themes.
  // Nothing to redact; acknowledge receipt with 200 OK.
  return new Response(null, { status: 200 });
};
