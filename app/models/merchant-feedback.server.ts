import type { MerchantFeedback } from "@prisma/client";

import db from "../db.server";

/** The survey answers persisted per submission (gc-97k.3). Null = left blank. */
export type MerchantFeedbackData = {
  csat: number;
  valuable: string | null;
  improvement: string | null;
  wtp: string | null;
  contactEmail: string | null;
};

/**
 * Insert one feedback submission for a shop. Several rows per shop are allowed.
 * Rows are removed on shop/redact (deleteShopData deletes them explicitly, and
 * the Shop FK cascades).
 */
export function createMerchantFeedback(
  shopId: string,
  data: MerchantFeedbackData,
): Promise<MerchantFeedback> {
  return db.merchantFeedback.create({ data: { shopId, ...data } });
}
