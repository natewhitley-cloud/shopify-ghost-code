-- gc-iirv: Store speed teaser upgrade-ask funnel stamps on Shop.
--   speedTeaserShownAt / ClickedAt / ConvertedAt: once-per-merchant funnel
--     stamps (claimShopStamp). NULL = not happened. No dismissed stamp: the
--     teaser is content with no "Not now".
--
-- Additive and reversible:
--   ALTER TABLE "Shop" DROP COLUMN "speedTeaserShownAt",
--     DROP COLUMN "speedTeaserClickedAt", DROP COLUMN "speedTeaserConvertedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "speedTeaserClickedAt" TIMESTAMP(3),
ADD COLUMN     "speedTeaserConvertedAt" TIMESTAMP(3),
ADD COLUMN     "speedTeaserShownAt" TIMESTAMP(3);
