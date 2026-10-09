-- Scan start-source and results-view telemetry (operator digest only).
--
-- Four additive, nullable Scan columns with no default and no backfill, so
-- every pre-existing row reads as "not recorded" (the digest labels those rows
-- as from before tracking, never as "unknown"):
--   requestedFrom      page a MANUAL scan was started from ("home" |
--                      "scan_page" | "unknown"); null for SCHEDULED/AUTO_PUBLISH.
--   shopScanNumber     1-based order of the scan among all the shop's scans at
--                      creation time (1 = first scan ever).
--   viewedOnHomeAt     first time Home rendered this scan's results.
--   viewedOnScanPageAt first time the scan page rendered this scan's results.
--
-- Manual rollback:
--   ALTER TABLE "Scan" DROP COLUMN "requestedFrom", DROP COLUMN "shopScanNumber",
--     DROP COLUMN "viewedOnHomeAt", DROP COLUMN "viewedOnScanPageAt";

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "requestedFrom" TEXT,
ADD COLUMN "shopScanNumber" INTEGER,
ADD COLUMN "viewedOnHomeAt" TIMESTAMP(3),
ADD COLUMN "viewedOnScanPageAt" TIMESTAMP(3);
