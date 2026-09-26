/**
 * Resource route: POST /app/upgrade (gc-97k.4, reworked in the gc-97k review;
 * gc-97k.9 added the return-visit banner as a second source)
 *
 * Best-effort click ping for the Free upgrade asks. Their CTA is a plain
 * `<a href={pricingPlansUrl} target="_top">` (the same proven pattern as the
 * Settings upgrade buttons), so navigation never depends on this route. On
 * click the page fires a keepalive `fetch` POST here with `src=<ask>`; App
 * Bridge's patched global `fetch` adds the session token, so
 * authenticate.admin works as for any other in-app fetch.
 *
 * Records that nudge's `clicked` once per merchant only for a known `src`
 * (UPGRADE_ASK_KEYS: upgrade_preview, upgrade_return), always for the
 * SESSION shop (never a shop from the request body), and returns 204.
 * No loader and no redirect: nothing here can be pointed at another URL.
 */
import type { ActionFunctionArgs } from "react-router";

import { isUpgradeAskKey } from "../lib/upgrade-preview";
import { recordNudgeStageOnce } from "../services/nudge-stage.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const src = formData.get("src");
  if (isUpgradeAskKey(src)) {
    await recordNudgeStageOnce(src, "clicked", session.shop);
  }

  return new Response(null, { status: 204 });
};
