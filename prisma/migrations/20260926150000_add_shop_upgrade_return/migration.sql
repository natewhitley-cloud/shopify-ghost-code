-- gc-97k.9: return-visit upgrade nudge (Free only) state on Shop.
--   upgradeReturnLastShownAt / upgradeReturnLastDismissedAt: the current weekly
--     episode's start and the last "Not now" (plain updates by the app).
--   upgradeReturnDismissCount: "Not now" clicks; 3 retires the nudge. NOT NULL
--     DEFAULT 0, so existing rows read 0 (no separate backfill).
--   upgradeReturnShownAt / ClickedAt / DismissedAt / ConvertedAt: once-per-
--     merchant funnel stamps (claimShopStamp). NULL = not happened.
--
-- Additive and reversible:
--   ALTER TABLE "Shop" DROP COLUMN "upgradeReturnLastShownAt",
--     DROP COLUMN "upgradeReturnLastDismissedAt", DROP COLUMN "upgradeReturnDismissCount",
--     DROP COLUMN "upgradeReturnShownAt", DROP COLUMN "upgradeReturnClickedAt",
--     DROP COLUMN "upgradeReturnDismissedAt", DROP COLUMN "upgradeReturnConvertedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "upgradeReturnClickedAt" TIMESTAMP(3),
ADD COLUMN     "upgradeReturnConvertedAt" TIMESTAMP(3),
ADD COLUMN     "upgradeReturnDismissCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "upgradeReturnDismissedAt" TIMESTAMP(3),
ADD COLUMN     "upgradeReturnLastDismissedAt" TIMESTAMP(3),
ADD COLUMN     "upgradeReturnLastShownAt" TIMESTAMP(3),
ADD COLUMN     "upgradeReturnShownAt" TIMESTAMP(3);
