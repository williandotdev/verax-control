-- Volume por dia (fase 3, CE-09, célula compartilhada): a medida da franquia da Plataforma em GB/dia.
--
-- 1. `IngestUsageDay`: o volume lido de cada cliente por dia do calendário de Brasília e fonte. O `IngestUsage` (mês)
--    continua como está, para o plano dos nós dedicados e as telas.
-- 2. `AwsVolumeObject`: os objetos da AWS já medidos na origem (tarefa `aws-volume`), um por objeto, pelo hash do bucket
--    e da chave: nenhum objeto conta duas vezes, e o volume da AWS de cada dia é a soma deles.
-- 3. `NodeUsageDay`: contadores do nó por dia, sem cliente (na célula, o `bytes.received` do analysisd vira só a
--    conferência do volume da AWS medido na origem).
-- 4. `CloudAccount.meteredFrom`: o momento da primeira verificação bem-sucedida da conta AWS, de onde o volume medido na
--    origem começa (o histórico anterior nunca é cobrado). As contas já verificadas começam no dia seguinte ao
--    `ingestFrom` (o dia da primeira verificação), à meia-noite UTC.

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "meteredFrom" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "IngestUsageDay" (
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "bytes" BIGINT NOT NULL,
    "events" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IngestUsageDay_pkey" PRIMARY KEY ("tenantId","day","source")
);

-- CreateTable
CREATE TABLE "AwsVolumeObject" (
    "cloudAccountId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "objectHash" CHAR(64) NOT NULL,
    "day" DATE NOT NULL,
    "stream" VARCHAR(16) NOT NULL,
    "compressedBytes" BIGINT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "isizeFallback" BOOLEAN NOT NULL,
    "countedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AwsVolumeObject_pkey" PRIMARY KEY ("cloudAccountId","objectHash")
);

-- CreateTable
CREATE TABLE "NodeUsageDay" (
    "day" DATE NOT NULL,
    "metric" VARCHAR(32) NOT NULL,
    "bytes" BIGINT NOT NULL,
    "events" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NodeUsageDay_pkey" PRIMARY KEY ("day","metric")
);

-- CreateIndex
CREATE INDEX "AwsVolumeObject_tenantId_day_idx" ON "AwsVolumeObject"("tenantId", "day");

-- AddForeignKey
ALTER TABLE "IngestUsageDay" ADD CONSTRAINT "IngestUsageDay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwsVolumeObject" ADD CONSTRAINT "AwsVolumeObject_cloudAccountId_fkey" FOREIGN KEY ("cloudAccountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwsVolumeObject" ADD CONSTRAINT "AwsVolumeObject_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Regras que o Prisma não descreve.
-- As três fontes da franquia, e os contadores nunca negativos.
ALTER TABLE "IngestUsageDay" ADD CONSTRAINT "IngestUsageDay_source_check"
  CHECK ("source" IN ('aws', 'gcp', 'cloudflare'));
ALTER TABLE "IngestUsageDay" ADD CONSTRAINT "IngestUsageDay_counters_check" CHECK ("bytes" >= 0 AND "events" >= 0);
ALTER TABLE "AwsVolumeObject" ADD CONSTRAINT "AwsVolumeObject_stream_check"
  CHECK ("stream" IN ('cloudtrail', 'guardduty', 'waf'));
ALTER TABLE "AwsVolumeObject" ADD CONSTRAINT "AwsVolumeObject_hash_check" CHECK ("objectHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AwsVolumeObject" ADD CONSTRAINT "AwsVolumeObject_bytes_check"
  CHECK ("bytes" >= 0 AND "compressedBytes" >= 0);
ALTER TABLE "NodeUsageDay" ADD CONSTRAINT "NodeUsageDay_metric_check" CHECK ("metric" IN ('analysisd'));
ALTER TABLE "NodeUsageDay" ADD CONSTRAINT "NodeUsageDay_counters_check" CHECK ("bytes" >= 0 AND "events" >= 0);

-- Só conta AWS tem o início da medição, e ele só existe com o início da coleta.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_metered_from_check"
  CHECK ("meteredFrom" IS NULL OR ("provider" = 'aws' AND "ingestFrom" IS NOT NULL));

-- As contas AWS já verificadas: o dia da primeira verificação é o seguinte ao `ingestFrom`.
UPDATE "CloudAccount"
   SET "meteredFrom" = ("ingestFrom" + 1)::timestamp AT TIME ZONE 'UTC'
 WHERE "provider" = 'aws' AND "ingestFrom" IS NOT NULL;
