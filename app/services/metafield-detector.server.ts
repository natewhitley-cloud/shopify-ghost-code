/**
 * Orphaned metafield detection.
 *
 * Detects metafields left on products by uninstalled apps. Many apps
 * use distinctive namespace patterns.
 *
 * Limitation: app-owned metafields (app--{id}--* namespaces) are
 * invisible to third-party apps. Only merchant-visible metafields
 * with known app namespaces can be detected.
 */

import { FindingType } from "@prisma/client";

import type { ProductMetafieldData } from "./product-fetcher.server";
import { classifySeverity } from "./severity-classifier.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Known app metafield namespace patterns
// ---------------------------------------------------------------------------

const APP_NAMESPACE_PATTERNS: Array<{ pattern: RegExp; appName: string }> = [
  { pattern: /^judgeme$/i, appName: "Judge.me" },
  { pattern: /^stamped$/i, appName: "Stamped.io" },
  { pattern: /^yotpo$/i, appName: "Yotpo" },
  { pattern: /^loox$/i, appName: "Loox" },
  { pattern: /^bold[-_]/i, appName: "Bold" },
  { pattern: /^recharge$/i, appName: "Recharge" },
  { pattern: /^klaviyo$/i, appName: "Klaviyo" },
  { pattern: /^privy$/i, appName: "Privy" },
  { pattern: /^spr$/i, appName: "Shopify Product Reviews" },
  { pattern: /^reviews$/i, appName: "Reviews App" },
  { pattern: /^smartseo$/i, appName: "Smart SEO" },
  { pattern: /^seo[-_]/i, appName: "SEO App" },
  { pattern: /^loyalty[-_]/i, appName: "Loyalty App" },
  { pattern: /^smile$/i, appName: "Smile.io" },
  { pattern: /^omnisend$/i, appName: "Omnisend" },
  { pattern: /^pagefly$/i, appName: "PageFly" },
  { pattern: /^shogun$/i, appName: "Shogun" },
  { pattern: /^zipify$/i, appName: "Zipify" },
  { pattern: /^aftership$/i, appName: "AfterShip" },
  { pattern: /^returnly$/i, appName: "Returnly" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect metafields left on products by uninstalled apps.
 *
 * Groups metafields by matched app per product — one finding per app per
 * product. System namespaces ("global", "custom") are excluded since those
 * are merchant-managed.
 */
export function detectOrphanedMetafields(products: ProductMetafieldData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const product of products) {
    // Group metafields by matched app (dedupe: one finding per app per product)
    const appMetafields = new Map<
      string,
      Array<{ namespace: string; key: string; value: string }>
    >();

    for (const mf of product.metafields) {
      // Skip Shopify system namespaces
      if (mf.namespace === "global" || mf.namespace === "custom") continue;

      const match = APP_NAMESPACE_PATTERNS.find((p) => p.pattern.test(mf.namespace));
      if (!match) continue;

      if (!appMetafields.has(match.appName)) {
        appMetafields.set(match.appName, []);
      }
      appMetafields.get(match.appName)!.push({
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value,
      });
    }

    for (const [appName, metafields] of appMetafields) {
      const samples = metafields.slice(0, 3);
      const codeSnippet = samples
        .map((m) => `${m.namespace}.${m.key}: ${m.value.slice(0, 50)}`)
        .join("\n");

      const severity = classifySeverity(FindingType.GHOST_METAFIELD, codeSnippet);

      findings.push({
        filename: `products/${product.id}/metafields`,
        lineNumber: 0,
        codeSnippet: codeSnippet.slice(0, 300),
        findingType: FindingType.GHOST_METAFIELD,
        severity,
        appName,
        description: `Product "${product.title}" has ${metafields.length} metafield(s) in ${appName} namespace — may be left by uninstalled app`,
      });
    }
  }

  return findings;
}
