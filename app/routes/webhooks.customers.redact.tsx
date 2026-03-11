import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  // Ghost Code does not store customer PII — only shop-level scan data about themes.
  // Nothing to redact; acknowledge receipt with 200 OK.
  return new Response(null, { status: 200 });
};
