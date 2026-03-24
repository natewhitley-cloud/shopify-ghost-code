/**
 * Orphaned redirect detection.
 *
 * Detects URL redirect patterns typically created by SEO apps.
 * SEO apps often create bulk redirects with distinctive path patterns.
 */

import { FindingType } from "@prisma/client";

import type { RedirectData } from "./redirect-fetcher.server";
import { classifySeverity } from "./severity-classifier.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Known app redirect path patterns
// ---------------------------------------------------------------------------

const APP_REDIRECT_PATTERNS: Array<{ pattern: RegExp; appName: string }> = [
  { pattern: /\/a\/seo[-_]/i, appName: "Smart SEO" },
  { pattern: /\/apps\/seo/i, appName: "SEO App" },
  { pattern: /\/tools\/seo/i, appName: "SEO App" },
  { pattern: /\/a\/pluginseo/i, appName: "Plug in SEO" },
  { pattern: /\/a\/searchanise/i, appName: "Searchanise" },
  { pattern: /\/a\/boost/i, appName: "Boost Commerce" },
];

// ---------------------------------------------------------------------------
// Bulk pattern threshold
// ---------------------------------------------------------------------------

/**
 * Minimum number of redirects under the same path prefix to be considered
 * a bulk pattern (likely app-generated rather than merchant-created).
 */
const BULK_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect redirects that follow patterns suggesting app-generated redirects.
 *
 * Two detection strategies:
 *
 *   1. Direct app pattern matching — redirects with known app path prefixes
 *      (e.g. `/a/seo-*`, `/a/pluginseo/*`).
 *
 *   2. Bulk pattern detection — large numbers of redirects (50+) under the
 *      same path prefix, suggesting automated bulk creation by an SEO or
 *      URL management app.
 *
 * @param redirects  Array of URL redirect data from the Shopify Admin API.
 * @returns          Findings for orphaned redirects.
 */
export function detectOrphanedRedirects(redirects: RedirectData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  // Strategy 1: Direct app pattern matching
  for (const redirect of redirects) {
    const match = APP_REDIRECT_PATTERNS.find(
      (p) => p.pattern.test(redirect.path) || p.pattern.test(redirect.target),
    );
    if (!match) continue;

    const codeSnippet = `${redirect.path} → ${redirect.target}`;
    const severity = classifySeverity(FindingType.GHOST_REDIRECT, codeSnippet);

    findings.push({
      filename: `redirects/${redirect.id}`,
      lineNumber: 0,
      codeSnippet,
      findingType: FindingType.GHOST_REDIRECT,
      severity,
      appName: match.appName,
      description: `URL redirect from "${redirect.path}" to "${redirect.target}" — likely created by ${match.appName}`,
    });
  }

  // Strategy 2: Detect bulk redirect patterns
  // Group redirects by their first path segment (e.g. /collections, /pages, /blogs)
  const prefixGroups = new Map<string, RedirectData[]>();
  for (const redirect of redirects) {
    const segments = redirect.path.split("/").filter(Boolean);
    const prefix = `/${segments[0] || ""}`;
    if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
    prefixGroups.get(prefix)!.push(redirect);
  }

  for (const [prefix, group] of prefixGroups) {
    // Filter out redirects already matched individually by Strategy 1
    const unmatched = group.filter(
      (r) => !APP_REDIRECT_PATTERNS.some((p) => p.pattern.test(r.path) || p.pattern.test(r.target)),
    );
    if (unmatched.length < BULK_THRESHOLD) continue;

    const samples = unmatched
      .slice(0, 3)
      .map((r) => `  ${r.path} → ${r.target}`)
      .join("\n");
    const codeSnippet = `${unmatched.length} redirects under ${prefix}:\n${samples}`;

    const severity = classifySeverity(FindingType.GHOST_REDIRECT, codeSnippet);

    findings.push({
      filename: `redirects/bulk/${prefix.replace(/\//g, "_")}`,
      lineNumber: 0,
      codeSnippet: codeSnippet.slice(0, 300),
      findingType: FindingType.GHOST_REDIRECT,
      severity,
      appName: undefined,
      description: `${unmatched.length} bulk redirects under "${prefix}" — may be left by an uninstalled SEO or URL management app`,
    });
  }

  return findings;
}
