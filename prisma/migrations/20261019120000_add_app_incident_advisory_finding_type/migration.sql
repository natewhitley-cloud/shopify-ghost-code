-- Affected-app advisory (gc-14x5).
--
-- New FindingType value APP_INCIDENT_ADVISORY: live theme code loads from a
-- host of an app named in a public security incident report. Additive only.
-- Enum values cannot be dropped in Postgres; manual rollback = leave the
-- unused value in place (harmless).

-- AlterEnum
ALTER TYPE "FindingType" ADD VALUE IF NOT EXISTS 'APP_INCIDENT_ADVISORY';
