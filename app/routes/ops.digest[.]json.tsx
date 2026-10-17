import type { LoaderFunctionArgs } from "react-router";

import { buildNodDigest } from "../../inngest/lib/nod-digest";
import { logger } from "../lib/logger.server";
import { timingSafeTokenMatch } from "../lib/token-compare.server";

/**
 * GET /ops/digest.json: NOD (Nate's Ops Dashboard) digest, contract v1.
 *
 * Token-gated by NOD_OPS_SECRET, a dedicated READ-ONLY secret (not the health
 * token). Fails closed and looks absent: secret unset or < 32 chars, a missing
 * header or a wrong secret all return a bare 404. READ-ONLY and DB-ONLY: the
 * payload comes from inngest/lib/nod-digest.ts, which never writes.
 */

const MIN_SECRET_LENGTH = 32;

const notFound = () => new Response(null, { status: 404 });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.NOD_OPS_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return notFound();
  if (!timingSafeTokenMatch(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return notFound();
  }

  try {
    const digest = await buildNodDigest();
    return Response.json(digest, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("nod-digest-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
};

// Non-GET methods look absent too (no action would otherwise yield a 405).
export const action = async () => notFound();
