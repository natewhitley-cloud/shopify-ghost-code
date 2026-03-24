/**
 * Persistent discount price detection.
 *
 * Detects products where compareAtPrice is set on variants, suggesting
 * a discount app set these prices and was then uninstalled, leaving
 * phantom "sale" pricing.
 */

import { FindingType } from "@prisma/client";

import type { ProductPriceData } from "./product-fetcher.server";
import { classifySeverity } from "./severity-classifier.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect products with persistent compare-at pricing.
 *
 * Emits one finding per product (not per variant) to avoid noise. The
 * code snippet shows up to 3 affected variants; the description notes
 * the total count when more than 3 are affected.
 */
export function detectPersistentDiscounts(products: ProductPriceData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const product of products) {
    const affectedVariants = product.variants.filter(
      (v) => v.compareAtPrice !== null && parseFloat(v.compareAtPrice) > parseFloat(v.price),
    );

    if (affectedVariants.length === 0) continue;

    // Show up to 3 sample variants in the code snippet
    const sampleVariants = affectedVariants.slice(0, 3);
    const codeSnippet = sampleVariants
      .map((v) => `${v.title}: $${v.price} (was $${v.compareAtPrice})`)
      .join("\n");

    const severity = classifySeverity(FindingType.GHOST_PRICE, codeSnippet);

    const variantCountNote =
      affectedVariants.length > 3 ? ` (showing 3 of ${affectedVariants.length})` : "";

    findings.push({
      filename: `products/${product.id}`,
      lineNumber: 0,
      codeSnippet,
      findingType: FindingType.GHOST_PRICE,
      severity,
      appName: undefined,
      description: `Product "${product.title}" has ${affectedVariants.length} variant(s) with compare-at pricing${variantCountNote} — may be left by an uninstalled discount app`,
    });
  }

  return findings;
}
