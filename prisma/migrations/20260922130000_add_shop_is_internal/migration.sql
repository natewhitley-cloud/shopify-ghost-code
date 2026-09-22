-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the only remaining internal store (the operator's dev store). The
-- other test stores were redacted 2026-09-22 (gc-qkd).
UPDATE "Shop" SET "isInternal" = true WHERE "domain" = 'nw-dev-store-2.myshopify.com';
