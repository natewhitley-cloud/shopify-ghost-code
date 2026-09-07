/**
 * Library recognition for the unknown-external-resource collectors.
 *
 * Purpose: benign public-CDN JS libraries and web fonts should not be written
 * as UnknownScript / unknown-stylesheet rows. When an external resource is
 * recognized here, the collector drops it at collection time (re-scan
 * self-heals; no migration needed).
 *
 * FP-safety:
 *   - Shared multi-package CDNs (jsdelivr, unpkg) serve ARBITRARY code, so
 *     host-only allowlisting is unsafe. We match on the package PATH prefix
 *     (`/npm/<pkg>@` on jsdelivr, `/<pkg>@` on unpkg) for a tight, documented
 *     seed list of well-known libraries only. The trailing `@` is the version
 *     boundary — it stops `swiper` from matching a lookalike like `swiperevil`.
 *   - Host-only allowlisting is used ONLY for single-purpose web-font hosts
 *     (Google Fonts), which serve nothing but fonts / font stylesheets.
 *
 * No regex is used (plain string prefix checks via `startsWith`), so there is
 * no `/g`-flag `lastIndex` hazard: `isBenignLibrary` is a pure function of its
 * input and returns the same result on repeated calls.
 */

/**
 * Single-purpose font hosts. Everything served from these origins is a font or
 * a font stylesheet, so host-only recognition is FP-safe here. (Verified none
 * of these hosts appear in APP_SIGNATURES cdnDomains, so they cannot shadow a
 * real app detector.)
 */
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/**
 * Seed list of well-known, benign JS libraries recognized on shared package
 * CDNs. Kept deliberately tight: the three "weekend-scan" libraries that
 * triggered this work (swiper, vanilla-lazyload, simple-parallax-js) plus two
 * ubiquitous, low-ambiguity utilities (lodash, alpinejs). These are npm package
 * names — the exact path segment used by both jsdelivr (`/npm/<pkg>@`) and
 * unpkg (`/<pkg>@`). Add to this list only when a library is (a) demonstrably
 * benign and (b) unambiguously named on npm.
 */
const KNOWN_LIBRARY_PACKAGES = [
  "swiper",
  "vanilla-lazyload",
  "simple-parallax-js",
  "lodash",
  "alpinejs",
];

/**
 * Returns true if the external resource URL is a recognized benign public-CDN
 * library or web font that should be dropped rather than emitted as an unknown
 * external resource. Returns false for malformed URLs and anything unrecognized
 * (fail toward emitting, never toward silent suppression).
 */
export function isBenignLibrary(url: string): boolean {
  // Mirror hostnameFromUrl's protocol-relative normalization so `//host/path`
  // URLs parse correctly.
  const normalized = url.startsWith("//") ? `https:${url}` : url;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }
  const { hostname, pathname } = parsed;

  if (FONT_HOSTS.has(hostname)) return true;

  if (hostname === "cdn.jsdelivr.net") {
    return KNOWN_LIBRARY_PACKAGES.some((pkg) => pathname.startsWith(`/npm/${pkg}@`));
  }

  if (hostname === "unpkg.com") {
    return KNOWN_LIBRARY_PACKAGES.some((pkg) => pathname.startsWith(`/${pkg}@`));
  }

  return false;
}
