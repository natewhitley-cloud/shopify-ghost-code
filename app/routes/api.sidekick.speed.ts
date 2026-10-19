/**
 * Resource route: GET /api/sidekick/speed
 *
 * Backend for the Sidekick tool `get_speed_summary`
 * (extensions/sidekick-tools). Shopify's sandbox calls it with the merchant's
 * session token; the shop comes from that token, never from the request.
 * Read-only. Logic and plan gating (the Store speed page's own) live in
 * app/services/sidekick-speed-summary.server.ts.
 */
import type { LoaderFunctionArgs } from "react-router";

import { respondWithSidekickSummary } from "../services/sidekick-route.server";
import { getSidekickSpeedSummary } from "../services/sidekick-speed-summary.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  return respondWithSidekickSummary(cors, "sidekick_speed_failed", session.shop, () =>
    getSidekickSpeedSummary(session.shop),
  );
};
