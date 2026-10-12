-- Theme health (gc-i6du).
--
-- 1. New FindingType value LIQUID_ERROR_RENDERED: a Liquid error rendered as
--    text on the public storefront homepage. Enum values cannot be dropped in
--    Postgres; manual rollback = leave the unused value in place (harmless).
-- 2. Scan.themeInfo: nullable JSONB, no default, no backfill. The scanned
--    theme's name / version / author (config/settings_schema.json theme_info)
--    and whether it is an Online Store 2.0 theme. NULL = legacy scan.
--    Rollback:
--      ALTER TABLE "Scan" DROP COLUMN "themeInfo";

-- AlterEnum
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'LIQUID_ERROR_RENDERED';

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "themeInfo" JSONB;
