-- Audit fixes (batch E): additive Shop columns only. No drop, no rename.
--
-- gc-97k.7 review popup result handling and server-side attempt accounting:
--   reviewPopupRetryAfter:     a RETRYABLE result's backoff; no request before it.
--   reviewPopupAttemptCount:   attempts recorded by the loader BEFORE the client
--                              asks (5 = no more requests). NOT NULL DEFAULT 0,
--                              so existing rows read 0 (no separate backfill).
--   reviewPopupLastAttemptAt:  when the last attempt was recorded (a new one
--                              needs 24h+, so a lost report retries after 24h).
--   reviewPopupLastResult:     the last reported result code (digest: tells a
--                              displayed popup from a declined one).
--   reviewPopupRequestedAt (existing) now means a TERMINAL result.
--
-- Reversible:
--   ALTER TABLE "Shop" DROP COLUMN "reviewPopupRetryAfter",
--     DROP COLUMN "reviewPopupAttemptCount", DROP COLUMN "reviewPopupLastAttemptAt",
--     DROP COLUMN "reviewPopupLastResult";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "reviewPopupAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewPopupLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "reviewPopupLastResult" TEXT,
ADD COLUMN     "reviewPopupRetryAfter" TIMESTAMP(3);
