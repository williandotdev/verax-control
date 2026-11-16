-- Entrada única também no nó dedicado da Verax (PLAN=interno; decisão de 16/11/2026; docs/ARQUITETURA.md, "Entrada
-- única"). O nó dedicado não tem cliente do endereço: o pedido em curso nasce sem `hostTenantId` (o nó inteiro é o da
-- equipe). Na célula, nada muda: o pedido continua preso ao cliente da equipe, e o callback confere o mesmo valor.

-- AlterTable
ALTER TABLE "SsoLoginAttempt" ALTER COLUMN "hostTenantId" DROP NOT NULL;
