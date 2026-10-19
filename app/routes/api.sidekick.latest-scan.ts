/**
 * Resource route: GET /api/sidekick/latest-scan
 *
 * Backend for the Sidekick tool `get_latest_scan_summary`
 * (extensions/sidekick-tools). Shopify's sandbox calls it with the merchant's
 * session token; the shop comes from that token, never from the request.
 * Read-only. Logic and plan gating live in
 * app/services/sidekick-scan-summary.server.ts.
 */
import type { LoaderFunctionArgs } from "react-router";

import { respondWithSidekickSummary } from "../services/sidekick-route.server";
import { getSidekickScanSummary } from "../services/sidekick-scan-summary.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, cors } = await authenticate.admin(request);
  return respondWithSidekickSummary(cors, "sidekick_latest_scan_failed", session.shop, () =>
    getSidekickScanSummary(admin, session.shop),
  );
};
