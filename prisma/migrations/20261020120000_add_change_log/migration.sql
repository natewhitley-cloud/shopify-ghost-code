-- "What changed" change log (gc-rrh.4) + quiet-month all-clear (gc-qafb).
-- One migration for the whole release; the feature ships dark.
--
-- Additive only, no backfill (an existing shop's first post-deploy scan is a
-- baseline):
--   ScanManifest   new table, one row per scan: theme file hashes and
--                  metadata (never file content). Cascades from Scan, so
--                  shop/redact (Shop -> Scan) removes it. No personal data.
--   ScanChangeSet  new table, one row per scan: what changed at that check
--                  (filenames, app names, hostnames; never code). Cascades
--                  from Scan like ScanManifest. No personal data.
--   MerchantAlert.kind  NOT NULL DEFAULT 'summary' (constant default, so a
--                  metadata-only change on a live table): every existing row
--                  is a summary email.
--   Shop.changesTeaser{Shown,Clicked,Converted}At  nullable TIMESTAMPs, no
--                  default (Free teaser funnel stamps).
--
-- Manual rollback:
--   DROP TABLE "ScanChangeSet";
--   DROP TABLE "ScanManifest";
--   ALTER TABLE "MerchantAlert" DROP COLUMN "kind";
--   ALTER TABLE "Shop" DROP COLUMN "changesTeaserShownAt";
--   ALTER TABLE "Shop" DROP COLUMN "changesTeaserClickedAt";
--   ALTER TABLE "Shop" DROP COLUMN "changesTeaserConvertedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "changesTeaserClickedAt" TIMESTAMP(3),
ADD COLUMN     "changesTeaserConvertedAt" TIMESTAMP(3),
ADD COLUMN     "changesTeaserShownAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MerchantAlert" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'summary';

-- CreateTable
CREATE TABLE "ScanManifest" (
    "scanId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fileCount" INTEGER NOT NULL,
    "entries" JSONB NOT NULL,
    "appBlocks" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanManifest_pkey" PRIMARY KEY ("scanId")
);

-- CreateTable
CREATE TABLE "ScanChangeSet" (
    "scanId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "baselineScanId" TEXT,
    "kind" TEXT NOT NULL,
    "checkKind" TEXT NOT NULL,
    "onPublishedTheme" BOOLEAN NOT NULL,
    "themeName" TEXT,
    "themeVersion" TEXT,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "worthALookCount" INTEGER NOT NULL DEFAULT 0,
    "checksRan" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "footnotes" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanChangeSet_pkey" PRIMARY KEY ("scanId")
);

-- CreateIndex
CREATE INDEX "ScanManifest_shopId_themeId_createdAt_idx" ON "ScanManifest"("shopId", "themeId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanChangeSet_shopId_onPublishedTheme_createdAt_idx" ON "ScanChangeSet"("shopId", "onPublishedTheme", "createdAt");

-- AddForeignKey
ALTER TABLE "ScanManifest" ADD CONSTRAINT "ScanManifest_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanChangeSet" ADD CONSTRAINT "ScanChangeSet_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

