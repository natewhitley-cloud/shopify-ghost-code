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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the hostname from a URL string without throwing on malformed input.
 * Returns null if the URL cannot be parsed.
 */
function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

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
  const hostname = safeHostname(url);

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
