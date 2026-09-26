-- gc-97k.7: once-ever stamp for the native App Store review popup request.
-- Written by the app (claimShopStamp) when the results page reports the
-- shopify.reviews.request() outcome; no backfill: NULL means the popup has
-- never been requested.
--
-- Additive and reversible (nullable, no default):
--   ALTER TABLE "Shop" DROP COLUMN "reviewPopupRequestedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "reviewPopupRequestedAt" TIMESTAMP(3);
