-- gc-ydze audit A1: additive Shop column only. No drop, no rename.
--
--   planLoweredAt: the last time the stored plan moved to a LOWER tier
--                  (Professional -> Standard/free, Standard -> free). Stamped by
--                  updateShopPlanByDomain on every reconcile path (redirect and
--                  stale/backstop), so cancellations and expirations made in
--                  Shopify admin count too; BillingEvent is redirect-only.
--                  The manual-scan quota counts from here when it falls inside
--                  the current period (getQuotaCountStart). NULL = never lowered.
--
-- BACKFILL (deterministic, runs once on deploy, fills NULL rows only):
--   planLoweredAt = the latest downgrade/cancellation BillingEvent.createdAt for
--   the shop (NULL when none). Only events in the current quota period change
--   anything, so older history is harmless.
--
-- Reversible:
--   ALTER TABLE "Shop" DROP COLUMN "planLoweredAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "planLoweredAt" TIMESTAMP(3);

-- Backfill planLoweredAt
UPDATE "Shop" AS s
SET "planLoweredAt" = (
    SELECT MAX(b."createdAt")
      FROM "BillingEvent" AS b
     WHERE b."shopId" = s."id"
       AND b."eventType" IN ('downgrade', 'cancellation')
)
WHERE s."planLoweredAt" IS NULL;
