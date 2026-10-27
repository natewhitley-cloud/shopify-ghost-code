import type { MerchantFeedback } from "@prisma/client";

import db from "../db.server";

/**
 * One Help page message as persisted (gc-3twe; the gc-97k.3 survey's columns
 * valuable / improvement / wtp are no longer written). Null = not given.
 * contactEmail is only ever stored together with contactConsentAt.
 */
export type MerchantFeedbackData = {
  topic: string;
  message: string;
  csat: number | null;
  contactEmail: string | null;
  contactConsentAt: Date | null;
  /** Server-built support context (plan, latest scan id); never client input. */
  context: string | null;
};

/**
 * Insert one Help message for a shop. Several rows per shop are allowed.
 * Rows are removed on shop/redact (deleteShopData deletes them explicitly, and
 * the Shop FK cascades).
 */
export function createMerchantFeedback(
  shopId: string,
  data: MerchantFeedbackData,
): Promise<MerchantFeedback> {
  return db.merchantFeedback.create({ data: { shopId, ...data } });
}

/** How many Help messages the shop sent since `since` (the Help rate limit). */
export function countMerchantFeedbackSince(shopId: string, since: Date): Promise<number> {
  return db.merchantFeedback.count({ where: { shopId, createdAt: { gte: since } } });
}
