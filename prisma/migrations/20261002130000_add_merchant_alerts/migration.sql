-- gc-syz.1: merchant monitoring alerts. Per-shop alert preferences on Shop plus
-- the MerchantAlert ledger (dedup + rate-limit source for the alert sender).
--
-- Additive and reversible (new columns are defaulted or nullable, so the live
-- Shop table needs no backfill; a new table nothing else references):
--   DROP TABLE "MerchantAlert";
--   ALTER TABLE "Shop" DROP COLUMN "alertsEnabled",
--     DROP COLUMN "alertEmail", DROP COLUMN "alertUnsubscribeToken";
--
-- alertEmail / MerchantAlert.recipient are personal data: removed with the Shop
-- row (and the ledger rows explicitly) in deleteShopData on shop/redact.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alertEmail" TEXT,
ADD COLUMN     "alertUnsubscribeToken" TEXT;

-- CreateTable
CREATE TABLE "MerchantAlert" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "findingSetHash" TEXT NOT NULL,
    "newCount" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_alertUnsubscribeToken_key" ON "Shop"("alertUnsubscribeToken");

-- CreateIndex
CREATE INDEX "MerchantAlert_shopId_sentAt_idx" ON "MerchantAlert"("shopId", "sentAt");

-- AddForeignKey
ALTER TABLE "MerchantAlert" ADD CONSTRAINT "MerchantAlert_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
