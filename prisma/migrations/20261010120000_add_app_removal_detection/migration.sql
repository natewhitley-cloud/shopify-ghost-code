-- gc-frda: detect apps removed since the last scan.
--
-- Additive only:
--   Scan.appSignatureFingerprints  nullable JSONB, no default, no backfill
--   Scan.liveAppHooks              (NULL = legacy scan: never used as a
--                                  removal baseline).
--   AppRemoval                     new table + enum, nothing references it.
--                                  Cascades from Shop, so shop/redact removes
--                                  it with the Shop row (no personal data).
--
-- Manual rollback:
--   DROP TABLE "AppRemoval";
--   DROP TYPE "AppRemovalState";
--   ALTER TABLE "Scan" DROP COLUMN "appSignatureFingerprints",
--     DROP COLUMN "liveAppHooks";

-- CreateEnum
CREATE TYPE "AppRemovalState" AS ENUM ('REMOVED', 'CLEANED', 'REINSTALLED');

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "appSignatureFingerprints" JSONB,
ADD COLUMN     "liveAppHooks" JSONB;

-- CreateTable
CREATE TABLE "AppRemoval" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "detectedScanId" TEXT NOT NULL,
    "previousScanId" TEXT NOT NULL,
    "leftoverCount" INTEGER NOT NULL,
    "state" "AppRemovalState" NOT NULL DEFAULT 'REMOVED',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stateChangedAt" TIMESTAMP(3),

    CONSTRAINT "AppRemoval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppRemoval_shopId_detectedAt_idx" ON "AppRemoval"("shopId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppRemoval_shopId_themeId_appName_detectedScanId_key" ON "AppRemoval"("shopId", "themeId", "appName", "detectedScanId");

-- AddForeignKey
ALTER TABLE "AppRemoval" ADD CONSTRAINT "AppRemoval_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

