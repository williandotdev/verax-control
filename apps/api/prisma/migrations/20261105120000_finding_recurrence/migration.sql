-- Reincidência do achado do GuardDuty (correção da fase 2, PR-W2): o GuardDuty soma a atividade nova ao mesmo achado
-- (mesmo `id`, `updatedAt` mais novo), e a chave estável fazia a versão nova cair como duplicada mesmo com o achado já
-- triado. Agora o achado guarda a última versão conhecida e a chave do achado inteiro (a cadeia: o original, as
-- recorrências e, na sondagem de porta, o achado de cada IP), e a versão nova de uma cadeia triada vira outro achado,
-- ligado ao original. A chave estrangeira leva o cliente junto: uma recorrência nunca aponta para achado de outro
-- cliente. Nenhum achado do Wazuh existe em produção, então nada é migrado.

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(3),
ADD COLUMN     "chainKey" VARCHAR(128),
ADD COLUMN     "recurrenceOfId" UUID;

-- CreateIndex
CREATE INDEX "Finding_recurrenceOfId_idx" ON "Finding"("recurrenceOfId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_chainKey_idx" ON "Finding"("tenantId", "chainKey");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_recurrenceOfId_tenantId_fkey" FOREIGN KEY ("recurrenceOfId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
