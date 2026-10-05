-- Storefront script-tag sunset audit (dark behind SCRIPT_TAG_SUNSET_LIVE_ENABLED).
--
-- 1. New FindingType value SCRIPT_TAG_SUNSET. Enum values cannot be dropped in
--    Postgres; manual rollback = leave the unused value in place (harmless).
-- 2. Scan.unreachableCategories: categories whose check could not run because
--    the public storefront could not be read. Additive, defaulted to an empty
--    array so every existing row reads as "nothing unreachable". Rollback:
--      ALTER TABLE "Scan" DROP COLUMN "unreachableCategories";

-- AlterEnum
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'SCRIPT_TAG_SUNSET';

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "unreachableCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
