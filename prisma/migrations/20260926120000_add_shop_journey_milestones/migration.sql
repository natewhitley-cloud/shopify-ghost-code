-- gc-dpm.1: durable journey milestones on Shop. Stamped once, going forward,
-- by the app (firstOpenedAt on the first authenticated app load,
-- firstResultsViewedAt on the first load of a successful scan's detail page).
--
-- Additive and reversible (nullable, no default):
--   ALTER TABLE "Shop" DROP COLUMN "firstOpenedAt", DROP COLUMN "firstResultsViewedAt";
--
-- BACKFILL (deterministic, runs once on deploy, fills NULL columns only):
--   firstOpenedAt        = LEAST(earliest page_visit for the shop's domain,
--                                "lastSeenAt",
--                                earliest Scan.createdAt for the shop).
--                          Postgres LEAST ignores NULL arguments and returns
--                          NULL only when all three are NULL. Any scan implies
--                          the app was opened: MANUAL scans are merchant-started,
--                          and SCHEDULED / AUTO_PUBLISH scans run only for paid
--                          plans, which are chosen inside the app.
--   firstResultsViewedAt = earliest page_visit for the shop's domain whose
--                          metadata.path is a scan DETAIL page: LIKE
--                          '/app/scans/_%' needs at least one character after
--                          '/app/scans/' ('_' is LIKE's one-character wildcard),
--                          so the '/app/scans' index (and '/app/scans/') never
--                          match, while /app/scans/<id>, /app/scans/<id>/diff and
--                          /app/scans/<id>/export do (the same routes the digest's
--                          normalizeActivityPath collapses to /app/scans/:id...).
--                          A page_visit does not record the scan's status, so a
--                          visit to a failed scan's page also counts here (the
--                          app's going-forward stamp requires COMPLETED/PARTIAL).
--
-- LIMITATION: page_visit rows are pruned after 14 days (pruneOpsEvents), so for
-- a shop whose history predates that window the page_visit terms are unknown:
-- firstOpenedAt falls back to lastSeenAt / the first scan (the true first open
-- may be earlier), and firstResultsViewedAt stays NULL (unknown, not "never").
--
-- page_visit rows are keyed on the shop domain (OpsEvent.key) and store the
-- concrete path in the JSONB "metadata" column as {"path": "..."}, so
-- metadata->>'path' reads it as text.

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "firstOpenedAt" TIMESTAMP(3),
ADD COLUMN     "firstResultsViewedAt" TIMESTAMP(3);

-- Backfill firstOpenedAt
UPDATE "Shop" AS s
SET "firstOpenedAt" = LEAST(
    (SELECT MIN(e."createdAt")
       FROM "OpsEvent" AS e
      WHERE e."eventType" = 'page_visit'
        AND e."key" = s."domain"),
    s."lastSeenAt",
    (SELECT MIN(sc."createdAt")
       FROM "Scan" AS sc
      WHERE sc."shopId" = s."id")
)
WHERE s."firstOpenedAt" IS NULL;

-- Backfill firstResultsViewedAt
UPDATE "Shop" AS s
SET "firstResultsViewedAt" = (
    SELECT MIN(e."createdAt")
      FROM "OpsEvent" AS e
     WHERE e."eventType" = 'page_visit'
       AND e."key" = s."domain"
       AND e."metadata"->>'path' LIKE '/app/scans/_%'
)
WHERE s."firstResultsViewedAt" IS NULL;
