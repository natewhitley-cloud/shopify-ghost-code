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
 * Per-path-prefix tally of the redirects no app pattern matched (gc-747u):
 * everything bulk detection needs, so a redirect walk split across Inngest
 * steps can carry it between steps instead of the full redirect list. Keys are
 * prefixes ("/collections"); `samples` holds the first 3 sample lines in walk
 * order, each cut to the 300-char snippet limit (nothing past it can show).
 * Plain JSON (a step return value).
 */
export type BulkRedirectGroups = Record<string, { count: number; samples: string[] }>;

const SNIPPET_MAX = 300;
const BULK_SAMPLE_COUNT = 3;

function matchesAppPattern(redirect: RedirectData): { appName: string } | undefined {
  return APP_REDIRECT_PATTERNS.find(
    (p) => p.pattern.test(redirect.path) || p.pattern.test(redirect.target),
  );
}

/**
 * Strategy 1: redirects whose path or target matches a known app prefix
 * (e.g. `/a/seo-*`, `/a/pluginseo/*`). One finding per redirect, so a chunk of
 * a walk can be checked on its own (gc-747u).
 */
export function detectAppPatternRedirects(redirects: RedirectData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  for (const redirect of redirects) {
    const match = matchesAppPattern(redirect);
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
  return findings;
}

/**
 * Add one chunk of a redirect walk to the bulk tally (gc-747u). Groups by the
 * first path segment (e.g. /collections, /pages, /blogs) and skips redirects
 * Strategy 1 already matched. Mutates `groups`; call once per chunk in walk
 * order so the samples are the same first 3 a single pass would pick.
 */
export function addToBulkRedirectGroups(
  groups: BulkRedirectGroups,
  redirects: RedirectData[],
): void {
  for (const redirect of redirects) {
    if (matchesAppPattern(redirect)) continue;
    const segments = redirect.path.split("/").filter(Boolean);
    const prefix = `/${segments[0] || ""}`;
    const group = (groups[prefix] ??= { count: 0, samples: [] });
    group.count += 1;
    if (group.samples.length < BULK_SAMPLE_COUNT) {
      group.samples.push(`  ${redirect.path} → ${redirect.target}`.slice(0, SNIPPET_MAX));
    }
  }
}

/**
 * Strategy 2: a finding per prefix with 50+ unmatched redirects (gc-747u split
 * this out of detectOrphanedRedirects so it can run once, after the last chunk).
 */
export function bulkRedirectFindings(groups: BulkRedirectGroups): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];
  for (const [prefix, group] of Object.entries(groups)) {
    if (group.count < BULK_THRESHOLD) continue;

    const codeSnippet = `${group.count} redirects under ${prefix}:\n${group.samples.join("\n")}`;

    const severity = classifySeverity(FindingType.GHOST_REDIRECT, codeSnippet);

    findings.push({
      filename: `redirects/bulk/${prefix.replace(/\//g, "_")}`,
      lineNumber: 0,
      codeSnippet: codeSnippet.slice(0, SNIPPET_MAX),
      findingType: FindingType.GHOST_REDIRECT,
      severity,
      appName: undefined,
      description: `${group.count} bulk redirects under "${prefix}" — may be left by an uninstalled SEO or URL management app`,
    });
  }
  return findings;
}

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
 * Single-pass composition of the chunkable pieces above (gc-747u); the scan
 * worker calls the pieces directly so a long walk can span several steps.
 *
 * @param redirects  Array of URL redirect data from the Shopify Admin API.
 * @returns          Findings for orphaned redirects.
 */
export function detectOrphanedRedirects(redirects: RedirectData[]): CreateFindingInput[] {
  const groups: BulkRedirectGroups = {};
  addToBulkRedirectGroups(groups, redirects);
  return [...detectAppPatternRedirects(redirects), ...bulkRedirectFindings(groups)];
}
