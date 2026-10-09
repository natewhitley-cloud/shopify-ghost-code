-- gc-ol95: merchant summary email (consent + ledger counts).
--
-- Additive only, no backfill (a shop already on a paid plan must NOT be
-- treated as having been told; it stays ineligible until it opts in):
--   Shop.summaryNoticePendingAt   nullable TIMESTAMP, no default
--   Shop.summaryNoticeShownAt     nullable TIMESTAMP, no default
--   Shop.summaryOptedInAt         nullable TIMESTAMP, no default
--   MerchantAlert.fixedCount, inactiveAppCount, cleanedAppCount
--                                 INTEGER NOT NULL DEFAULT 0 (existing rows
--                                 read as 0)
--   MerchantAlert (shopId, scanId) unique index: one summary per scan. Prod
--                                 has never had the merchant sender env set,
--                                 so no row can collide (the old step also
--                                 recorded at most one row per scan).
--
-- Manual rollback:
--   DROP INDEX "MerchantAlert_shopId_scanId_key";
--   ALTER TABLE "MerchantAlert" DROP COLUMN "cleanedAppCount",
--     DROP COLUMN "fixedCount", DROP COLUMN "inactiveAppCount";
--   ALTER TABLE "Shop" DROP COLUMN "summaryNoticePendingAt",
--     DROP COLUMN "summaryNoticeShownAt", DROP COLUMN "summaryOptedInAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "summaryNoticePendingAt" TIMESTAMP(3),
ADD COLUMN     "summaryNoticeShownAt" TIMESTAMP(3),
ADD COLUMN     "summaryOptedInAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MerchantAlert" ADD COLUMN     "cleanedAppCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fixedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inactiveAppCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "MerchantAlert_shopId_scanId_key" ON "MerchantAlert"("shopId", "scanId");
