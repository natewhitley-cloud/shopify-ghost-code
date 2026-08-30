-- gc-06e.10: add an indexed `domain` column to UnknownScript so that
-- acceptSubmissionsForDomain can match by an indexed exact-equality on the
-- hostname instead of a non-indexable `url LIKE '%domain%'` substring scan.
--
-- The column is populated at insert time in createUnknownScripts
-- (hostnameFromUrl(url)). Rows created before this migration have NULL and are
-- matched via the legacy contains + JS-refine fallback until a backfill runs.
--
-- Additive and reversible. To roll back:
--   DROP INDEX "UnknownScript_domain_idx";
--   ALTER TABLE "UnknownScript" DROP COLUMN "domain";
-- Existing rows default to NULL (handled by the legacy fallback), so no
-- backfill is required for correctness.

-- AlterTable
ALTER TABLE "UnknownScript" ADD COLUMN "domain" TEXT;

-- CreateIndex
CREATE INDEX "UnknownScript_domain_idx" ON "UnknownScript"("domain");
