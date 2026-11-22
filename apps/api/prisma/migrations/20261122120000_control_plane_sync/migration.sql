-- Sincronização do nó dedicado com o plano de controle (a tarefa `control-plane-sync` do worker): as fontes de log que
-- a Verax cadastra no console chegam ao nó como contas cloud, e a credencial delas, cifrada para o cofre do nó, como a
-- linha do cofre. Só acrescenta: nenhuma linha existente muda (todas ficam `panel`, sem revisão).
--
-- 1. `ManagedOrigin`: quem cadastrou a conta ou guardou a credencial, o cliente no painel ou a Verax pelo console.
-- 2. `CloudAccount.origin` e `controlPlaneRevision` (a última revisão do console aplicada): a revisão existe só na conta
--    do console (CHECK). O painel não muda nem desativa a do console (409 `CONSOLE_MANAGED`).
-- 3. `CloudCredential.origin` e `controlPlaneRevision`: a revisão do console da credencial vigente; a colada no painel
--    fica sem revisão (CHECK). Vale a mais recente: uma colada no painel fica até o console mandar uma revisão nova.
-- 4. `ControlPlaneSyncItem`: o resultado da última revisão de cada item do console (o que o nó conta de volta e o que
--    não tenta de novo) e o último relato de cada fonte que o plano de controle aceitou (o hash e o instante: o pedido
--    tem limite de tamanho, e os relatos que ficam de fora vão primeiro na chamada seguinte). Tem `tenantId`, então
--    entra no escopo do cliente, só para leitura (`SYSTEM_WRITTEN_MODELS`).
-- 5. `ControlPlaneSync`: uma linha só, com a sequência das chamadas (o plano de controle recusa a repetida) e a espera
--    até a próxima.
--
-- Os CHECKs repetem no banco os formatos do contrato (`packages/shared/src/node-sync.ts`).

-- CreateEnum
CREATE TYPE "ManagedOrigin" AS ENUM ('panel', 'control_plane');

-- CreateEnum
CREATE TYPE "ControlPlaneItemKind" AS ENUM ('log_source', 'log_source_credential', 'user');

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "controlPlaneRevision" INTEGER,
ADD COLUMN     "origin" "ManagedOrigin" NOT NULL DEFAULT 'panel';

-- AlterTable
ALTER TABLE "CloudCredential" ADD COLUMN     "controlPlaneRevision" INTEGER,
ADD COLUMN     "origin" "ManagedOrigin" NOT NULL DEFAULT 'panel';

-- CreateTable
CREATE TABLE "ControlPlaneSyncItem" (
    "kind" "ControlPlaneItemKind" NOT NULL,
    "itemId" VARCHAR(36) NOT NULL,
    "tenantId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "code" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "reportedHash" CHAR(64),
    "reportedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ControlPlaneSyncItem_pkey" PRIMARY KEY ("kind","itemId")
);

-- CreateTable
CREATE TABLE "ControlPlaneSync" (
    "id" VARCHAR(16) NOT NULL DEFAULT 'node',
    "sequence" BIGINT NOT NULL DEFAULT 0,
    "generation" INTEGER,
    "lastAttemptAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),

    CONSTRAINT "ControlPlaneSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ControlPlaneSyncItem_tenantId_idx" ON "ControlPlaneSyncItem"("tenantId");

-- AddForeignKey
ALTER TABLE "ControlPlaneSyncItem" ADD CONSTRAINT "ControlPlaneSyncItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A revisão do console vai só (e sempre) com a origem do console, e começa em 1.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_control_plane_revision_check" CHECK (
  ("origin" = 'control_plane') = ("controlPlaneRevision" IS NOT NULL)
  AND ("controlPlaneRevision" IS NULL OR "controlPlaneRevision" >= 1)
);
ALTER TABLE "CloudCredential" ADD CONSTRAINT "CloudCredential_control_plane_revision_check" CHECK (
  ("origin" = 'control_plane') = ("controlPlaneRevision" IS NOT NULL)
  AND ("controlPlaneRevision" IS NULL OR "controlPlaneRevision" >= 1)
);
-- O item: o id da fonte é o UUID em minúsculas que o console escolheu (o da conta), e o do pedido de usuário, um ULID;
-- o resultado e o código são os do contrato, e o código acompanha só a falha.
ALTER TABLE "ControlPlaneSyncItem" ADD CONSTRAINT "ControlPlaneSyncItem_item_id_check" CHECK (
  ("kind" = 'user' AND "itemId" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
  OR ("kind" <> 'user' AND "itemId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
ALTER TABLE "ControlPlaneSyncItem" ADD CONSTRAINT "ControlPlaneSyncItem_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "ControlPlaneSyncItem" ADD CONSTRAINT "ControlPlaneSyncItem_outcome_check" CHECK (
  "outcome" IN ('applied', 'failed', 'removed', 'created')
  AND (("outcome" = 'failed') = ("code" IS NOT NULL))
  AND ("code" IS NULL OR "code" ~ '^[a-z_]{1,64}$')
);
ALTER TABLE "ControlPlaneSyncItem" ADD CONSTRAINT "ControlPlaneSyncItem_attempts_check" CHECK ("attempts" >= 0);
-- O último relato aceito: o SHA-256 em hexadecimal e o instante, juntos.
ALTER TABLE "ControlPlaneSyncItem" ADD CONSTRAINT "ControlPlaneSyncItem_reported_check" CHECK (
  ("reportedHash" IS NULL) = ("reportedAt" IS NULL)
  AND ("reportedHash" IS NULL OR "reportedHash" ~ '^[0-9a-f]{64}$')
);
-- Uma linha só, e a sequência nunca negativa.
ALTER TABLE "ControlPlaneSync" ADD CONSTRAINT "ControlPlaneSync_singleton_check" CHECK ("id" = 'node');
ALTER TABLE "ControlPlaneSync" ADD CONSTRAINT "ControlPlaneSync_counters_check" CHECK (
  "sequence" >= 0 AND "failures" >= 0 AND ("generation" IS NULL OR "generation" >= 0)
);
