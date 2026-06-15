-- LOG-4 / GC-fp2: decouple scan completion from persistence and fix the diff
-- false-"resolved" bug caused by un-audited optional categories.
--
-- This migration:
--   1. Adds a PARTIAL value to the ScanStatus enum (a successful, usable
--      terminal status used when one or more optional audit categories were
--      skipped because their Shopify scope was not granted).
--   2. Adds Scan.skippedCategories (the set of FindingType categories skipped
--      for missing scope this run) so the differ never marks prior findings in
--      an un-audited category as "resolved".
--
-- Reversibility / manual rollback:
--   - DROP COLUMN is trivially reversible:
--       ALTER TABLE "Scan" DROP COLUMN "skippedCategories";
--   - PostgreSQL cannot DROP an enum value directly. To roll back PARTIAL:
--       a) Re-map any rows using it (none expected on rollback, but be safe):
--            UPDATE "Scan" SET "status" = 'COMPLETED' WHERE "status" = 'PARTIAL';
--       b) Recreate the enum without PARTIAL:
--            ALTER TYPE "ScanStatus" RENAME TO "ScanStatus_old";
--            CREATE TYPE "ScanStatus" AS ENUM ('PENDING','IN_PROGRESS','COMPLETED','FAILED');
--            ALTER TABLE "Scan" ALTER COLUMN "status" DROP DEFAULT;
--            ALTER TABLE "Scan" ALTER COLUMN "status" TYPE "ScanStatus"
--              USING ("status"::text::"ScanStatus");
--            ALTER TABLE "Scan" ALTER COLUMN "status" SET DEFAULT 'PENDING';
--            DROP TYPE "ScanStatus_old";

-- AlterEnum
ALTER TYPE "ScanStatus" ADD VALUE 'PARTIAL' BEFORE 'FAILED';

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "skippedCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
