-- O log de acesso do ALB ligado pelo painel (a pilha do papel de leitura com `EnableAlbAccessLogs`).
--
-- `WebAlbLogging`: uma linha por balanceador, com o pedido pendente (ligar ou desligar), o último resultado que o worker
-- gravou e, enquanto o log que a Verax ligou continua como ela o deixou (`enabledByVerax`), o destino que ela usou e os
-- atributos de antes. Só configuração: nenhum dado de log. O "Desligar" do painel só vale para o que a Verax ligou.
--
-- Só acrescenta: uma tabela nova, com as chaves em cascata. A imagem anterior do nó continua funcionando neste esquema: ela
-- não conhece a tabela, e apaga fonte, conta e cliente como antes (a cascata leva a linha junto).
--
-- Numa transação só (BEGIN e COMMIT): o `prisma migrate deploy` não abre uma por arquivo. As migrations rodam com a API e o
-- worker parados (`infra/node/bin/start.sh`).
BEGIN;

-- CreateTable
CREATE TABLE "WebAlbLogging" (
    "sourceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "pending" VARCHAR(8),
    "requestedAt" TIMESTAMPTZ(3),
    "requestedBy" VARCHAR(64),
    "lastAction" VARCHAR(8),
    "status" VARCHAR(16),
    "errorCode" VARCHAR(32),
    "completedAt" TIMESTAMPTZ(3),
    "enabledByVerax" BOOLEAN NOT NULL DEFAULT false,
    "loadBalancerArn" VARCHAR(256),
    "bucket" VARCHAR(63),
    "prefix" VARCHAR(512),
    "enabledAt" TIMESTAMPTZ(3),
    "enabledBy" VARCHAR(64),
    "previousEnabled" BOOLEAN,
    "previousBucket" VARCHAR(63),
    "previousPrefix" VARCHAR(512),
    "disabledAt" TIMESTAMPTZ(3),
    "disabledBy" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebAlbLogging_pkey" PRIMARY KEY ("sourceId","tenantId")
);

-- CreateIndex
CREATE INDEX "WebAlbLogging_tenantId_idx" ON "WebAlbLogging"("tenantId");

-- CreateIndex
CREATE INDEX "WebAlbLogging_requestedAt_idx" ON "WebAlbLogging"("requestedAt");

-- AddForeignKey
ALTER TABLE "WebAlbLogging" ADD CONSTRAINT "WebAlbLogging_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAlbLogging" ADD CONSTRAINT "WebAlbLogging_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- O pedido e o resultado: os valores conhecidos; o pedido pendente com quando e quem; o motivo só na falha; a marca de que a
-- Verax ligou só com o destino e o balanceador dela; e o destino da Verax sempre sem prefixo.
ALTER TABLE "WebAlbLogging" ADD CONSTRAINT "WebAlbLogging_values_check" CHECK (
  ("pending" IS NULL OR "pending" IN ('enable', 'disable'))
  AND (("pending" IS NULL) = ("requestedAt" IS NULL))
  AND ("pending" IS NULL OR "requestedBy" IS NOT NULL)
  AND ("requestedBy" IS NULL OR btrim("requestedBy") <> '')
  AND ("lastAction" IS NULL OR "lastAction" IN ('enable', 'disable'))
  AND ("status" IS NULL OR "status" IN ('enabled', 'already_enabled', 'disabled', 'released', 'failed'))
  AND (("status" IS NULL) = ("completedAt" IS NULL))
  AND (("status" IS NULL) = ("lastAction" IS NULL))
  AND (("errorCode" IS NOT NULL) = ("status" IS NOT DISTINCT FROM 'failed'))
  AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z_]{1,32}$')
  AND (NOT "enabledByVerax" OR ("bucket" IS NOT NULL AND "loadBalancerArn" IS NOT NULL AND "enabledAt" IS NOT NULL))
  AND (NOT "enabledByVerax" OR "prefix" = '')
);

COMMIT;
