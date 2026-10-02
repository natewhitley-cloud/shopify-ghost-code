-- gc-rvo0: record which FindingType detectors were live (existed + not
-- soft-launch-suppressed) for each scan, so merchant alerts never treat a type
-- absent from the baseline as "new" after a flag flip or new detector.
--
-- Additive and reversible (nullable, no default, no backfill: NULL = legacy scan
-- that never recorded its live set; the alert step skips such baselines):
--   ALTER TABLE "Scan" DROP COLUMN "liveFindingTypes";

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "liveFindingTypes" JSONB;
