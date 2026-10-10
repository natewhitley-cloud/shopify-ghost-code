-- gc-ol95: cache the store's display name for the summary email.
--
-- Additive only, no backfill: Shop.storeName nullable TEXT, no default. It is
-- filled from Admin `shop { name }` whenever the owner email is refreshed;
-- until then the email falls back to the myshopify domain.
--
-- Manual rollback:
--   ALTER TABLE "Shop" DROP COLUMN "storeName";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "storeName" TEXT;
