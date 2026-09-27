import type { ActionFunctionArgs } from "react-router";

import db from "../db.server";
import { logger } from "../lib/logger.server";
import { authenticateWebhookTolerant } from "../lib/webhook-auth.server";
import { recordWebhookFailure } from "../models/ops-event.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticateWebhookTolerant(request);

  logger.info("Webhook received", { topic, shop });

  try {
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
  } catch (err) {
    await recordWebhookFailure({ topic, shop, error: err });
    throw err;
  }

  return new Response(null, { status: 200 });
};
