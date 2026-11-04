-- Base dos coletores (fase 2, PR-02): o estado da conexão de cada conta cloud e o cursor de cada fluxo lido por conta.

-- CreateEnum
CREATE TYPE "CloudAccountConnection" AS ENUM ('waiting', 'connected', 'error');

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "connection" "CloudAccountConnection" NOT NULL DEFAULT 'waiting',
ADD COLUMN     "connectionError" VARCHAR(64),
ADD COLUMN     "lastCollectedAt" TIMESTAMPTZ(3);

-- Contas ativas que já receberam evento nascem conectadas, nos provedores entregues por evento: a AWS (lida pelo
-- Wazuh, que vincula o alerta pelo bucket) e a GCP com assinatura do Pub/Sub (o evento só chegou porque o sync leu a
-- assinatura). É a mesma regra do sync: o evento recebido conecta a conta. As demais ficam aguardando. A última
-- coleta fica vazia até a próxima leitura; na AWS e na GCP, a Torre olha só o último evento.
UPDATE "CloudAccount" SET "connection" = 'connected'
WHERE "status" = 'active'
  AND "lastEventAt" IS NOT NULL
  AND ("provider" = 'aws' OR ("provider" = 'gcp' AND "pubsubSubscription" IS NOT NULL));

-- CreateTable
CREATE TABLE "CollectorCursor" (
    "id" UUID NOT NULL,
    "cloudAccountId" UUID NOT NULL,
    "stream" VARCHAR(32) NOT NULL,
    "region" VARCHAR(32) NOT NULL DEFAULT '',
    "cursorAt" TIMESTAMPTZ(3),
    "continuation" VARCHAR(2048),
    "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastErrorKind" VARCHAR(64),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CollectorCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectorCursor_stream_nextRunAt_idx" ON "CollectorCursor"("stream", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectorCursor_cloudAccountId_stream_region_key" ON "CollectorCursor"("cloudAccountId", "stream", "region");

-- AddForeignKey
ALTER TABLE "CollectorCursor" ADD CONSTRAINT "CollectorCursor_cloudAccountId_fkey" FOREIGN KEY ("cloudAccountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
