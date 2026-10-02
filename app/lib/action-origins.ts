/**
 * Hosts whose `Origin` react-router's action CSRF check accepts besides the
 * request's own origin. Single source of truth for react-router.config.ts
 * (baked into the build) and entry.server.tsx (recognizing .data rejections).
 * RR also supports `*` / `**` globs here; we only use a bare host, so
 * entry.server's exact-host match is sufficient.
 */
export const ALLOWED_ACTION_ORIGINS = ["app.alpenglowsoftware.com"];

/**
 * True when react-router's throwIfPotentialCSRFAttack would reject this request.
 * Mirrors RR 7.18 (lib/actions.ts): `Origin: null` and unparseable values are
 * rejected, an absent/empty Origin is allowed, a parsed Origin is allowed when
 * it equals request.url's origin or its host is allowlisted.
 *
 * Needed because single-fetch (`.data`) POSTs swallow RR's CSRF error and pass
 * a generic `Error("Bad Request")` to handleError, so the message alone cannot
 * identify a CSRF rejection there. The integration test in
 * tests/entry.server.csrf.integration.test.ts fails if RR changes this path.
 */
export function isCsrfOriginRejected(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const header = request.headers.get("origin");
  if (!header) return false;
  let originUrl: URL | null = null;
  let originDomain = header;
  if (header !== "null") {
    try {
      originUrl = new URL(header);
      originDomain = originUrl.host;
    } catch {
      return true;
    }
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  const matchesRequest = originUrl
    ? originUrl.origin === requestUrl.origin
    : originDomain === requestUrl.host;
  if (matchesRequest) return false;
  return !ALLOWED_ACTION_ORIGINS.includes(originDomain);
}
