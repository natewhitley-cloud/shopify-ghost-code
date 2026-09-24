-- gc-97k.3: merchant feedback nudge. Once-per-merchant stamps for the home-page
-- feedback nudge funnel (shown -> clicked -> dismissed | submitted) plus the
-- MerchantFeedback table for survey submissions.
--
-- Additive and reversible (nullable columns, no default, no backfill; a new
-- table nothing else references):
--   DROP TABLE "MerchantFeedback";
--   ALTER TABLE "Shop" DROP COLUMN "feedbackNudgeShownAt",
--     DROP COLUMN "feedbackNudgeClickedAt", DROP COLUMN "feedbackNudgeDismissedAt",
--     DROP COLUMN "feedbackSubmittedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "feedbackNudgeShownAt" TIMESTAMP(3),
ADD COLUMN     "feedbackNudgeClickedAt" TIMESTAMP(3),
ADD COLUMN     "feedbackNudgeDismissedAt" TIMESTAMP(3),
ADD COLUMN     "feedbackSubmittedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MerchantFeedback" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "csat" INTEGER NOT NULL,
    "valuable" TEXT,
    "improvement" TEXT,
    "wtp" TEXT,
    "contactEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantFeedback_shopId_idx" ON "MerchantFeedback"("shopId");

-- CreateIndex
CREATE INDEX "MerchantFeedback_createdAt_idx" ON "MerchantFeedback"("createdAt");

-- AddForeignKey
ALTER TABLE "MerchantFeedback" ADD CONSTRAINT "MerchantFeedback_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
