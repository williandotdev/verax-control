-- Medidor de uso (fase 2, PR-03): volume de log lido por cliente, mês do calendário de Brasília e fonte. É a medida
-- dos GiB por mês do plano e fica como evidência de cobrança.

-- CreateTable
CREATE TABLE "IngestUsage" (
    "tenantId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "bytes" BIGINT NOT NULL,
    "events" BIGINT NOT NULL,

    CONSTRAINT "IngestUsage_pkey" PRIMARY KEY ("tenantId","month","source")
);

-- AddForeignKey
ALTER TABLE "IngestUsage" ADD CONSTRAINT "IngestUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Regras que o Prisma não descreve: o mês é sempre o primeiro dia (uma linha por mês, nunca uma por dia) e os
-- contadores só somam, então nunca ficam negativos.
ALTER TABLE "IngestUsage" ADD CONSTRAINT "IngestUsage_month_first_day_check"
  CHECK (EXTRACT(DAY FROM "month") = 1);
ALTER TABLE "IngestUsage" ADD CONSTRAINT "IngestUsage_counters_check" CHECK ("bytes" >= 0 AND "events" >= 0);
