-- gc-grd: add Shop.uninstalledAt to defer the hard-delete on app uninstall.
--
-- app/uninstalled now stamps this column and revokes sessions instead of hard-
-- deleting the Shop + scan data. The full wipe stays deferred to shop/redact,
-- honoring the 48h GDPR grace window and leaving an uninstall record.
--
-- uninstalledAt: null = active install; set = uninstalled, pending the
-- shop/redact hard-delete; cleared back to null on reinstall (upsertShop).
-- Also the install-count / iterator filter source: scan/metric iterators skip
-- rows where uninstalledAt IS NOT NULL.
--
-- Reversibility / rollback:
--   Additive, nullable column with no default and no backfill — fully
--   reversible with no data loss for existing rows:
--       ALTER TABLE "Shop" DROP COLUMN "uninstalledAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "uninstalledAt" TIMESTAMP(3);
