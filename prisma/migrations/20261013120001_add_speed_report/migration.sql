-- gc-wt3y: store speed report (Professional, DARK behind SPEED_REPORT_LIVE_ENABLED).
--
-- Additive only:
--   Shop.speedReportRequestedAt  nullable TIMESTAMP, no default, no backfill
--                                (the "Run speed test now" 24h claim).
--   SpeedReport                  new table, nothing references it. Cascades
--                                from Shop, so shop/redact removes it with the
--                                Shop row (no personal data).
--   PageSpeedDailyUsage          new table, the global per-UTC-day PageSpeed
--                                call counter (no shop data).
--
-- Manual rollback:
--   DROP TABLE "SpeedReport";
--   DROP TABLE "PageSpeedDailyUsage";
--   ALTER TABLE "Shop" DROP COLUMN "speedReportRequestedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "speedReportRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SpeedReport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "pages" JSONB,
    "psiCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SpeedReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageSpeedDailyUsage" (
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageSpeedDailyUsage_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "SpeedReport_shopId_createdAt_idx" ON "SpeedReport"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "SpeedReport" ADD CONSTRAINT "SpeedReport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
