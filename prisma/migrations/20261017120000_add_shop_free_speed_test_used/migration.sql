-- Free speed test: one homepage-only store speed test per shop, once ever, on
-- Free and Standard (PlanFeatures.freeSpeedTest).
--   Shop.freeSpeedTestUsedAt  nullable TIMESTAMP, no default: when the free
--     test was used up (a FREE_TEST report that COMPLETED with a homepage
--     score). NULL = never used. No backfill: no shop has used it yet.
--
-- Additive and reversible:
--   ALTER TABLE "Shop" DROP COLUMN "freeSpeedTestUsedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "freeSpeedTestUsedAt" TIMESTAMP(3);
