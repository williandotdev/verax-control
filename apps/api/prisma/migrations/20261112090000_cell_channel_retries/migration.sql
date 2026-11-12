-- Canal da célula (CE-05), o que precisa sobreviver a uma queda do worker no meio de um comando:
--
-- 1. `CellPurge`: o registro durável de cada expurgo (`tenant.purge`), pelo `purgeId`, sem chave estrangeira para o
--    cliente (a linha do cliente sai no expurgo; o registro fica). Com ele, a reentrega do comando depois de uma queda
--    entre o fim do expurgo e o relatório emite o `tenant.purged` de novo, em vez de recusar o cliente como desconhecido.
-- 2. `CellTenantBootstrap`: o pedido do primeiro administrador de cada cliente criado pelo canal, gravado na transação
--    do `tenant.upsert` e entregue ao host até ele confirmar (o e-mail é apagado na confirmação).

-- CreateTable
CREATE TABLE "CellPurge" (
    "purgeId" VARCHAR(26) NOT NULL,
    "controlPlaneId" VARCHAR(26) NOT NULL,
    "nodeTenantId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CellPurge_pkey" PRIMARY KEY ("purgeId")
);

-- CreateTable
CREATE TABLE "CellTenantBootstrap" (
    "tenantId" UUID NOT NULL,
    "slug" VARCHAR(16) NOT NULL,
    "adminEmail" VARCHAR(254),
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signaledAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMPTZ(3),

    CONSTRAINT "CellTenantBootstrap_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "CellPurge_controlPlaneId_idx" ON "CellPurge"("controlPlaneId");

-- AddForeignKey
ALTER TABLE "CellTenantBootstrap" ADD CONSTRAINT "CellTenantBootstrap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Os ids do plano de controle são ULIDs; a conclusão não vem antes do começo.
ALTER TABLE "CellPurge" ADD CONSTRAINT "CellPurge_ids_format"
  CHECK ("purgeId" ~ '^[0-9A-HJKMNP-TV-Z]{26}$' AND "controlPlaneId" ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "CellPurge" ADD CONSTRAINT "CellPurge_completed_check"
  CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt");

-- O subdomínio no formato do `TenantHost`; o e-mail fica até a confirmação do host e sai nela.
ALTER TABLE "CellTenantBootstrap" ADD CONSTRAINT "CellTenantBootstrap_slug_format"
  CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,14}[a-z0-9]$' AND substr("slug", 3, 2) <> '--');
ALTER TABLE "CellTenantBootstrap" ADD CONSTRAINT "CellTenantBootstrap_email_check"
  CHECK (("confirmedAt" IS NULL AND "adminEmail" IS NOT NULL) OR ("confirmedAt" IS NOT NULL AND "adminEmail" IS NULL));
