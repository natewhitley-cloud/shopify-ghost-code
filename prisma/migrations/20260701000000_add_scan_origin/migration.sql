-- CreateEnum
CREATE TYPE "ScanOrigin" AS ENUM ('MANUAL', 'SCHEDULED', 'AUTO_PUBLISH');

-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "origin" "ScanOrigin" NOT NULL DEFAULT 'MANUAL';

