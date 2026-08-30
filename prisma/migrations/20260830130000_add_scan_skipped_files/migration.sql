-- gc-06e.19: fix the diff false-"resolved" bug caused by oversized files that
-- are skipped (over MAX_SCANNABLE_FILE_BYTES) and never scanned.
--
-- Adds Scan.skippedFiles (the theme file paths whose per-file detectors were
-- skipped this run for exceeding the size cap) so the differ never marks a prior
-- finding in an unscanned file as "resolved", and so the skip can be surfaced to
-- the merchant. Mirrors the existing Scan.skippedCategories column.
--
-- Additive and reversible: DROP COLUMN is trivially reversible:
--   ALTER TABLE "Scan" DROP COLUMN "skippedFiles";
-- Existing rows default to an empty array (they were fully scanned, or predate
-- this signal), so the backfill is a no-op.

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "skippedFiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
