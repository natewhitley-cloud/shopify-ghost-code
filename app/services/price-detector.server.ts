/**
 * Persistent (orphaned) discount price detection.
 *
 * A compare-at price that is higher than the price is exactly how a legitimate,
 * active Shopify sale works — it is the native strikethrough-sale mechanism set
 * by merchants by hand and by every running sale app. `compareAtPrice` is a
 * plain display field on the variant, independent of Shopify's discount /
 * price-rule system, so the ABSENCE of an active discount rule does NOT mean a
 * compare-at price is orphaned. There is no native Shopify field marking which
 * app (if any) set a compare-at price, and the `appInstallations` query that
 * would reveal whether that app is still installed is restricted to
 * Shopify-internal apps.
 *
 * Because of that, a bare compare-at price carries no orphan signal on its own.
 * We therefore flag a persistent discount ONLY when it is corroborated by
 * leftover product data from an app that is KNOWN TO MANIPULATE PRICING — i.e.
 * a discount/sale app's merchant-visible metafield on the same product. This is
 * the same positive-evidence, app-signature approach used by the other
 * detectors (LOG-1/LOG-3): we flag on evidence of an orphan, never on the mere
 * absence of legitimacy.
 *
 * Canonical case: Bold Discounts ("Shappify") activates a sale by MOVING the
 * original price into `compareAtPrice` and writing the discounted price into
 * `price` — exactly the shape below. It marks on-sale products with the
 * merchant-visible metafield `inventory.ShappifySale`. Bold's own docs warn
 * that uninstalling while a discount group is active leaves BOTH the compare-at
 * residue AND the metafields behind, with no automatic way to turn the sale
 * off. That residue is the orphaned "ghost" discount this detector targets.
 *
 * Limitation (documented, intentional): sale apps that set `compareAtPrice`
 * without leaving a recognizable merchant-visible metafield cannot be
 * distinguished from an intentional merchant sale, and are NOT flagged. Missing
 * coverage is preferred over false positives on every store running a promotion.
 */

import { FindingType } from "@prisma/client";

import type { ProductPriceData } from "./product-fetcher.server";
import { classifySeverity } from "./severity-classifier.server";
import type { CreateFindingInput } from "../models/finding.server";

// ---------------------------------------------------------------------------
// Discount/sale-app metafield signatures (orphan corroboration)
// ---------------------------------------------------------------------------

/**
 * Signatures for apps KNOWN TO MANIPULATE VARIANT PRICING. Only metafields from
 * these apps corroborate that a persistent compare-at price is an orphaned
 * discount — a reviews/SEO/loyalty metafield tells us nothing about pricing and
 * must NOT be used here.
 *
 * A signature matches when `namespace` matches the metafield namespace and, if
 * `key` is present, the metafield key as well. Keys are matched whenever the
 * namespace alone is too generic to be a reliable signal (e.g. `inventory`).
 *
 * Conservative by design: missing an app produces a false negative (we under-
 * report), which is acceptable; a loose pattern produces a false positive on a
 * legitimate sale, which is not. Extend with verified app signatures only.
 */
type DiscountAppSignature = {
  appName: string;
  namespace: RegExp;
  key?: RegExp;
};

const DISCOUNT_APP_METAFIELD_SIGNATURES: DiscountAppSignature[] = [
  // Bold Discounts ("Shappify"): marks on-sale products with the merchant-
  // visible metafield `inventory.ShappifySale` (referenced in theme Liquid as
  // `product.metafields.inventory.ShappifySale`). The `inventory` namespace is
  // generic, so we additionally require the Bold-specific key.
  { appName: "Bold Discounts", namespace: /^inventory$/i, key: /^shappifysale$/i },
  // Bold's own branded namespaces (Shappify is Bold Discounts' legacy name).
  { appName: "Bold Discounts", namespace: /^shappify/i },
  { appName: "Bold Discounts", namespace: /^bold[-_]?discount/i },
];

/**
 * Return the first discount/sale-app metafield on the product that corroborates
 * an orphaned discount, or null if none is present.
 */
function findDiscountAppEvidence(
  metafields: ProductPriceData["metafields"],
): { appName: string; namespace: string; key: string } | null {
  for (const mf of metafields) {
    for (const sig of DISCOUNT_APP_METAFIELD_SIGNATURES) {
      if (!sig.namespace.test(mf.namespace)) continue;
      if (sig.key && !sig.key.test(mf.key)) continue;
      return { appName: sig.appName, namespace: mf.namespace, key: mf.key };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect products with a persistent (orphaned) discount.
 *
 * A product is flagged only when BOTH conditions hold:
 *   1. At least one variant has `compareAtPrice > price` (a strikethrough sale).
 *   2. The product carries a merchant-visible metafield from a known
 *      pricing-manipulation app (orphan corroboration). A normal active sale
 *      with no such metafield is NOT flagged.
 *
 * Emits one finding per product (not per variant) to avoid noise. The code
 * snippet shows up to 3 affected variants; the description notes the total
 * count when more than 3 are affected and attributes the corroborating app.
 */
export function detectPersistentDiscounts(products: ProductPriceData[]): CreateFindingInput[] {
  const findings: CreateFindingInput[] = [];

  for (const product of products) {
    const affectedVariants = product.variants.filter(
      (v) => v.compareAtPrice !== null && parseFloat(v.compareAtPrice) > parseFloat(v.price),
    );

    if (affectedVariants.length === 0) continue;

    // Require corroborating orphan evidence (LOG-2). A bare compare-at price is
    // how every legitimate active sale works, so it is not flagged on its own.
    const evidence = findDiscountAppEvidence(product.metafields);
    if (!evidence) continue;

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
      appName: evidence.appName,
      description: `Product "${product.title}" has ${affectedVariants.length} variant(s) with persistent compare-at pricing${variantCountNote}, corroborated by a leftover ${evidence.appName} metafield "${evidence.namespace}.${evidence.key}" — likely an orphaned discount from an uninstalled app`,
    });
  }

  return findings;
}
