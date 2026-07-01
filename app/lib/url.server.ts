/**
 * URL parsing helpers shared across the scanner services.
 */

/**
 * Extract the hostname from a URL string without throwing on malformed input.
 *
 * Protocol-relative URLs (`//host/path`) are normalized by prefixing `https:`
 * so their hostname resolves correctly — otherwise `new URL()` throws because
 * there is no scheme. Returns null for genuinely malformed input.
 */
export function hostnameFromUrl(url: string): string | null {
  try {
    const normalized = url.startsWith("//") ? `https:${url}` : url;
    return new URL(normalized).hostname;
  } catch {
    return null;
  }
}
