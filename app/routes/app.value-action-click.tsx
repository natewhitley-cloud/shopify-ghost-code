/**
 * Resource route: POST /app/value-action-click (gc-np1d.5).
 *
 * Best-effort click ping for value actions whose button navigates by itself:
 * the Clean copy card, Standard's "do it yourself", and the clean copy result
 * page's Preview. The page fires a keepalive fetch POST with `src=<key>` (see
 * recordValueActionClick); App Bridge's patched fetch adds the session token.
 *
 * Records `clicked` once per merchant only for an allow-listed key, always for
 * the SESSION shop, and returns 204. The stage rules require the card to have
 * been shown first where it has a shown stage. No loader, no redirect.
 */
import type { ActionFunctionArgs } from "react-router";

import { isValueActionPingKey } from "../lib/value-action";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const src = (await request.formData()).get("src");
  if (isValueActionPingKey(src)) {
    await recordNudgeStageOnce(src, "clicked", session.shop);
  }
  return new Response(null, { status: 204 });
};
