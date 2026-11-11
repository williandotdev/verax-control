-- Estados do ciclo de vida da contratação (fase 3, CE-02): `suspended`, `canceled` e `purging`, espelho do plano de
-- controle na célula compartilhada. Só o sistema os grava (`apps/api/src/tenants/tenant-lifecycle.ts`); nada aqui os
-- usa (um valor novo de enum não pode ser usado na mesma transação em que nasce).

-- AlterEnum
ALTER TYPE "TenantStatus" ADD VALUE 'suspended';
ALTER TYPE "TenantStatus" ADD VALUE 'canceled';
ALTER TYPE "TenantStatus" ADD VALUE 'purging';
