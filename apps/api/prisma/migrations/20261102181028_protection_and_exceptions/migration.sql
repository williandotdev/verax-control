-- CreateEnum
CREATE TYPE "ProtectedResourceType" AS ENUM ('aws_account', 'iam_user', 'iam_role', 'access_key', 'ec2_instance', 's3_bucket', 'security_group', 'ip_address');

-- CreateEnum
CREATE TYPE "AlertExceptionField" AS ENUM ('user', 'ip', 'resource');

-- CreateTable
CREATE TABLE "ProtectedResource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "ProtectedResourceType" NOT NULL,
    "identifier" VARCHAR(600) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProtectedResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ruleId" VARCHAR(6) NOT NULL,
    "field" "AlertExceptionField" NOT NULL,
    "value" VARCHAR(256) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AlertException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedResource_tenantId_type_identifier_key" ON "ProtectedResource"("tenantId", "type", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "AlertException_tenantId_ruleId_field_value_key" ON "AlertException"("tenantId", "ruleId", "field", "value");

-- AddForeignKey
ALTER TABLE "ProtectedResource" ADD CONSTRAINT "ProtectedResource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectedResource" ADD CONSTRAINT "ProtectedResource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertException" ADD CONSTRAINT "AlertException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertException" ADD CONSTRAINT "AlertException_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

