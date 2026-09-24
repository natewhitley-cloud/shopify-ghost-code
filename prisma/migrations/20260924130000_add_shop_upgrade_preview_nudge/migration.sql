-- gc-97k.4: once-per-merchant dedupe stamps for the free-tier upgrade-preview
-- nudge funnel (shown -> clicked -> converted).
--
-- Additive and reversible (nullable, no default, no backfill; null = the stage
-- has not happened):
--   ALTER TABLE "Shop" DROP COLUMN "upgradePreviewShownAt",
--     DROP COLUMN "upgradePreviewClickedAt", DROP COLUMN "upgradePreviewConvertedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "upgradePreviewShownAt" TIMESTAMP(3),
ADD COLUMN     "upgradePreviewClickedAt" TIMESTAMP(3),
ADD COLUMN     "upgradePreviewConvertedAt" TIMESTAMP(3);
