-- Affected-app advisory (gc-14x5).
--
-- New FindingType value APP_INCIDENT_ADVISORY: live theme code loads from a
-- host of an app named in a public security incident report. Additive only.
-- Enum values cannot be dropped in Postgres, so the value stays on a rollback.
-- It is only harmless once NO Finding row uses it: a build older than this
-- one cannot read such a row. Before rolling back, delete those rows (see
-- docs/runbooks/app-incident-advisory.md, "Rollback").

-- AlterEnum
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'APP_INCIDENT_ADVISORY';
