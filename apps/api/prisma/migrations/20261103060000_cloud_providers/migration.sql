-- Contas da GCP e do Cloudflare, além da AWS. Os dados existentes não mudam: toda conta cadastrada até aqui é AWS.

-- CreateEnum
CREATE TYPE "CloudProvider" AS ENUM ('aws', 'gcp', 'cloudflare');

-- O provedor vira enum por conversão (apagar e recriar a coluna, como o Prisma geraria, perderia o valor).
ALTER TABLE "CloudAccount" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "CloudAccount" ALTER COLUMN "provider" TYPE "CloudProvider" USING "provider"::"CloudProvider";
ALTER TABLE "CloudAccount" ALTER COLUMN "provider" SET DEFAULT 'aws';

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN "pubsubSubscription" VARCHAR(255),
ADD COLUMN "zones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "accountId" SET DATA TYPE VARCHAR(32),
ALTER COLUMN "externalId" DROP NOT NULL;

-- O ID passa a ser único por provedor.
DROP INDEX "CloudAccount_accountId_key";
CREATE UNIQUE INDEX "CloudAccount_provider_accountId_key" ON "CloudAccount"("provider", "accountId");

-- Toda conta AWS tem ExternalId: o papel de leitura do conector só aceita quem o apresenta. Fora do schema do
-- Prisma, que não descreve CHECK; a API gera o valor no cadastro.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_aws_externalId_check"
  CHECK ("provider" <> 'aws' OR "externalId" IS NOT NULL);
