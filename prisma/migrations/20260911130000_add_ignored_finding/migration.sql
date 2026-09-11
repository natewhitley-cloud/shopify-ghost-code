-- CreateEnum
CREATE TYPE "IgnoreScope" AS ENUM ('INSTANCE', 'APP');

-- CreateTable
CREATE TABLE "IgnoredFinding" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "scope" "IgnoreScope" NOT NULL,
    "fingerprint" TEXT,
    "appName" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgnoredFinding_pkey" PRIMARY KEY ("id"),
    -- Exactly one of fingerprint (INSTANCE scope) / appName (APP scope) must be
    -- set. XOR guards against a malformed row (both null or both set) that would
    -- otherwise suppress unintended findings. Prisma's schema cannot express a
    -- CHECK, so this lives only in the migration (see IgnoredFinding in schema.prisma).
    CONSTRAINT "IgnoredFinding_scope_key_check" CHECK (("fingerprint" IS NOT NULL) <> ("appName" IS NOT NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "IgnoredFinding_shopId_fingerprint_key" ON "IgnoredFinding"("shopId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "IgnoredFinding_shopId_appName_key" ON "IgnoredFinding"("shopId", "appName");

-- CreateIndex
CREATE INDEX "IgnoredFinding_shopId_idx" ON "IgnoredFinding"("shopId");

-- AddForeignKey
ALTER TABLE "IgnoredFinding" ADD CONSTRAINT "IgnoredFinding_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
