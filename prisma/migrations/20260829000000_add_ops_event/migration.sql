-- CreateTable
CREATE TABLE "OpsEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "key" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsEvent_eventType_createdAt_idx" ON "OpsEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "OpsEvent_key_createdAt_idx" ON "OpsEvent"("key", "createdAt");
