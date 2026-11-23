-- A prova de quem é o dono dos alertas do CloudWatch Logs do nó (onboarding self-service da AWS). O evento de um grupo
-- de logs chega ao indexer sem a conta e sem o grupo, e o sync decidia o dono pelas autorizações do momento da leitura:
-- quando um de dois clientes tirava a autorização, o que sobrava virava dono do que o manager ainda coletava do outro.
-- A tabela guarda desde quando a configuração APLICADA no manager só tem grupos de uma conta de um cliente, e o sync só
-- atribui o alerta que cabe inteiro nesse intervalo. Uma linha por nó, gravada só pela tarefa `wazuh-config`. Sem
-- `tenantId` e sem chave estrangeira de propósito: não é dado do cliente. Só acrescenta: nenhuma tabela, coluna ou linha
-- que já existe é tocada.

-- CreateTable
CREATE TABLE "CloudWatchAlertOwnership" (
    "id" VARCHAR(32) NOT NULL,
    "ownerTenantId" UUID,
    "ownerAccountId" VARCHAR(12),
    "generation" VARCHAR(64) NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudWatchAlertOwnership_pkey" PRIMARY KEY ("id")
);

-- O dono é o cliente e a conta juntos, ou nenhum dos dois; a conta e a geração nos formatos de sempre.
ALTER TABLE "CloudWatchAlertOwnership" ADD CONSTRAINT "CloudWatchAlertOwnership_owner_check" CHECK (
  ("ownerTenantId" IS NULL) = ("ownerAccountId" IS NULL)
  AND ("ownerAccountId" IS NULL OR "ownerAccountId" ~ '^[0-9]{12}$')
  AND "generation" ~ '^[0-9a-f]{64}$'
);
