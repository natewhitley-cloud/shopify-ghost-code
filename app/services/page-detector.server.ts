/**
 * Orphaned page detection.
 *
 * Detects pages created by apps that have been uninstalled. Many Shopify apps
 * create pages with distinctive handle patterns during installation. When the
 * app is uninstalled, these pages persist and clutter the store.
 */

import { FindingType } from "@prisma/client";

import type { PageData } from "./content-fetcher.server";
import { classifySeverity } from "./severity-classifier.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Known app page handle patterns
// ---------------------------------------------------------------------------

const APP_PAGE_PATTERNS: Array<{ pattern: RegExp; appName: string }> = [
  { pattern: /^pagefly[-_]/i, appName: "PageFly" },
  { pattern: /^gempages[-_]/i, appName: "GemPages" },
  { pattern: /^shogun[-_]/i, appName: "Shogun" },
  { pattern: /^zipify[-_]/i, appName: "Zipify Pages" },
  { pattern: /^privy[-_]/i, appName: "Privy" },
  { pattern: /^klaviyo[-_]/i, appName: "Klaviyo" },
  { pattern: /^omnisend[-_]/i, appName: "Omnisend" },
  { pattern: /^stamped[-_]/i, appName: "Stamped.io" },
  { pattern: /^yotpo[-_]/i, appName: "Yotpo" },
  { pattern: /^judge[-_]?me/i, appName: "Judge.me" },
  { pattern: /^loox[-_]/i, appName: "Loox" },
  { pattern: /^trustoo/i, appName: "Trustoo" },
  { pattern: /^vitals[-_]/i, appName: "Vitals" },
  { pattern: /^recharge[-_]/i, appName: "Recharge" },
  { pattern: /^bold[-_]/i, appName: "Bold" },
  { pattern: /^ecomsolid[-_]/i, appName: "EComSolid" },
  { pattern: /^reconvert[-_]/i, appName: "ReConvert" },
  { pattern: /^aftership[-_]/i, appName: "AfterShip" },
  { pattern: /^trackingmore/i, appName: "TrackingMore" },
  { pattern: /^returnly[-_]/i, appName: "Returnly" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect pages created by apps based on handle patterns.
 *
 * Emits one finding per matched page. The code snippet includes the page
 * title, handle, and a short body preview with HTML tags stripped.
 */
export function detectOrphanedPages(pages: PageData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const page of pages) {
    const match = APP_PAGE_PATTERNS.find((p) => p.pattern.test(page.handle));
    if (!match) continue;

    const bodyPreview = page.body
      .slice(0, 200)
      .replace(/<[^>]+>/g, "")
      .trim();
    const codeSnippet = `Page: ${page.title}\nHandle: /${page.handle}\n${bodyPreview ? `Content: ${bodyPreview}` : "(empty page)"}`;

    const severity = classifySeverity(FindingType.GHOST_PAGE, codeSnippet);

    findings.push({
      filename: `pages/${page.handle}`,
      lineNumber: 0,
      codeSnippet: codeSnippet.slice(0, 300),
      findingType: FindingType.GHOST_PAGE,
      severity,
      appName: match.appName,
      description: `Page "${page.title}" (/${page.handle}) likely created by ${match.appName}`,
    });
  }

  return findings;
}
