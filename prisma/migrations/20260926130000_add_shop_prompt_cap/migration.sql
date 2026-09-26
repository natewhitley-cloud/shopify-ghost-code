-- gc-97k.6: cross-prompt frequency cap state on Shop. lastPromptKey is the
-- interruptive prompt that last opened the shop's 24h prompt window and
-- lastPromptShownAt is when. Written by the app (claimPromptSlot); no backfill:
-- NULL means no prompt has been shown since this shipped, so the first eligible
-- prompt opens the first window.
--
-- Additive and reversible (nullable, no default):
--   ALTER TABLE "Shop" DROP COLUMN "lastPromptKey", DROP COLUMN "lastPromptShownAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "lastPromptKey" TEXT,
ADD COLUMN     "lastPromptShownAt" TIMESTAMP(3);
