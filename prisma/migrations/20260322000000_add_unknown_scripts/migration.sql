-- CreateTable
CREATE TABLE "UnknownScript" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "codeSnippet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnknownScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureSubmission" (
    "id" TEXT NOT NULL,
    "unknownScriptId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "suggestedAppName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnknownScript_scanId_idx" ON "UnknownScript"("scanId");

-- CreateIndex
CREATE INDEX "SignatureSubmission_unknownScriptId_idx" ON "SignatureSubmission"("unknownScriptId");

-- AddForeignKey
ALTER TABLE "UnknownScript" ADD CONSTRAINT "UnknownScript_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureSubmission" ADD CONSTRAINT "SignatureSubmission_unknownScriptId_fkey" FOREIGN KEY ("unknownScriptId") REFERENCES "UnknownScript"("id") ON DELETE CASCADE ON UPDATE CASCADE;
