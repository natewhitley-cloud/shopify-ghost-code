-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "spanEnd" INTEGER,
ADD COLUMN     "spanSha256" TEXT,
ADD COLUMN     "spanStart" INTEGER;

-- CreateTable
CREATE TABLE "FixRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "sourceThemeId" TEXT NOT NULL,
    "copyThemeId" TEXT,
    "copyThemeName" TEXT,
    "copyCreatedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "doNotPublish" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FixRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixItem" (
    "id" TEXT NOT NULL,
    "fixRunId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "spanStart" INTEGER NOT NULL,
    "spanEnd" INTEGER NOT NULL,
    "spanSha256" TEXT NOT NULL,
    "preMd5" TEXT,
    "postMd5" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,

    CONSTRAINT "FixItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixRun_shopId_createdAt_idx" ON "FixRun"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "FixItem_fixRunId_idx" ON "FixItem"("fixRunId");

-- CreateIndex
CREATE UNIQUE INDEX "FixItem_fixRunId_findingId_key" ON "FixItem"("fixRunId", "findingId");

-- AddForeignKey
ALTER TABLE "FixRun" ADD CONSTRAINT "FixRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixItem" ADD CONSTRAINT "FixItem_fixRunId_fkey" FOREIGN KEY ("fixRunId") REFERENCES "FixRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

