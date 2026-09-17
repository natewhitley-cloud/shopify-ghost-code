/**
 * App identification helpers.
 *
 * Given a URL, code snippet, or Liquid snippet name, try to identify which
 * known third-party app it belongs to.  All lookups are O(n) scans over the
 * APP_SIGNATURES array — acceptable because the list is small and these
 * functions are called offline during a scan (not in a hot request path).
 *
 * Returns the matched appName string or null when no match is found.
 */

import { APP_SIGNATURES, type AppSignature } from "../data/app-signatures.server";
import { hostnameFromUrl } from "../lib/url.server";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `hostname` matches or is a subdomain of any domain in
 * `cdnDomains`.  This avoids partial substring collisions like
 * "notaklaviyo.com" matching "klaviyo.com".
 */
function domainMatches(hostname: string, cdnDomains: AppSignature["cdnDomains"]): boolean {
  for (const domain of cdnDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Identify an app from a script or stylesheet URL.
 *
 * First checks the URL's hostname against cdnDomains, then falls back to
 * checking scriptPatterns against the full URL string.
 */
export function identifyAppFromUrl(url: string): string | null {
  const hostname = hostnameFromUrl(url);

  for (const sig of APP_SIGNATURES) {
    if (hostname !== null && domainMatches(hostname, sig.cdnDomains)) {
      return sig.appName;
    }
    // Fall back to full-URL pattern matching (handles paths / query strings)
    for (const pattern of sig.scriptPatterns) {
      if (pattern.test(url)) {
        return sig.appName;
      }
    }
  }

  return null;
}

/**
 * Identify an app from a code snippet (inline JS or CSS text).
 *
 * Checks scriptPatterns first, then cssPatterns.  Returns on the first match.
 */
export function identifyAppFromCode(code: string): string | null {
  for (const sig of APP_SIGNATURES) {
    for (const pattern of sig.scriptPatterns) {
      if (pattern.test(code)) {
        return sig.appName;
      }
    }
    for (const pattern of sig.cssPatterns) {
      if (pattern.test(code)) {
        return sig.appName;
      }
    }
  }
  return null;
}

/**
 * Identify an app from an hreflang tag's href URL.
 *
 * Checks each signature's hrefLangPatterns array against the full href string.
 * Returns the first matching appName or null.
 */
export function identifyAppFromHrefLang(href: string): string | null {
  for (const sig of APP_SIGNATURES) {
    if (!sig.hrefLangPatterns) continue;
    for (const pattern of sig.hrefLangPatterns) {
      if (pattern.test(href)) {
        return sig.appName;
      }
    }
  }
  return null;
}

/**
 * Identify an app from JSON-LD schema markup content.
 *
 * Checks each signature's jsonLdPatterns array against the full JSON-LD block
 * content. Returns the first matching appName or null.
 */
export function identifyAppFromJsonLd(content: string): string | null {
  for (const sig of APP_SIGNATURES) {
    if (!sig.jsonLdPatterns) continue;
    for (const pattern of sig.jsonLdPatterns) {
      if (pattern.test(content)) {
        return sig.appName;
      }
    }
  }
  return null;
}

/**
 * Identify an app from a text fragment (class name, data attribute, or widget
 * placeholder text left in Liquid markup by an uninstalled app).
 *
 * Checks each signature's textPatterns array against the provided text.
 * Returns the first matching appName or null.
 */
export function identifyAppFromTextFragment(text: string): string | null {
  for (const sig of APP_SIGNATURES) {
    if (!sig.textPatterns) continue;
    for (const pattern of sig.textPatterns) {
      if (pattern.test(text)) {
        return sig.appName;
      }
    }
  }
  return null;
}

/**
 * Identify an app from a Liquid snippet or section name (case-insensitive).
 *
 * Checks each signature's snippetNames list for an exact match.
 */
export function identifyAppFromSnippetName(snippetName: string): string | null {
  const lower = snippetName.toLowerCase();
  for (const sig of APP_SIGNATURES) {
    for (const name of sig.snippetNames) {
      if (name.toLowerCase() === lower) {
        return sig.appName;
      }
    }
  }
  return null;
}

/**
 * Identify an app from a theme file path (e.g. `snippets/spreadr-custom.liquid`).
 *
 * Checks each signature's filePatterns array against the full file path. The
 * filename identifies the app that OWNS the file — the app whose uninstall
 * orphaned it. Returns the full AppSignature (not just the name) so callers can
 * read `isTracker`. Returns null when no signature has a matching filePattern.
 */
export function identifyAppFromFilename(filename: string): AppSignature | null {
  for (const sig of APP_SIGNATURES) {
    if (!sig.filePatterns) continue;
    for (const pattern of sig.filePatterns) {
      if (pattern.test(filename)) {
        return sig;
      }
    }
  }
  return null;
}

/**
 * Check whether a given app name corresponds to a known tracking/analytics app.
 * Used to add privacy callouts on findings from tracker scripts.
 */
export function isTrackerApp(appName: string): boolean {
  return APP_SIGNATURES.some((sig) => sig.appName === appName && sig.isTracker === true);
}

/**
 * Resolve the final attribution for a finding by reconciling the content-derived
 * app (inline tracker call, script URL, snippet name) with the app that OWNS the
 * file the code lives in.
 *
 * Precedence (spec 4.3): the file-owner app wins over the content-derived app
 * ONLY when the content-derived app is a generic tracker (`isTracker`) or null.
 * A specific NON-tracker content match (e.g. a Judge.me widget nested inside an
 * EComposer section file) is a genuine second app's code and keeps its own,
 * more-precise attribution. A file-owner that is itself a tracker never
 * overrides (it is not a stronger signal than the content tracker).
 *
 * @param contentApp The app name derived from the code's content, or null.
 * @param filename   The theme file path the finding lives in.
 * @param opts.contentIsTracker Override for whether the content is a tracker.
 *   Detectors whose every match is a tracker by construction (detectGhostPixels)
 *   pass `true` directly; others let it derive from isTrackerApp(contentApp).
 * @returns The resolved appName and, when the file-owner overrode a tracker, the
 *   overridden tracker's app name (for description enrichment); otherwise null.
 */
export function resolveAttribution(
  contentApp: string | null,
  filename: string,
  opts?: { contentIsTracker?: boolean },
): { appName: string | null; overriddenTracker: string | null } {
  const fileSig = identifyAppFromFilename(filename);
  const contentIsTracker =
    opts?.contentIsTracker ?? (contentApp !== null && isTrackerApp(contentApp));

  if (fileSig && fileSig.isTracker !== true && (contentApp === null || contentIsTracker)) {
    return { appName: fileSig.appName, overriddenTracker: contentApp };
  }

  return { appName: contentApp, overriddenTracker: null };
}
