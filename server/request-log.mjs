/**
 * Request-log format for server.mjs (gc-t7o2, ported from FraudPilot ft-g8t).
 * Same fields as morgan "tiny" (method, path, status, length, response time),
 * but the URL is logged WITHOUT its query string: Shopify's embedded loads
 * carry `id_token` (JWT), `hmac` and `session` there, and react-router-serve's
 * "tiny" wrote them to the host logs on every request. The alert-unsubscribe
 * token rides in the PATH (/unsubscribe/<token>), so that segment is masked
 * too.
 */

const UNSUBSCRIBE_TOKEN_PATH = /^\/unsubscribe\/[^/]+/;

/** The request path with any query string removed and the unsubscribe token masked. */
export function pathOnly(url) {
  if (typeof url !== "string") return "-";
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  return path.replace(UNSUBSCRIBE_TOKEN_PATH, "/unsubscribe/[REDACTED]");
}

/** morgan format: "tiny" with :path in place of :url. */
export const REQUEST_LOG_FORMAT = ":method :path :status :res[content-length] - :response-time ms";

/** Register the :path token on a morgan instance (idempotent). */
export function registerPathToken(morgan) {
  morgan.token("path", (req) => pathOnly(req.originalUrl || req.url));
}
