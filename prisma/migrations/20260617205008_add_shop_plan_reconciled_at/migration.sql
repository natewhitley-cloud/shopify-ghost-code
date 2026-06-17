-- CMP-2 / GC-fur: add Shop.planReconciledAt to support on-load plan
-- reconciliation against Shopify (corrects webhook drift).
--
-- planReconciledAt records the last time `plan` was reconciled against Shopify's
-- active subscriptions (or refreshed by an APP_SUBSCRIPTIONS_UPDATE webhook).
-- Null = never reconciled. Drives the app-load freshness guard.
--
-- Reversibility / rollback:
--   This is an additive, nullable column with no default and no backfill, so it
--   is fully reversible with no data loss for existing rows:
--       ALTER TABLE "Shop" DROP COLUMN "planReconciledAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "planReconciledAt" TIMESTAMP(3);
