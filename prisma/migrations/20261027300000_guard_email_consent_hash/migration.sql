-- Checkout guard email consent address (gc-1q1s.7 audit fix). Ships dark with
-- the guard: nothing writes it until STOREFRONT_GUARD_EMAIL_ENABLED is "true".
--
-- Additive only, no backfill:
--   Shop.guardEmailConsentHash  nullable TEXT, no default: a SHA-256 prefix of
--                               the lower-cased address Home's one-time notice
--                               named (never the address itself), so guard
--                               email goes only to the consented address.
--
-- Manual rollback:
--   ALTER TABLE "Shop" DROP COLUMN "guardEmailConsentHash";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "guardEmailConsentHash" TEXT;
