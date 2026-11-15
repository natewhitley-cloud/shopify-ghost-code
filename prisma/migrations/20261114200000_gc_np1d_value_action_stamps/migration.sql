-- gc-np1d.5: value-action funnel stamps on Shop (once per merchant, claimShopStamp).
-- Additive and reversible: ALTER TABLE "Shop" DROP COLUMN <each column below>;
ALTER TABLE "Shop" ADD COLUMN "cleanCopyActionShownAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyActionClickedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyActionConvertedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyUpsellShownAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyUpsellClickedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyUpsellConvertedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyDiyShownAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyDiyClickedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "scanHeaderClickedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "cleanCopyPreviewClickedAt" TIMESTAMP(3);
