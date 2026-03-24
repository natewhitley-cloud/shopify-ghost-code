/**
 * Product tag ghost detection.
 *
 * Detects tags left on products by uninstalled apps. Many apps use
 * distinctive tag prefixes to mark products they manage.
 */

import { FindingType } from "@prisma/client";

import type { ProductTagData } from "./product-fetcher.server";
import { classifySeverity } from "./severity-classifier.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Known app tag patterns with attribution
// ---------------------------------------------------------------------------

const APP_TAG_PATTERNS: Array<{ pattern: RegExp; appName: string }> = [
  { pattern: /^__bold/i, appName: "Bold" },
  { pattern: /^bold[-_]/i, appName: "Bold" },
  { pattern: /^loyalty[-_]/i, appName: "Smile.io" },
  { pattern: /^smile[-_]/i, appName: "Smile.io" },
  { pattern: /^recharge[-_]/i, appName: "Recharge" },
  { pattern: /^yotpo[-_]/i, appName: "Yotpo" },
  { pattern: /^stamped[-_]/i, appName: "Stamped.io" },
  { pattern: /^loox[-_]/i, appName: "Loox" },
  { pattern: /^omnisend[-_]/i, appName: "Omnisend" },
  { pattern: /^privy[-_]/i, appName: "Privy" },
  { pattern: /^klaviyo[-_]/i, appName: "Klaviyo" },
  { pattern: /^judgeme[-_]/i, appName: "Judge.me" },
  { pattern: /^shopify[-_]flow[-_]/i, appName: "Shopify Flow" },
  { pattern: /^zipify[-_]/i, appName: "Zipify" },
  { pattern: /^oberlo[-_]/i, appName: "Oberlo" },
  { pattern: /^dsers[-_]/i, appName: "DSers" },
  { pattern: /^spocket[-_]/i, appName: "Spocket" },
  { pattern: /^returnly[-_]/i, appName: "Returnly" },
  { pattern: /^aftership[-_]/i, appName: "AfterShip" },
  { pattern: /^back[-_]?in[-_]?stock/i, appName: "Back in Stock" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect tags left on products by uninstalled apps.
 *
 * Each matching tag on each product produces a separate finding — multiple
 * tags from the same app on the same product are not deduplicated because
 * each tag is worth reviewing individually for cleanup.
 */
export function detectOrphanedProductTags(products: ProductTagData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const product of products) {
    for (const tag of product.tags) {
      const match = APP_TAG_PATTERNS.find((p) => p.pattern.test(tag));
      if (!match) continue;

      const codeSnippet = `Product: ${product.title}\nTag: ${tag}`;
      const severity = classifySeverity(FindingType.GHOST_TAG, codeSnippet);

      findings.push({
        filename: `products/${product.id}`,
        lineNumber: 0,
        codeSnippet,
        findingType: FindingType.GHOST_TAG,
        severity,
        appName: match.appName,
        description: `Product "${product.title}" has tag "${tag}" likely left by ${match.appName}`,
      });
    }
  }

  return findings;
}
