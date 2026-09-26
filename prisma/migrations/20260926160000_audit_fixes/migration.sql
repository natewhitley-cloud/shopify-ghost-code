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
-- gc-97k.8 durable ever-paid signal for the free-trial promise:
--   everPaidAt: first time the app saw the shop on a paid plan. Written by the
--               app once (claimShopStamp) whenever reconcileShopPlan observes a
--               paid plan. NULL = never seen paid.
--
-- BACKFILL (deterministic, runs once on deploy, fills NULL rows only):
--   everPaidAt = LEAST(earliest BillingEvent.createdAt for the shop,
--                      NOW() in UTC if the shop's plan is paid right now).
--   Any BillingEvent (upgrade, downgrade, cancellation, reactivation) means the
--   shop has had a paid plan. "Paid right now" is plan IN ('Standard',
--   'Professional'), the same set as isPaidPlan (app/lib/journey-stage.ts); any
--   other value counts as free. Postgres LEAST ignores NULL arguments and
--   returns NULL only when both are NULL, so a never-paid shop stays NULL.
--   NOW() is timestamptz; AT TIME ZONE 'UTC' converts it to the UTC wall-clock
--   timestamp Prisma stores in TIMESTAMP(3) columns.
--
-- Reversible:
--   ALTER TABLE "Shop" DROP COLUMN "reviewPopupRetryAfter",
--     DROP COLUMN "reviewPopupAttemptCount", DROP COLUMN "reviewPopupLastAttemptAt",
--     DROP COLUMN "reviewPopupLastResult", DROP COLUMN "everPaidAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "reviewPopupAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewPopupLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "reviewPopupLastResult" TEXT,
ADD COLUMN     "reviewPopupRetryAfter" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN     "everPaidAt" TIMESTAMP(3);

-- Backfill everPaidAt
UPDATE "Shop" AS s
SET "everPaidAt" = LEAST(
    (SELECT MIN(b."createdAt")
       FROM "BillingEvent" AS b
      WHERE b."shopId" = s."id"),
    CASE WHEN s."plan" IN ('Standard', 'Professional')
         THEN CAST(NOW() AT TIME ZONE 'UTC' AS TIMESTAMP(3))
    END
)
WHERE s."everPaidAt" IS NULL;
