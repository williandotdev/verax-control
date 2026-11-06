-- Cofre de credenciais do nó (fase 2, PR-V1): a chave de acesso do usuário IAM de leitura da AWS e o token do
-- Cloudflare, uma linha por conta cloud, cifrados com a chave pública do nó (RSA-OAEP-SHA256). Nenhum dado existente
-- muda; a tabela nasce vazia (a tela que grava vem no PR-V3).

-- CreateEnum
CREATE TYPE "CloudCredentialKind" AS ENUM ('aws_access_key', 'cloudflare_api_token');

-- CreateTable
CREATE TABLE "CloudCredential" (
    "cloudAccountId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "CloudCredentialKind" NOT NULL,
    "ciphertext" VARCHAR(1024) NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "keyIdSuffix" VARCHAR(4) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "rotationNoticeAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudCredential_pkey" PRIMARY KEY ("cloudAccountId")
);

-- CreateIndex
CREATE INDEX "CloudCredential_tenantId_idx" ON "CloudCredential"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudCredential_cloudAccountId_tenantId_key" ON "CloudCredential"("cloudAccountId", "tenantId");

-- A chave estrangeira da credencial leva a conta e o cliente juntos: uma credencial com o cliente A na conta do
-- cliente B não entra, nem por um erro da aplicação. O índice é só o alvo dela (o `id` sozinho já é único).
-- CreateIndex
CREATE UNIQUE INDEX "CloudAccount_id_tenantId_key" ON "CloudAccount"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_cloudAccountId_tenantId_fkey" FOREIGN KEY ("cloudAccountId", "tenantId") REFERENCES "CloudAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Regras que o Prisma não descreve: a versão da chave começa em 1; o sufixo são 4 letras ou números (o fim do ID da
-- chave ou do token, nunca do segredo); o texto cifrado é o envelope `v<versão>:<base64>`, e a versão do envelope é
-- a da coluna (a recifragem troca as duas juntas).
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_keyVersion_check" CHECK ("keyVersion" >= 1);
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_keyIdSuffix_check"
  CHECK ("keyIdSuffix" ~ '^[A-Za-z0-9]{4}$');
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_ciphertext_check"
  CHECK ("ciphertext" ~ '^v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$'
    AND split_part("ciphertext", ':', 1) = 'v' || "keyVersion");
