-- Medidor e saúde da ingestão do Wazuh do nó (fase 2, PR-V6). Duas tabelas novas, nada muda nas existentes:
-- - `WazuhCounter`: os contadores do analysisd na última leitura da tarefa `wazuh-usage` do worker (a base da
--   diferença). Dado de sistema, do nó inteiro, sem `tenantId`;
-- - `IngestHealth`: por cliente e fonte, a última vez que o contador de eventos andou (a Torre mostra "Sem logs novos
--   da AWS" com ele). Dado do cliente, no escopo dele.

-- CreateTable
CREATE TABLE "WazuhCounter" (
    "id" VARCHAR(32) NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "bytesReceived" BIGINT NOT NULL,
    "awsEvents" BIGINT NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL,
    "meterBlocked" VARCHAR(32),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WazuhCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestHealth" (
    "tenantId" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "lastProgressAt" TIMESTAMPTZ(3),
    "stallNotifiedFor" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IngestHealth_pkey" PRIMARY KEY ("tenantId","source")
);

-- AddForeignKey
ALTER TABLE "IngestHealth" ADD CONSTRAINT "IngestHealth_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Regras que o Prisma não descreve: os contadores do analysisd nunca são negativos; o motivo de não medir é só o
-- conhecido; a saúde só existe para a fonte `aws` (a única com contador hoje), e a parada avisada é sempre a parada
-- em curso ou uma anterior (nunca uma depois da última vez que o contador andou).
ALTER TABLE "WazuhCounter" ADD CONSTRAINT "WazuhCounter_counters_check"
  CHECK ("bytesReceived" >= 0 AND "awsEvents" >= 0);
ALTER TABLE "WazuhCounter" ADD CONSTRAINT "WazuhCounter_meter_blocked_check"
  CHECK ("meterBlocked" IS NULL OR "meterBlocked" = 'multiple_tenants');
ALTER TABLE "IngestHealth" ADD CONSTRAINT "IngestHealth_source_check" CHECK ("source" = 'aws');
ALTER TABLE "IngestHealth" ADD CONSTRAINT "IngestHealth_stall_notice_check"
  CHECK ("stallNotifiedFor" IS NULL OR ("lastProgressAt" IS NOT NULL AND "stallNotifiedFor" <= "lastProgressAt"));
