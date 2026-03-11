import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Ghost Code does not store customer PII — only shop-level scan data about themes.
  // Acknowledge receipt with 200 OK; nothing to report.
  return new Response(null, { status: 200 });
};
