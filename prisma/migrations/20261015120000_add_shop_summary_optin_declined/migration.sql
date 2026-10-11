-- gc-xorg: Home's one-time summary-email opt-in prompt for shops paid before
-- gc-ol95 shipped.
--   Shop.summaryOptInDeclinedAt  nullable TIMESTAMP, no default: the merchant
--     chose "No thanks" (stamped once). NULL = never declined. No backfill:
--     every existing shop starts undecided.
--
-- Additive and reversible:
--   ALTER TABLE "Shop" DROP COLUMN "summaryOptInDeclinedAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "summaryOptInDeclinedAt" TIMESTAMP(3);
