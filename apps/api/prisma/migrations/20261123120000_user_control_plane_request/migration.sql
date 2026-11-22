-- Usuários do cliente pedidos pela Verax no console (sincronização com o plano de controle): o worker do nó cria a
-- conta com a senha temporária que chegou cifrada para o cofre do nó e guarda aqui o id do pedido (ULID). É o que torna
-- a criação idempotente (o mesmo pedido de novo não cria outra conta) e o que o nó conta de volta a cada chamada (a
-- situação da conta: ativa ou não, MFA, ainda na senha temporária). Só acrescenta: as contas existentes ficam sem
-- pedido (criadas no painel, no seed ou no primeiro acesso).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "controlPlaneRequestId" VARCHAR(26);

-- CreateIndex
CREATE UNIQUE INDEX "User_controlPlaneRequestId_key" ON "User"("controlPlaneRequestId");

-- O id do pedido é o ULID do contrato (`packages/shared/src/node-sync.ts`), e só a conta de um cliente tem pedido (a
-- equipe da Verax nunca é criada pelo console).
ALTER TABLE "User" ADD CONSTRAINT "User_control_plane_request_id_check" CHECK (
  "controlPlaneRequestId" IS NULL
  OR ("controlPlaneRequestId" ~ '^[0-9A-HJKMNP-TV-Z]{26}$' AND "tenantId" IS NOT NULL)
);
