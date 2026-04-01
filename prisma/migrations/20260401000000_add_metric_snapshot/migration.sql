-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "totalShops" INTEGER NOT NULL,
    "activeShops" INTEGER NOT NULL,
    "shopsByPlan" JSONB NOT NULL,
    "totalScans" INTEGER NOT NULL,
    "scansLast7d" INTEGER NOT NULL,
    "scansLast30d" INTEGER NOT NULL,
    "completionRate" DOUBLE PRECISION NOT NULL,
    "totalFindings" INTEGER NOT NULL,
    "avgFindingsPerScan" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_snapshotDate_key" ON "MetricSnapshot"("snapshotDate");
