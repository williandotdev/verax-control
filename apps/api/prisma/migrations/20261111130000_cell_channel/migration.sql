-- Canal entre o plano de controle e a célula (CE-05). No nó dedicado as três tabelas ficam vazias.
--
-- 1. `CellTenantState`: o que o comando `tenant.upsert` gravou de cada cliente (a geração aplicada, o id do cliente no
--    plano de controle e o resto do estado desejado), a pausa da coleta e a exportação gravada.
-- 2. `TenantCloudIdentity`: a conta de serviço `vxt-<slug>` do cliente. Uma por cliente e um cliente por conta.
-- 3. `CellReport`: a caixa de saída dos relatórios, gravada na mesma transação do que eles relatam.
--
-- Só o sistema grava as duas primeiras (o escopo do cliente recusa, `SYSTEM_WRITTEN_MODELS`); os CHECKs repetem no
-- banco os formatos do contrato (`packages/shared/src/cell-protocol.ts`).

-- CreateTable
CREATE TABLE "CellTenantState" (
    "tenantId" UUID NOT NULL,
    "controlPlaneId" VARCHAR(26) NOT NULL,
    "generation" INTEGER NOT NULL,
    "appliedAt" TIMESTAMPTZ(3) NOT NULL,
    "desired" JSONB NOT NULL,
    "collectionPausedAt" TIMESTAMPTZ(3),
    "collectionPauseReason" VARCHAR(32),
    "exportId" VARCHAR(26),
    "exportReadyAt" TIMESTAMPTZ(3),
    "exportObject" VARCHAR(200),
    "exportSha256" CHAR(64),
    "exportBytes" BIGINT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CellTenantState_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "TenantCloudIdentity" (
    "tenantId" UUID NOT NULL,
    "saEmail" VARCHAR(254) NOT NULL,
    "saUniqueId" VARCHAR(21) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TenantCloudIdentity_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "CellReport" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CellReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CellTenantState_controlPlaneId_key" ON "CellTenantState"("controlPlaneId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantCloudIdentity_saEmail_key" ON "TenantCloudIdentity"("saEmail");

-- CreateIndex
CREATE UNIQUE INDEX "TenantCloudIdentity_saUniqueId_key" ON "TenantCloudIdentity"("saUniqueId");

-- CreateIndex
CREATE INDEX "CellReport_publishedAt_nextAttemptAt_idx" ON "CellReport"("publishedAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "CellTenantState" ADD CONSTRAINT "CellTenantState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantCloudIdentity" ADD CONSTRAINT "TenantCloudIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- O id do cliente no plano de controle é um ULID; a geração começa em 1.
ALTER TABLE "CellTenantState" ADD CONSTRAINT "CellTenantState_controlPlaneId_format"
  CHECK ("controlPlaneId" ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "CellTenantState" ADD CONSTRAINT "CellTenantState_generation_check" CHECK ("generation" >= 1);
-- O motivo da pausa vai só com a pausa, e é um dos conhecidos (`COLLECTION_PAUSE_REASONS`).
ALTER TABLE "CellTenantState" ADD CONSTRAINT "CellTenantState_pause_check" CHECK (
  ("collectionPausedAt" IS NULL AND "collectionPauseReason" IS NULL)
  OR ("collectionPausedAt" IS NOT NULL AND "collectionPauseReason" IN ('runaway_volume', 'owner'))
);
-- A exportação gravada vem inteira (pedido, instante, objeto, SHA-256 e tamanho) ou não vem.
ALTER TABLE "CellTenantState" ADD CONSTRAINT "CellTenantState_export_check" CHECK (
  ("exportId" IS NULL AND "exportReadyAt" IS NULL AND "exportObject" IS NULL AND "exportSha256" IS NULL
    AND "exportBytes" IS NULL)
  OR ("exportId" ~ '^[0-9A-HJKMNP-TV-Z]{26}$' AND "exportReadyAt" IS NOT NULL AND "exportObject" IS NOT NULL
    AND "exportSha256" ~ '^[0-9a-f]{64}$' AND "exportBytes" >= 0)
);

-- A conta de serviço do cliente (`vxt-<slug>@<projeto>.iam.gserviceaccount.com`) e o ID único dela (21 dígitos).
ALTER TABLE "TenantCloudIdentity" ADD CONSTRAINT "TenantCloudIdentity_saEmail_format"
  CHECK ("saEmail" ~ '^vxt-[a-z0-9-]{3,16}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$');
ALTER TABLE "TenantCloudIdentity" ADD CONSTRAINT "TenantCloudIdentity_saUniqueId_format"
  CHECK ("saUniqueId" ~ '^[0-9]{21}$');
