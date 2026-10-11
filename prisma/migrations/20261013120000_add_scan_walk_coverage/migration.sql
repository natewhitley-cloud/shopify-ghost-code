-- gc-747u: record what each capped product / redirect walk covered, so the
-- differ never resolves findings past the cap and the scan page can say
-- "checked N of M".
--
-- Additive and reversible (nullable, no default, no backfill: NULL = legacy
-- scan that walked the Free caps and recorded nothing):
--   ALTER TABLE "Scan" DROP COLUMN "walkCoverage";

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "walkCoverage" JSONB;
