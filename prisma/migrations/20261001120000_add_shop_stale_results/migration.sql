-- gc-mgi: stale-results banner upgrade-ask funnel stamps on Shop.
--   staleResultsShownAt / ClickedAt / ConvertedAt: once-per-merchant funnel
--     stamps (claimShopStamp). NULL = not happened. No dismissed stamp: the
--     banner is content with no "Not now".
--
-- Additive and reversible:
--   ALTER TABLE "Shop" DROP COLUMN "staleResultsShownAt",
--     DROP COLUMN "staleResultsClickedAt", DROP COLUMN "staleResultsConvertedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "staleResultsClickedAt" TIMESTAMP(3),
ADD COLUMN     "staleResultsConvertedAt" TIMESTAMP(3),
ADD COLUMN     "staleResultsShownAt" TIMESTAMP(3);
