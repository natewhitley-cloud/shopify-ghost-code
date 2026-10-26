-- Checkout guard, Tier 1 (gc-1q1s.4, gc-1q1s.7). Ships dark: nothing writes
-- these until STOREFRONT_GUARD_LIVE_ENABLED is "true".
--
-- Additive only, no backfill:
--   StorefrontGuardState  new table, one row per checked shop: cached storefront
--                         hosts, last outcome, backoff, the learned new-host
--                         baseline (hostnames only). Cascades from Shop, so
--                         shop/redact removes it. No personal data.
--   StorefrontIncident    new table, one row per (shop, signal): kind, host,
--                         page, fixed label, episode timestamps. Cascades from
--                         Shop. No personal data.
--   Shop.guardEmailNoticeShownAt / guardEmailOffAt  nullable TIMESTAMPs, no
--                         default (incident email consent stamps).
--
-- Manual rollback:
--   DROP TABLE "StorefrontIncident";
--   DROP TABLE "StorefrontGuardState";
--   ALTER TABLE "Shop" DROP COLUMN "guardEmailNoticeShownAt";
--   ALTER TABLE "Shop" DROP COLUMN "guardEmailOffAt";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "guardEmailNoticeShownAt" TIMESTAMP(3),
ADD COLUMN     "guardEmailOffAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StorefrontGuardState" (
    "shopId" TEXT NOT NULL,
    "primaryHost" TEXT,
    "myshopifyHost" TEXT,
    "domainsRefreshedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "lastReadableAt" TIMESTAMP(3),
    "lastRedirectHost" TEXT,
    "consecutiveUnreachable" INTEGER NOT NULL DEFAULT 0,
    "backoffUntil" TIMESTAMP(3),
    "readableChecks" INTEGER NOT NULL DEFAULT 0,
    "baselineHosts" JSONB NOT NULL DEFAULT '{}',
    "recentHostSets" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorefrontGuardState_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "StorefrontIncident" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "host" TEXT,
    "page" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "cleanStreak" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "emailedOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorefrontIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorefrontIncident_shopId_state_idx" ON "StorefrontIncident"("shopId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontIncident_shopId_fingerprint_key" ON "StorefrontIncident"("shopId", "fingerprint");

-- AddForeignKey
ALTER TABLE "StorefrontGuardState" ADD CONSTRAINT "StorefrontGuardState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontIncident" ADD CONSTRAINT "StorefrontIncident_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

