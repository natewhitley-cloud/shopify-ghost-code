-- gc-rxq0: retire Home's summary-email opt-in prompt (gc-xorg) 14 days after
-- it was first shown, so a merchant who never answers it can still see the
-- feedback nudge below it.
--   Shop.summaryOptInFirstShownAt  nullable TIMESTAMP, no default: when the
--     prompt first rendered (stamped once). NULL = never shown. No backfill:
--     every existing shop's 14 days start at its next render.
--
-- Additive and reversible:
--   ALTER TABLE "Shop" DROP COLUMN "summaryOptInFirstShownAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "summaryOptInFirstShownAt" TIMESTAMP(3);
