/*
  Warnings:

  - You are about to drop the `InstalledApp` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PermissionAuditRun` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PermissionSnapshot` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "InstalledApp" DROP CONSTRAINT "InstalledApp_shopId_fkey";

-- DropForeignKey
ALTER TABLE "PermissionAuditRun" DROP CONSTRAINT "PermissionAuditRun_shopId_fkey";

-- DropForeignKey
ALTER TABLE "PermissionSnapshot" DROP CONSTRAINT "PermissionSnapshot_auditRunId_fkey";

-- DropForeignKey
ALTER TABLE "PermissionSnapshot" DROP CONSTRAINT "PermissionSnapshot_installedAppId_fkey";

-- DropTable
DROP TABLE "InstalledApp";

-- DropTable
DROP TABLE "PermissionAuditRun";

-- DropTable
DROP TABLE "PermissionSnapshot";

-- DropEnum
DROP TYPE "AppPresence";

-- DropEnum
DROP TYPE "AuditRunStatus";
