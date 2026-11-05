-- Avisos por e-mail (fase 2, PR-16): a fila de saída (outbox). O aviso nasce na mesma transação do achado e do incidente
-- (ou do volume do mês) e o worker entrega. Nenhum endereço de e-mail fica aqui: os destinatários são resolvidos no envio.

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('incident_opened', 'incident_escalated', 'critical_finding', 'aws_ingestion_stalled', 'plan_usage');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "dedupeKey" VARCHAR(128) NOT NULL,
    "severity" "FindingSeverity",
    "incidentId" UUID,
    "findingId" UUID,
    "usageMonth" DATE,
    "usagePercent" SMALLINT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(64),
    "deliveredUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Notification_incidentId_idx" ON "Notification"("incidentId");

-- CreateIndex
CREATE INDEX "Notification_findingId_idx" ON "Notification"("findingId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_dedupeKey_key" ON "Notification"("tenantId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_findingId_tenantId_fkey" FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- O incidente do aviso é sempre do mesmo cliente, como o do achado (`finding_incident_same_tenant`): o incidente não tem
-- o par id e cliente único para uma chave estrangeira composta. O achado tem, e a chave dele já inclui o cliente.
CREATE FUNCTION "notification_incident_same_tenant"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."incidentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Incident" WHERE "id" = NEW."incidentId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'aviso e incidente de clientes diferentes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Notification_incident_same_tenant"
  BEFORE INSERT OR UPDATE OF "incidentId", "tenantId" ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION "notification_incident_same_tenant"();

-- Regras que o Prisma não descreve: cada tipo tem o alvo dele (o incidente alto ou crítico, o achado crítico, o mês e a
-- faixa do volume), o mês é sempre o primeiro dia e as tentativas vão de 0 a 5.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_target_check" CHECK (
  CASE "kind"
    WHEN 'incident_opened' THEN "incidentId" IS NOT NULL AND "severity" IN ('high', 'critical')
    WHEN 'incident_escalated' THEN "incidentId" IS NOT NULL AND "severity" IN ('high', 'critical')
    WHEN 'critical_finding' THEN "findingId" IS NOT NULL AND "severity" = 'critical'
    WHEN 'plan_usage' THEN "usageMonth" IS NOT NULL AND "usagePercent" IN (80, 100)
    ELSE TRUE
  END
);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_usage_month_first_day_check"
  CHECK ("usageMonth" IS NULL OR EXTRACT(DAY FROM "usageMonth") = 1);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5);
