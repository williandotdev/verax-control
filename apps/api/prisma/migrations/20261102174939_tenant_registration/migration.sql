-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "cnpj" VARCHAR(14),
ADD COLUMN     "escalationEmail" VARCHAR(254),
ADD COLUMN     "escalationName" VARCHAR(120),
ADD COLUMN     "escalationPhone" VARCHAR(20),
ADD COLUMN     "plan" VARCHAR(60);


-- CreateIndex
CREATE UNIQUE INDEX "Tenant_cnpj_key" ON "Tenant"("cnpj");


