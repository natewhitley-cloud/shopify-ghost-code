/**
 * Merge override params into a copy of the current search params and return the
 * query string. Used for embedded-app navigation: an internal <Link> that sets
 * its own query (e.g. ?lane=) MUST preserve the existing params (host, embedded,
 * id_token, shop) or App Bridge drops the embedded context and authenticate.admin
 * bounces the merchant to /auth/login. Merging (not replacing) keeps host present.
 */
export function mergeSearchParams(
  current: URLSearchParams,
  overrides: Record<string, string>,
): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(overrides)) {
    next.set(key, value);
  }
  return next.toString();
}
