-- gc-11f: separate cap-truncated checks from scope skips.
--
-- Adds Scan.cappedCategories: the FindingType categories whose optional audit
-- ran (scope granted) but hit a size cap this run (JSON-LD candidate cap or
-- lookup budget, dangling-reference handle/occurrence caps, or the step-output
-- budget), so only part of the category was checked. The differ excludes the
-- UNION of skippedCategories + cappedCategories from "resolved" detection, and
-- the scan-detail UI shows an info notice for caps instead of the permissions
-- warning (skippedCategories is now scope-only).
--
-- Additive and reversible: DROP COLUMN is trivially reversible:
--   ALTER TABLE "Scan" DROP COLUMN "cappedCategories";
-- Existing rows default to an empty array (no backfill needed).

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "cappedCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
