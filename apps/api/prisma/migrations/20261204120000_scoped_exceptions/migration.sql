-- Exceções amplas a partir de um caso (casos, PR-9). Só acrescenta: uma tabela nova e uma coluna anulável no achado, com a
-- chave estrangeira e um índice parcial. Nenhum valor de enum muda (um valor novo em `AlertExceptionField` faria o
-- `activeExceptions()` da imagem anterior lançar, e a coleta inteira parar). A imagem anterior do nó ignora a tabela e a
-- coluna: grava o achado sem ela (nula), e o alerta que a exceção ampla marcaria volta para a fila (o lado seguro).

CREATE TABLE "ScopedException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ruleId" VARCHAR(6) NOT NULL,
    "logSource" VARCHAR(32) NOT NULL,
    "accountId" VARCHAR(32) NOT NULL,
    "eventName" VARCHAR(256),
    "resourcePrefix" VARCHAR(2048),
    "maxSeverity" "FindingSeverity" NOT NULL DEFAULT 'medium',
    "reason" VARCHAR(500) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScopedException_pkey" PRIMARY KEY ("id"),
    -- Decisão D8: nunca crítico, e a validade é de até 90 dias desde a criação. A API confere antes; o banco garante.
    CONSTRAINT "ScopedException_maxSeverity_check" CHECK ("maxSeverity" <> 'critical'),
    CONSTRAINT "ScopedException_expiresAt_check" CHECK (
        "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '90 days'
    ),
    CONSTRAINT "ScopedException_accountId_check" CHECK (length("accountId") > 0),
    CONSTRAINT "ScopedException_revoked_check" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL))
);

CREATE UNIQUE INDEX "ScopedException_id_tenantId_key" ON "ScopedException"("id", "tenantId");
CREATE INDEX "ScopedException_tenantId_expiresAt_idx" ON "ScopedException"("tenantId", "expiresAt");

ALTER TABLE "ScopedException" ADD CONSTRAINT "ScopedException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScopedException" ADD CONSTRAINT "ScopedException_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScopedException" ADD CONSTRAINT "ScopedException_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A coluna no achado: anulável e sem valor padrão, então nenhuma linha é reescrita.
ALTER TABLE "Finding" ADD COLUMN "scopedExceptionId" UUID;

-- Composta com o cliente: o achado nunca aponta para exceção de outro cliente. Apagar a exceção só anula esta coluna
-- (`SET NULL` com a lista de colunas, Postgres 15+), nunca o `tenantId`. Sem propagar (`NO ACTION` na atualização).
-- A coluna nasce nula em todas as linhas, então a validação só lê a tabela, uma vez.
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_scopedExceptionId_tenantId_fkey"
    FOREIGN KEY ("scopedExceptionId", "tenantId") REFERENCES "ScopedException"("id", "tenantId")
    ON DELETE SET NULL ("scopedExceptionId") ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "Finding" VALIDATE CONSTRAINT "Finding_scopedExceptionId_tenantId_fkey";

-- Os alertas marcados por uma exceção ampla (a chave estrangeira e a contagem dela). Parcial: o alerta sem exceção ampla,
-- quase todos, não entra, e a gravação dele não fica mais cara. O Prisma não declara índice parcial.
CREATE INDEX "Finding_scopedExceptionId_idx" ON "Finding" ("scopedExceptionId") WHERE "scopedExceptionId" IS NOT NULL;
