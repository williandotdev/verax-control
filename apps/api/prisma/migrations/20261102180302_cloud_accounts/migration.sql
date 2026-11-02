-- CreateEnum
CREATE TYPE "CloudAccountStatus" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "CloudAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL DEFAULT 'aws',
    "accountId" VARCHAR(12) NOT NULL,
    "regions" TEXT[],
    "externalId" VARCHAR(128) NOT NULL,
    "cloudtrailBucket" VARCHAR(63),
    "guarddutyBucket" VARCHAR(63),
    "wafBucket" VARCHAR(63),
    "status" "CloudAccountStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloudAccount_accountId_key" ON "CloudAccount"("accountId");

-- CreateIndex
CREATE INDEX "CloudAccount_tenantId_idx" ON "CloudAccount"("tenantId");

-- AddForeignKey
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

