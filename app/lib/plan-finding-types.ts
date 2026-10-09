/**
 * Finding types a plan may NOT see in full (audit fix for gc-bn0x / gc-4n0y):
 * the single source for "types this plan may see in full".
 *
 * Two detectors are plan features, not permissions: Broken links
 * (DANGLING_REFERENCE, gc-m4h.7) and checkout.liquid sunset (CHECKOUT_SUNSET,
 * gc-b3c). The worker never produces them for a Free scan, but a shop that
 * downgrades (Pro -> Free, or a trial that ends) keeps its earlier scans, and
 * those can hold such findings. The Free preview, and so the Free "Start here"
 * block, must never show them in full. They still count as locked findings in
 * the teaser and the lanes (they are exactly what Standard adds).
 *
 * Pure and client-safe; `PlanFeatures` is a type-only import.
 */
import type { FindingType } from "@prisma/client";

import type { PlanFeatures } from "./billing.server";

export function findingTypesWithheldByPlan(
  features: Pick<PlanFeatures, "canDetectDanglingReferences" | "canDetectCheckoutSunset">,
): FindingType[] {
  const withheld: FindingType[] = [];
  if (!features.canDetectDanglingReferences) withheld.push("DANGLING_REFERENCE");
  if (!features.canDetectCheckoutSunset) withheld.push("CHECKOUT_SUNSET");
  return withheld;
}
