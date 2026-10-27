-- Help page (feedback survey merged into Help) + one-time install-source card.
-- Additive only: new nullable columns, a defaulted topic, and csat made optional.
-- Existing MerchantFeedback rows (all survey submissions) get topic 'feedback'.
--
-- Manual rollback (restoring csat NOT NULL first needs every Help row without
-- a rating removed or given one, e.g. DELETE ... WHERE "csat" IS NULL):
--   ALTER TABLE "MerchantFeedback" ALTER COLUMN "csat" SET NOT NULL;
--   ALTER TABLE "MerchantFeedback" DROP COLUMN "topic", DROP COLUMN "message",
--     DROP COLUMN "contactConsentAt", DROP COLUMN "context";
--   ALTER TABLE "Shop" DROP COLUMN "installSource", DROP COLUMN "installSourceOther",
--     DROP COLUMN "installSourceShownAt", DROP COLUMN "installSourceAnsweredAt",
--     DROP COLUMN "installSourceSkippedAt";
ALTER TABLE "MerchantFeedback" ADD COLUMN "topic" TEXT NOT NULL DEFAULT 'feedback';
ALTER TABLE "MerchantFeedback" ADD COLUMN "message" TEXT;
ALTER TABLE "MerchantFeedback" ADD COLUMN "contactConsentAt" TIMESTAMP(3);
ALTER TABLE "MerchantFeedback" ADD COLUMN "context" TEXT;
ALTER TABLE "MerchantFeedback" ALTER COLUMN "csat" DROP NOT NULL;

ALTER TABLE "Shop" ADD COLUMN "installSource" TEXT;
ALTER TABLE "Shop" ADD COLUMN "installSourceOther" TEXT;
ALTER TABLE "Shop" ADD COLUMN "installSourceShownAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "installSourceAnsweredAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "installSourceSkippedAt" TIMESTAMP(3);
