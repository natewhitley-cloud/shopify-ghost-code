/**
 * Resource route: POST /app/upgrade (gc-97k.4, reworked in the gc-97k review)
 *
 * Best-effort click ping for the free-tier upgrade teaser. The teaser's CTA is
 * a plain `<a href={pricingPlansUrl} target="_top">` (the same proven pattern
 * as the Settings upgrade buttons), so navigation never depends on this route.
 * On click the banner fires a keepalive `fetch` POST here with
 * `src=upgrade_preview`; App Bridge's patched global `fetch` adds the session
 * token, so authenticate.admin works as for any other in-app fetch.
 *
 * Records `clicked` once per merchant only when `src=upgrade_preview`, always
 * for the SESSION shop (never a shop from the request body), and returns 204.
 * No loader and no redirect: nothing here can be pointed at another URL.
 */
import type { ActionFunctionArgs } from "react-router";

import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { recordUpgradePreviewStageOnce } from "../services/upgrade-preview-nudge.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  if (formData.get("src") === NUDGE_KEYS.UPGRADE_PREVIEW) {
    await recordUpgradePreviewStageOnce("clicked", session.shop);
  }

  return new Response(null, { status: 204 });
};
