-- Reincidência do achado do GuardDuty (correção da fase 2, PR-W2): o GuardDuty soma a atividade nova ao mesmo achado
-- (mesmo `id`, `service.eventLastSeen` mais novo), e a chave estável fazia a versão nova cair como duplicada mesmo com o
-- achado já triado. Agora o achado guarda a última atividade conhecida, e a versão nova de um achado triado vira outro
-- achado, ligado ao original. A chave estrangeira leva o cliente junto: uma recorrência nunca aponta para achado de
-- outro cliente. Nenhum achado do Wazuh existe em produção, então nada é migrado.

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(3),
ADD COLUMN     "recurrenceOfId" UUID;

-- CreateIndex
CREATE INDEX "Finding_recurrenceOfId_idx" ON "Finding"("recurrenceOfId");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_recurrenceOfId_tenantId_fkey" FOREIGN KEY ("recurrenceOfId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
