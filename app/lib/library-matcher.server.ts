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
 * Which public-CDN host a URL resolved to. Kept so callers (isBenignLibrary) can
 * restrict which hosts they act on without re-parsing.
 */
type CdnHost = "jsdelivr" | "unpkg" | "cdnjs";

/**
 * Parsed name + raw version string extracted from a public-CDN library URL.
 * `version` is the raw version segment as it appears in the URL (e.g. "11",
 * "17.8.3", "v3.6.0"); major-version extraction is done by parseLibrary.
 */
type ParsedCdnLibrary = { name: string; version: string; host: CdnHost };

/**
 * Parse a leading `<name>@<version>` out of a path remainder such as
 * `swiper@11/swiper-bundle.min.js` or (scoped) `@scope/pkg@1.2.3/dist/x.js`.
 *
 * The `@` that separates name from version is the LAST-relevant boundary: for a
 * scoped package the leading `@` is part of the name, so the search for the
 * version `@` starts one character in. Returns null when there is no version
 * boundary (e.g. `swiper/dist.js`) so unversioned URLs are never treated as a
 * recognized library.
 */
function parsePackageAtVersion(rest: string): { name: string; version: string } | null {
  const searchStart = rest.startsWith("@") ? 1 : 0;
  const at = rest.indexOf("@", searchStart);
  if (at === -1) return null;

  const name = rest.slice(0, at);
  const afterAt = rest.slice(at + 1);
  const slash = afterAt.indexOf("/");
  const version = slash === -1 ? afterAt : afterAt.slice(0, slash);

  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

/**
 * Extract the library name + raw version from a public-CDN URL, or null for
 * non-CDN / unparseable / unversioned URLs. Single source of truth for CDN path
 * parsing, shared by isBenignLibrary (suppression) and parseLibrary (duplicate
 * detection) so the per-CDN path shapes are not encoded twice.
 *
 * Supported hosts and path shapes:
 *   - jsdelivr (cdn.jsdelivr.net): /npm/<name>@<version>/...
 *   - unpkg    (unpkg.com):        /<name>@<version>/...
 *   - cdnjs    (cdnjs.cloudflare.com): /ajax/libs/<name>/<version>/...
 */
function parseCdnLibrary(url: string): ParsedCdnLibrary | null {
  // Mirror hostnameFromUrl's protocol-relative normalization so `//host/path`
  // URLs parse correctly.
  const normalized = url.startsWith("//") ? `https:${url}` : url;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  const { hostname, pathname } = parsed;

  if (hostname === "cdn.jsdelivr.net") {
    if (!pathname.startsWith("/npm/")) return null;
    const nv = parsePackageAtVersion(pathname.slice("/npm/".length));
    return nv && { ...nv, host: "jsdelivr" };
  }

  if (hostname === "unpkg.com") {
    const nv = parsePackageAtVersion(pathname.startsWith("/") ? pathname.slice(1) : pathname);
    return nv && { ...nv, host: "unpkg" };
  }

  if (hostname === "cdnjs.cloudflare.com") {
    const prefix = "/ajax/libs/";
    if (!pathname.startsWith(prefix)) return null;
    const segs = pathname.slice(prefix.length).split("/");
    const [name, version] = segs;
    if (!name || !version) return null;
    return { name, version, host: "cdnjs" };
  }

  return null;
}

/**
 * Extract the library name + MAJOR version from a public-CDN URL, or null for
 * non-CDN / unparseable / unversioned URLs (or a version string with no leading
 * digit, e.g. `@latest`). The major is the first integer run in the version
 * segment, so `11.0.5` -> 11 and `v3.6.0` -> 3. The `/\d+/` match carries no
 * `/g` flag, so parseLibrary is a pure function of its input.
 *
 * Used by the cross-file duplicate-library detector to spot the SAME library
 * loaded at two or more distinct majors across a theme.
 */
export function parseLibrary(url: string): { name: string; major: number } | null {
  const lib = parseCdnLibrary(url);
  if (lib === null) return null;

  const digits = lib.version.match(/\d+/);
  if (digits === null) return null;

  const major = Number(digits[0]);
  if (!Number.isFinite(major)) return null;

  return { name: lib.name, major };
}

/**
 * Returns true if the external resource URL is a recognized benign public-CDN
 * library or web font that should be dropped rather than emitted as an unknown
 * external resource. Returns false for malformed URLs and anything unrecognized
 * (fail toward emitting, never toward silent suppression).
 *
 * Suppression stays scoped to the seed package list on the two shared package
 * CDNs it has always covered (jsdelivr, unpkg) plus the single-purpose font
 * hosts. cdnjs is parseable for duplicate detection but is intentionally NOT a
 * suppression source here (it was never one). Name matching is exact against
 * KNOWN_LIBRARY_PACKAGES, which is the version-boundary check the previous
 * `/npm/<pkg>@` prefix encoded — `swiper` matches, `swiperevil` does not.
 */
export function isBenignLibrary(url: string): boolean {
  const normalized = url.startsWith("//") ? `https:${url}` : url;
  let hostname: string;
  try {
    hostname = new URL(normalized).hostname;
  } catch {
    return false;
  }

  if (FONT_HOSTS.has(hostname)) return true;

  const lib = parseCdnLibrary(url);
  if (lib === null || lib.host === "cdnjs") return false;
  return KNOWN_LIBRARY_PACKAGES.includes(lib.name);
}
