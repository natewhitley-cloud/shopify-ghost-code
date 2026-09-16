-- Scan observability & signal capture (docs/specs/scan-observability-signals-spec.md).
--
-- Adds the product / scan-quality telemetry layer that the pipeline currently
-- computes and throws away. Two additive, reversible changes:
--
--   1. ScanDomain — one row per (scanId, domain) capturing the full set of
--      NON-Shopify third-party hosts a theme references (script/stylesheet/
--      preconnect/dns_prefetch/font/ajax), classified as matched-to-an-app,
--      benign public CDN/web-font, or neither (signature-flywheel candidate).
--      Cascades from Scan so a scan delete (or shop/redact cascade) cleans up.
--
--   2. Scan.{newFindingCount,resolvedFindingCount,persistedFindingCount} — the
--      scan-differ new/resolved/unchanged counts vs the prior completed scan.
--      Default 0 correctly backfills every legacy row: no diff was ever computed
--      for them, so they legitimately carry no resolution signal (not "resolved").
--
-- Additive and reversible. To roll back:
--   DROP TABLE "ScanDomain";
--   ALTER TABLE "Scan" DROP COLUMN "persistedFindingCount";
--   ALTER TABLE "Scan" DROP COLUMN "resolvedFindingCount";
--   ALTER TABLE "Scan" DROP COLUMN "newFindingCount";
-- Existing rows default correctly, so no backfill is required for correctness.

-- CreateTable
CREATE TABLE "ScanDomain" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "refCount" INTEGER NOT NULL DEFAULT 0,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "appName" TEXT,
    "benign" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScanDomain_scanId_idx" ON "ScanDomain"("scanId");

-- CreateIndex
CREATE INDEX "ScanDomain_domain_idx" ON "ScanDomain"("domain");

-- AddForeignKey
ALTER TABLE "ScanDomain" ADD CONSTRAINT "ScanDomain_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN "newFindingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Scan" ADD COLUMN "resolvedFindingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Scan" ADD COLUMN "persistedFindingCount" INTEGER NOT NULL DEFAULT 0;
