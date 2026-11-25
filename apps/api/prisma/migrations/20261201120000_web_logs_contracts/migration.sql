-- Ataques web pelos logs de acesso do ALB (PR-3 do desenho de 24/11/2026): os contratos.
--
-- 1. A nota `aws_cost_alb_logs` das fontes: o balanceador com o log de acesso desligado passa a aparecer, com o aviso de que
--    ligar tem custo na AWS. Só no nó com `AWS_WEB_LOGS_ENABLED` ligado.
-- 2. `WebSourceEstimate`: a estimativa de volume de um balanceador, pedida pelo painel antes da autorização e calculada pelo
--    worker. Uma por fonte: o pedido pendente e o último resultado. Só contagens, nenhum dado de log.
--
-- Só acrescenta: um valor a mais num CHECK (o Postgres não altera um CHECK: ele sai e volta igual, com o valor a mais, na
-- mesma transação; toda linha que valia continua valendo) e uma tabela nova, com as chaves em cascata. A imagem anterior do nó
-- continua funcionando neste esquema:
--   - ela não conhece a nota: a resposta da API deixa de fora a que não conhece, e a descoberta dela regrava as dela;
--   - ela não conhece a tabela: apaga fonte, conta e cliente como antes, e a cascata leva a estimativa junto.
--
-- Numa transação só (BEGIN e COMMIT): o `prisma migrate deploy` não abre uma por arquivo. As migrations rodam com a API e o
-- worker parados (`infra/node/bin/start.sh`).
BEGIN;

-- AlterTable
ALTER TABLE "AwsSource" DROP CONSTRAINT "AwsSource_discovery_check";
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_discovery_check" CHECK (
  "availability" IN ('available', 'not_enabled', 'no_destination', 'unsupported_destination', 'unsupported_format')
  AND ("loggingState" IS NULL OR "loggingState" IN ('logging', 'stopped', 'enabled', 'disabled', 'publishing'))
  AND "permission" IN ('granted', 'missing', 'unknown')
  AND ("permissionDetail" IS NULL OR "permissionDetail" ~ '^[A-Za-z0-9_:-]{1,96}$')
  AND jsonb_typeof("details") = 'object'
  AND "notes" <@ ARRAY[
    'aws_cost_guardduty', 'aws_cost_security_hub', 'aws_cost_inspector', 'aws_cost_access_analyzer',
    'aws_cost_new_trail', 'aws_cost_flow_logs', 'aws_cost_waf_logging', 'high_volume', 'tag_required',
    'stack_update_required', 'additional_bucket_required', 'central_bucket', 'covered_by_api', 'covered_by_legacy',
    'recommended', 'not_security_events', 'not_collected_yet', 'flow_logs_read_together', 'aws_cost_alb_logs'
  ]::text[]
);

-- CreateTable
CREATE TABLE "WebSourceEstimate" (
    "sourceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3),
    "requestedBy" VARCHAR(64),
    "lastRequestAt" TIMESTAMPTZ(3) NOT NULL,
    "status" VARCHAR(16),
    "computedAt" TIMESTAMPTZ(3),
    "day" DATE,
    "objects" INTEGER,
    "sampledObjects" INTEGER,
    "bytesPerDay" BIGINT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebSourceEstimate_pkey" PRIMARY KEY ("sourceId","tenantId")
);

-- CreateIndex
CREATE INDEX "WebSourceEstimate_tenantId_idx" ON "WebSourceEstimate"("tenantId");

-- CreateIndex
CREATE INDEX "WebSourceEstimate_requestedAt_idx" ON "WebSourceEstimate"("requestedAt");

-- AddForeignKey
ALTER TABLE "WebSourceEstimate" ADD CONSTRAINT "WebSourceEstimate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebSourceEstimate" ADD CONSTRAINT "WebSourceEstimate_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- O resultado: nenhum ainda, com o volume por dia, sem amostra ou com o motivo da falha. Só o `ready` tem volume, e só ele.
ALTER TABLE "WebSourceEstimate" ADD CONSTRAINT "WebSourceEstimate_values_check" CHECK (
  ("status" IS NULL) = ("computedAt" IS NULL)
  AND ("status" IS NULL OR "status" IN ('ready', 'no_sample', 'failed'))
  AND (("bytesPerDay" IS NOT NULL) = ("status" IS NOT DISTINCT FROM 'ready'))
  AND (("errorCode" IS NOT NULL) = ("status" IS NOT DISTINCT FROM 'failed'))
  AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Za-z0-9_.:-]{1,64}$')
  AND ("status" IS NULL OR "status" = 'failed' OR ("day" IS NOT NULL AND "objects" IS NOT NULL))
  AND ("bytesPerDay" IS NULL OR ("bytesPerDay" >= 0 AND "bytesPerDay" <= 9007199254740991))
  AND ("objects" IS NULL OR "objects" >= 0)
  AND ("sampledObjects" IS NULL OR ("objects" IS NOT NULL AND "sampledObjects" BETWEEN 0 AND "objects"))
  AND ("requestedBy" IS NULL OR btrim("requestedBy") <> '')
);

COMMIT;
