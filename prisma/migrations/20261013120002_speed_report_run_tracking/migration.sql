-- gc-wt3y #2/#3/#8: which Inngest run owns a speed report, and when the
-- worker started it. Additive: two nullable columns + a unique index (NULLs
-- do not collide in Postgres, so existing rows are unaffected).
--
-- Manual rollback:
--   DROP INDEX "SpeedReport_runId_key";
--   ALTER TABLE "SpeedReport" DROP COLUMN "runId", DROP COLUMN "startedAt";

-- AlterTable
ALTER TABLE "SpeedReport" ADD COLUMN     "runId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "SpeedReport_runId_key" ON "SpeedReport"("runId");
