-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('GHOST_SCRIPT', 'GHOST_STYLE', 'GHOST_SNIPPET', 'GHOST_SECTION', 'ORPHAN_ASSET');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AppPresence" AS ENUM ('INSTALLED', 'REMOVED');

-- CreateEnum
CREATE TYPE "AuditRunStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "lastThemePublishAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "themeName" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "findingCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "codeSnippet" TEXT NOT NULL,
    "findingType" "FindingType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "appName" TEXT,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstalledApp" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyAppId" TEXT NOT NULL,
    "appHandle" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "appDescription" TEXT,
    "publicCategory" TEXT,
    "presence" "AppPresence" NOT NULL DEFAULT 'INSTALLED',
    "grantedScopes" TEXT NOT NULL DEFAULT '[]',
    "grantedScopeCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "hasActiveSubscription" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InstalledApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionSnapshot" (
    "id" TEXT NOT NULL,
    "installedAppId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "grantedScopes" TEXT NOT NULL,
    "scopeCount" INTEGER NOT NULL,
    "unexpectedScopeCount" INTEGER NOT NULL DEFAULT 0,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionAuditRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" "AuditRunStatus" NOT NULL DEFAULT 'PENDING',
    "appCount" INTEGER NOT NULL DEFAULT 0,
    "totalRiskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionAuditRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Scan_shopId_createdAt_idx" ON "Scan"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Finding_scanId_idx" ON "Finding"("scanId");

-- CreateIndex
CREATE INDEX "Finding_severity_idx" ON "Finding"("severity");

-- CreateIndex
CREATE INDEX "InstalledApp_shopId_idx" ON "InstalledApp"("shopId");

-- CreateIndex
CREATE INDEX "InstalledApp_presence_idx" ON "InstalledApp"("presence");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledApp_shopId_shopifyAppId_key" ON "InstalledApp"("shopId", "shopifyAppId");

-- CreateIndex
CREATE INDEX "PermissionSnapshot_installedAppId_idx" ON "PermissionSnapshot"("installedAppId");

-- CreateIndex
CREATE INDEX "PermissionSnapshot_auditRunId_idx" ON "PermissionSnapshot"("auditRunId");

-- CreateIndex
CREATE INDEX "PermissionAuditRun_shopId_createdAt_idx" ON "PermissionAuditRun"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledApp" ADD CONSTRAINT "InstalledApp_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionSnapshot" ADD CONSTRAINT "PermissionSnapshot_installedAppId_fkey" FOREIGN KEY ("installedAppId") REFERENCES "InstalledApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionSnapshot" ADD CONSTRAINT "PermissionSnapshot_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "PermissionAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionAuditRun" ADD CONSTRAINT "PermissionAuditRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

