/**
 * Resource route: /app/upgrade?src=upgrade_preview (gc-97k.4)
 *
 * The free-tier upgrade teaser's CTA. Records the nudge click (once per
 * merchant) when `src=upgrade_preview`, then sends the merchant to the Shopify
 * Managed Pricing plan page, the same URL the Settings upgrade buttons open
 * (buildPricingPlansUrl) with the same `_top` target.
 *
 * The redirect must be TOP-LEVEL: the app runs inside the admin iframe and the
 * admin cannot be framed. The admin `redirect` helper from authenticate.admin
 * handles that for every request shape: a client-side navigation (.data fetch
 * carrying the session token) gets a 401 with the reauthorize-URL header that
 * App Bridge follows at the top level, and an embedded document load gets an
 * App Bridge page that opens the URL in `_top`. A bare react-router redirect
 * would try to load the admin inside the iframe.
 *
 * No UI component: this route only exports a loader.
 */
import type { LoaderFunctionArgs } from "react-router";

import { buildPricingPlansUrl } from "../lib/billing.server";
import { NUDGE_KEYS } from "../services/nudge-telemetry.server";
import { recordUpgradePreviewStageOnce } from "../services/upgrade-preview-nudge.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);

  const src = new URL(request.url).searchParams.get("src");
  if (src === NUDGE_KEYS.UPGRADE_PREVIEW) {
    await recordUpgradePreviewStageOnce("clicked", session.shop);
  }

  return redirect(buildPricingPlansUrl(session.shop), { target: "_top" });
};
