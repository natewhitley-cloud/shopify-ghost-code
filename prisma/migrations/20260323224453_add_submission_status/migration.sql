-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "SignatureSubmission" ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "SignatureSubmission_status_idx" ON "SignatureSubmission"("status");
