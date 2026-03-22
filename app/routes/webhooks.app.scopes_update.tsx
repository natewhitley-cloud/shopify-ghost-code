import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { logger } from "../lib/logger.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  logger.info("Webhook received", { topic, shop });

  const current = Array.isArray(payload?.current) ? (payload.current as string[]) : [];
  if (session && current.length > 0) {
    const oldScopes = session.scope ?? "";
    const newScopes = current.toString();

    logger.info("Scope update", {
      shop,
      oldScopes,
      newScopes,
      sessionId: session.id,
    });

    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: newScopes,
      },
    });
  }

  return new Response(null, { status: 200 });
};
