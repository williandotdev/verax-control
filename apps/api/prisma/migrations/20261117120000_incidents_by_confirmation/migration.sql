-- Alerta e incidente (decisão do responsável de 17/11/2026, taxonomia de SOC): todo achado novo entra como alerta a
-- validar, e incidente só nasce quando uma pessoa confirma (promove alertas pela API). O agrupamento automático deixa
-- de existir: a regra de correlação passa a só sugerir alertas relacionados.
--
-- 1. Quem confirmou o incidente (`createdById`).
-- 2. Aviso do alerta alto (`high_finding`) e o aviso do incidente confirmado em qualquer severidade.
-- 3. O aviso sobrevive ao incidente apagado (`SetNull`): o histórico de envio não some com o desfazer abaixo nem com o
--    expurgo.
-- 4. Os incidentes abertos pelo agrupamento automático em que ninguém mexeu (sem responsável e ainda "aberto") são
--    desfeitos: os alertas deles voltam à fila de validação com o status que já tinham, e o incidente sai. Os que
--    alguém tocou (com responsável, ou em investigação ou resolvidos) ficam como estão. Cada incidente desfeito deixa
--    um registro de sistema na trilha de auditoria do cliente.

-- AlterEnum (o valor novo só é usado depois do COMMIT: as regras abaixo comparam o texto do tipo)
ALTER TYPE "NotificationKind" ADD VALUE 'high_finding';

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN "createdById" TEXT;

-- CreateIndex
CREATE INDEX "Incident_createdById_idx" ON "Incident"("createdById");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey / AddForeignKey: apagar o incidente mantém o aviso, sem o incidente.
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_incidentId_fkey";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- O alvo de cada tipo: o incidente confirmado avisa em qualquer severidade; o que sobe, só para alta ou crítica; o
-- alerta, alto (`high_finding`) ou crítico (`critical_finding`). O incidente pode faltar depois que ele sai (o aviso
-- fica como histórico); o worker pula o aviso pendente sem incidente.
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_target_check";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_target_check" CHECK (
  CASE "kind"::text
    WHEN 'incident_opened' THEN "severity" IS NOT NULL
    WHEN 'incident_escalated' THEN "severity" IN ('high', 'critical')
    WHEN 'critical_finding' THEN "findingId" IS NOT NULL AND "severity" = 'critical'
    WHEN 'high_finding' THEN "findingId" IS NOT NULL AND "severity" = 'high'
    WHEN 'plan_usage' THEN "usageMonth" IS NOT NULL AND "usagePercent" IN (80, 100)
    ELSE TRUE
  END
);

-- Os incidentes automáticos em que ninguém mexeu.
CREATE TEMPORARY TABLE "dissolved_incident" AS
  SELECT "id", "tenantId", "severity", "riskScore", "findingCount", "firstSeenAt", "lastSeenAt", "createdAt"
  FROM "Incident"
  WHERE "assigneeId" IS NULL AND "status" = 'open';

-- Um registro de sistema por incidente desfeito, na trilha do cliente (a trilha só aceita INSERT, e é o que entra).
-- Os ids dos alertas vão no estado anterior (até 500, o limite da linha do tempo do detalhe).
INSERT INTO "AuditLog" ("id", "actorType", "tenantId", "action", "resourceType", "resourceId", "outcome", "before", "after")
SELECT
  uuidv7(),
  'system',
  d."tenantId"::text,
  'incident.dissolve',
  'incident',
  d."id"::text,
  'success',
  jsonb_build_object(
    'status', 'open',
    'severity', d."severity",
    'riskScore', d."riskScore",
    'findingCount', d."findingCount",
    'firstSeenAt', d."firstSeenAt",
    'lastSeenAt', d."lastSeenAt",
    'createdAt', d."createdAt",
    'findingIds', COALESCE(
      (SELECT jsonb_agg(f."id" ORDER BY f."occurredAt", f."id")
         FROM (SELECT "id", "occurredAt" FROM "Finding" WHERE "incidentId" = d."id"
               ORDER BY "occurredAt", "id" LIMIT 500) f),
      '[]'::jsonb)
  ),
  jsonb_build_object('reason', 'automatic_grouping_retired')
FROM "dissolved_incident" d;

-- Os alertas voltam à fila de validação com o status que já tinham.
UPDATE "Finding" SET "incidentId" = NULL
WHERE "incidentId" IN (SELECT "id" FROM "dissolved_incident");

-- O aviso ainda na fila de um incidente desfeito não sai mais (o incidente não existe); o histórico fica.
UPDATE "Notification" SET "status" = 'skipped', "lastError" = 'incident_dissolved', "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'pending' AND "incidentId" IN (SELECT "id" FROM "dissolved_incident");

DELETE FROM "Incident" WHERE "id" IN (SELECT "id" FROM "dissolved_incident");
DROP TABLE "dissolved_incident";
