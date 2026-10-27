-- Menu-label injection finding (gc-7gjj.1).
--
-- New FindingType value MENU_INJECTION: a navigation menu item's title or URL
-- holds code that can run in shoppers' browsers. Additive only.
-- Enum values cannot be dropped in Postgres, so the value stays on a rollback.
-- It is only harmless once NO Finding row uses it: a build older than this
-- one cannot read such a row. Before rolling back, delete those rows
-- (DELETE FROM "Finding" WHERE "findingType" = 'MENU_INJECTION';), which is
-- also what turning MENU_INJECTION_LIVE_ENABLED off is meant to precede.

-- AlterEnum
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'MENU_INJECTION';
