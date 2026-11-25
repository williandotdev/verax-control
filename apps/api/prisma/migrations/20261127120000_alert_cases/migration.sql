-- Base dos casos e da triagem em massa (M1). Só o banco: nenhuma tarefa, rota ou tela usa estas tabelas ainda, e nenhum
-- alerta ganha caso nesta versão.
--
-- Só acrescenta: tabelas novas, colunas vazias no alerta e no aviso, índices, chaves estrangeiras e gatilhos. A imagem
-- anterior do nó continua funcionando neste esquema (a volta de versão não desfaz migrations):
--   - ela grava alerta e aviso sem as colunas novas, que aceitam nulo;
--   - ela não lê o tipo novo (`CaseQueue`), e nenhum enum que ela lê ganhou valor;
--   - a chave estrangeira nova é do alerta para o caso: apagar alerta (o expurgo dela) não esbarra em nada. O item da
--     triagem em massa sai em cascata com o alerta, e apagar o incidente só esvazia o `incidentId` do caso;
--   - as contagens dos casos são dos gatilhos, não do código: continuam certas com a imagem anterior mexendo nos
--     alertas.
--
-- Numa transação só (BEGIN e COMMIT): o `prisma migrate deploy` não abre uma por arquivo, e uma falha no meio deixaria
-- metade do esquema. As migrations rodam com a API e o worker parados (`infra/node/bin/start.sh`), então nenhum índice é
-- CONCURRENTLY, e a chave estrangeira do alerta não é `NOT VALID` com `VALIDATE` depois: na mesma transação a trava
-- seria a mesma, e com a coluna toda nula a conferência é uma leitura da tabela.
BEGIN;

-- CreateEnum
CREATE TYPE "CaseQueue" AS ENUM ('detection', 'vulnerability', 'posture');

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "caseGroup" VARCHAR(128),
ADD COLUMN     "caseId" UUID,
ADD COLUMN     "triageOpId" UUID;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "caseId" UUID;

-- CreateTable
CREATE TABLE "AlertCase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "queue" "CaseQueue" NOT NULL,
    "keyVersion" SMALLINT NOT NULL,
    "groupKey" CHAR(64) NOT NULL,
    "openKey" CHAR(64),
    "family" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "keyParts" JSONB NOT NULL,
    "previousCaseId" UUID,
    "recurrence" INTEGER NOT NULL DEFAULT 0,
    "anchorFindingId" UUID NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" TIMESTAMPTZ(3),
    "sealReason" VARCHAR(16),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAlertAt" TIMESTAMPTZ(3) NOT NULL,
    "noticedSeverity" "FindingSeverity",
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "total" INTEGER NOT NULL DEFAULT 0,
    "pendingCritical" INTEGER NOT NULL DEFAULT 0,
    "pendingHigh" INTEGER NOT NULL DEFAULT 0,
    "pendingMedium" INTEGER NOT NULL DEFAULT 0,
    "pendingLow" INTEGER NOT NULL DEFAULT 0,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "investigatingCount" INTEGER NOT NULL DEFAULT 0,
    "legitimateCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedCount" INTEGER NOT NULL DEFAULT 0,
    "incidentCount" INTEGER NOT NULL DEFAULT 0,
    "ruleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accounts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mitreTactics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mitreTechniques" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "incidentId" UUID,

    CONSTRAINT "AlertCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageOperation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "target" JSONB NOT NULL,
    "status" "FindingStatus",
    "incidentId" UUID,
    "includeCritical" BOOLEAN NOT NULL DEFAULT false,
    "cutoffAt" TIMESTAMPTZ(3) NOT NULL,
    "expectedCount" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "state" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "cursor" VARCHAR(128),
    "matched" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "undoUntil" TIMESTAMPTZ(3),
    "undoOfId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TriageOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageOperationItem" (
    "tenantId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "previousStatus" "FindingStatus" NOT NULL,
    "previousTriagedAt" TIMESTAMPTZ(3),
    "previousIncidentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageOperationItem_pkey" PRIMARY KEY ("operationId","findingId")
);

-- CreateIndex
CREATE INDEX "AlertCase_tenantId_queue_pending_idx" ON "AlertCase"("tenantId", "queue", "pending");

-- CreateIndex
CREATE INDEX "AlertCase_tenantId_openedAt_idx" ON "AlertCase"("tenantId", "openedAt");

-- CreateIndex
CREATE INDEX "AlertCase_tenantId_groupKey_idx" ON "AlertCase"("tenantId", "groupKey");

-- CreateIndex
CREATE INDEX "AlertCase_incidentId_idx" ON "AlertCase"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertCase_tenantId_openKey_key" ON "AlertCase"("tenantId", "openKey");

-- CreateIndex
CREATE UNIQUE INDEX "AlertCase_id_tenantId_key" ON "AlertCase"("id", "tenantId");

-- CreateIndex
CREATE INDEX "TriageOperation_tenantId_createdAt_idx" ON "TriageOperation"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TriageOperation_state_createdAt_idx" ON "TriageOperation"("state", "createdAt");

-- CreateIndex
CREATE INDEX "TriageOperation_undoOfId_idx" ON "TriageOperation"("undoOfId");

-- CreateIndex
CREATE INDEX "TriageOperation_createdById_idx" ON "TriageOperation"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "TriageOperation_tenantId_requestId_key" ON "TriageOperation"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "TriageOperation_id_tenantId_key" ON "TriageOperation"("id", "tenantId");

-- CreateIndex
CREATE INDEX "TriageOperationItem_findingId_tenantId_idx" ON "TriageOperationItem"("findingId", "tenantId");

-- CreateIndex
CREATE INDEX "Finding_tenantId_caseId_occurredAt_id_idx" ON "Finding"("tenantId", "caseId", "occurredAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_caseId_tenantId_fkey" FOREIGN KEY ("caseId", "tenantId") REFERENCES "AlertCase"("id", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertCase" ADD CONSTRAINT "AlertCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertCase" ADD CONSTRAINT "AlertCase_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageOperation" ADD CONSTRAINT "TriageOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageOperation" ADD CONSTRAINT "TriageOperation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageOperation" ADD CONSTRAINT "TriageOperation_undoOfId_tenantId_fkey" FOREIGN KEY ("undoOfId", "tenantId") REFERENCES "TriageOperation"("id", "tenantId") ON DELETE NO ACTION ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TriageOperationItem" ADD CONSTRAINT "TriageOperationItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageOperationItem" ADD CONSTRAINT "TriageOperationItem_operationId_tenantId_fkey" FOREIGN KEY ("operationId", "tenantId") REFERENCES "TriageOperation"("id", "tenantId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TriageOperationItem" ADD CONSTRAINT "TriageOperationItem_findingId_tenantId_fkey" FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Daqui para baixo, o que o Prisma não declara (e não compara: o `migrate diff` com o schema sai vazio).

-- Espaço na página para a contagem mudar sem mexer em índice (update HOT).
ALTER TABLE "AlertCase" SET (fillfactor = 70);

-- Os alertas pendentes ainda sem caso, na ordem de chegada: a fila da tarefa dos casos. Só serve à consulta que repete o
-- predicado com os valores escritos nela (não em parâmetro, nem no formato que o Prisma gera para o enum).
CREATE INDEX "Finding_case_outbox_idx" ON "Finding" ("tenantId", "createdAt", "id")
  WHERE "caseId" IS NULL AND "incidentId" IS NULL AND "status" IN ('new', 'investigating');

-- Os alertas com tática do MITRE, por cliente e horário (a matriz da Torre).
CREATE INDEX "Finding_mitre_tactics_idx" ON "Finding" ("tenantId", "occurredAt")
  WHERE cardinality("mitreTactics") > 0;

-- A chave: SHA-256 em hexadecimal; a aberta é sempre a própria chave do caso.
ALTER TABLE "AlertCase" ADD CONSTRAINT "AlertCase_key_check" CHECK (
  "keyVersion" >= 1
  AND "groupKey" ~ '^[0-9a-f]{64}$'
  AND ("openKey" IS NULL OR "openKey" = "groupKey")
  AND jsonb_typeof("keyParts") = 'array'
);

-- Aberto ou selado: selado é sem chave aberta, com o horário e o motivo.
ALTER TABLE "AlertCase" ADD CONSTRAINT "AlertCase_seal_check" CHECK (
  ("openKey" IS NULL) = ("sealedAt" IS NOT NULL)
  AND ("sealedAt" IS NULL) = ("sealReason" IS NULL)
  AND ("sealReason" IS NULL OR "sealReason" IN ('window', 'treated', 'idle', 'split'))
);

-- O teto de cada amostra.
ALTER TABLE "AlertCase" ADD CONSTRAINT "AlertCase_samples_check" CHECK (
  cardinality("ruleIds") <= 20
  AND cardinality("accounts") <= 50
  AND cardinality("actors") <= 20
  AND cardinality("ips") <= 20
  AND cardinality("resources") <= 20
  AND cardinality("mitreTactics") <= 20
  AND cardinality("mitreTechniques") <= 50
);

ALTER TABLE "TriageOperation" ADD CONSTRAINT "TriageOperation_request_check" CHECK (
  "action" IN ('status', 'promote', 'attach', 'undo', 'undo_all_of')
  AND ("status" IS NOT NULL) = ("action" = 'status')
  AND ("undoOfId" IS NOT NULL) = ("action" = 'undo')
  AND jsonb_typeof("target") = 'object'
  AND "expectedCount" >= 0
);

ALTER TABLE "TriageOperation" ADD CONSTRAINT "TriageOperation_state_check" CHECK (
  "state" IN ('queued', 'running', 'done', 'partial', 'failed', 'canceled', 'undoing', 'undone')
  AND "matched" >= 0
  AND "changed" >= 0
  AND "skipped" >= 0
);

-- O caso só aponta para incidente do mesmo cliente, venha a escrita de onde vier. (A chave estrangeira composta não
-- serve aqui: `incidentId` é opcional e `tenantId` não. É o mesmo gatilho do alerta e do aviso.)
CREATE FUNCTION "alert_case_incident_same_tenant"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."incidentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."Incident" AS i WHERE i."id" = NEW."incidentId" AND i."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'caso e incidente de clientes diferentes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AlertCase_incident_same_tenant"
  BEFORE INSERT OR UPDATE OF "incidentId", "tenantId" ON "AlertCase"
  FOR EACH ROW EXECUTE FUNCTION "alert_case_incident_same_tenant"();

-- As contagens dos casos, mantidas por gatilhos do alerta. Ninguém mais as grava.
--
-- O que conta, em cada alerta do caso (uma vez só): em incidente, `incidentCount`; fora dele, o status. Pendente é fora
-- de incidente e `new` ou `investigating`, dividido por severidade. As funções somam as diferenças por caso (o estado
-- de antes com sinal -1, o de depois com +1) e aplicam só o que mudou: um update que não mexe nesses campos (o
-- `lastSeenAt` de uma releitura) não toca em caso nenhum. Sem junção entre as linhas de antes e as de depois: o custo é
-- proporcional às linhas do comando, com qualquer plano em cache.
--
-- Exato com escritas ao mesmo tempo: a diferença é somada ao valor atual da linha do caso, sob a trava dela, e o estado
-- de antes é o da linha de fato substituída. Vale também com a imagem anterior do nó, com o expurgo e com as cascatas.
--
-- Trava: o gatilho trava as linhas dos casos depois das do alerta. A ordem de todos é lock do cliente, alertas, casos; e
-- quem mexe em mais de um caso na mesma transação já tem o lock do cliente (`lockTenantFindings`). Quem faz mais de um
-- comando sobre alertas na mesma transação trava antes todas as linhas deles (como o expurgo), para nunca esperar por um
-- alerta já com um caso travado.
--
-- Rodam como quem escreveu no alerta (sem SECURITY DEFINER) e não levantam erro próprio: uma contagem errada se corrige
-- depois, um alerta que não entrou não volta. Por isso também não há CHECK nas contagens.

-- O comando UPDATE inteiro (um ou muitos alertas), uma vez por comando.
CREATE FUNCTION "finding_case_counters_on_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public."AlertCase" AS c SET
    "total" = c."total" + d.total,
    "pendingCritical" = c."pendingCritical" + d.pending_critical,
    "pendingHigh" = c."pendingHigh" + d.pending_high,
    "pendingMedium" = c."pendingMedium" + d.pending_medium,
    "pendingLow" = c."pendingLow" + d.pending_low,
    "newCount" = c."newCount" + d.new_count,
    "investigatingCount" = c."investigatingCount" + d.investigating_count,
    "legitimateCount" = c."legitimateCount" + d.legitimate_count,
    "resolvedCount" = c."resolvedCount" + d.resolved_count,
    "incidentCount" = c."incidentCount" + d.incident_count,
    "pending" = c."newCount" + d.new_count + c."investigatingCount" + d.investigating_count > 0
  FROM (
    SELECT
      r."caseId" AS case_id,
      r."tenantId" AS tenant_id,
      sum(r.sign) AS total,
      sum(CASE WHEN r.pending AND r."severity" = 'critical' THEN r.sign ELSE 0 END) AS pending_critical,
      sum(CASE WHEN r.pending AND r."severity" = 'high' THEN r.sign ELSE 0 END) AS pending_high,
      sum(CASE WHEN r.pending AND r."severity" = 'medium' THEN r.sign ELSE 0 END) AS pending_medium,
      sum(CASE WHEN r.pending AND r."severity" = 'low' THEN r.sign ELSE 0 END) AS pending_low,
      sum(CASE WHEN r.loose AND r."status" = 'new' THEN r.sign ELSE 0 END) AS new_count,
      sum(CASE WHEN r.loose AND r."status" = 'investigating' THEN r.sign ELSE 0 END) AS investigating_count,
      sum(CASE WHEN r.loose AND r."status" = 'legitimate' THEN r.sign ELSE 0 END) AS legitimate_count,
      sum(CASE WHEN r.loose AND r."status" = 'resolved' THEN r.sign ELSE 0 END) AS resolved_count,
      sum(CASE WHEN r.loose THEN 0 ELSE r.sign END) AS incident_count
    FROM (
      SELECT -1 AS sign, o."caseId", o."tenantId", o."severity", o."status", o."incidentId" IS NULL AS loose,
        o."incidentId" IS NULL AND o."status" IN ('new', 'investigating') AS pending
      FROM old_rows AS o WHERE o."caseId" IS NOT NULL
      UNION ALL
      SELECT 1 AS sign, n."caseId", n."tenantId", n."severity", n."status", n."incidentId" IS NULL AS loose,
        n."incidentId" IS NULL AND n."status" IN ('new', 'investigating') AS pending
      FROM new_rows AS n WHERE n."caseId" IS NOT NULL
    ) AS r
    GROUP BY r."caseId", r."tenantId"
  ) AS d
  WHERE c."id" = d.case_id AND c."tenantId" = d.tenant_id
    AND (
      d.total, d.pending_critical, d.pending_high, d.pending_medium, d.pending_low,
      d.new_count, d.investigating_count, d.legitimate_count, d.resolved_count, d.incident_count
    ) <> (0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  RETURN NULL;
END;
$$;

-- O comando DELETE inteiro: o mesmo, só com o estado de antes.
CREATE FUNCTION "finding_case_counters_on_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public."AlertCase" AS c SET
    "total" = c."total" - d.total,
    "pendingCritical" = c."pendingCritical" - d.pending_critical,
    "pendingHigh" = c."pendingHigh" - d.pending_high,
    "pendingMedium" = c."pendingMedium" - d.pending_medium,
    "pendingLow" = c."pendingLow" - d.pending_low,
    "newCount" = c."newCount" - d.new_count,
    "investigatingCount" = c."investigatingCount" - d.investigating_count,
    "legitimateCount" = c."legitimateCount" - d.legitimate_count,
    "resolvedCount" = c."resolvedCount" - d.resolved_count,
    "incidentCount" = c."incidentCount" - d.incident_count,
    "pending" = c."newCount" - d.new_count + c."investigatingCount" - d.investigating_count > 0
  FROM (
    SELECT
      r."caseId" AS case_id,
      r."tenantId" AS tenant_id,
      count(*) AS total,
      count(*) FILTER (WHERE r.pending AND r."severity" = 'critical') AS pending_critical,
      count(*) FILTER (WHERE r.pending AND r."severity" = 'high') AS pending_high,
      count(*) FILTER (WHERE r.pending AND r."severity" = 'medium') AS pending_medium,
      count(*) FILTER (WHERE r.pending AND r."severity" = 'low') AS pending_low,
      count(*) FILTER (WHERE r.loose AND r."status" = 'new') AS new_count,
      count(*) FILTER (WHERE r.loose AND r."status" = 'investigating') AS investigating_count,
      count(*) FILTER (WHERE r.loose AND r."status" = 'legitimate') AS legitimate_count,
      count(*) FILTER (WHERE r.loose AND r."status" = 'resolved') AS resolved_count,
      count(*) FILTER (WHERE NOT r.loose) AS incident_count
    FROM (
      SELECT o."caseId", o."tenantId", o."severity", o."status", o."incidentId" IS NULL AS loose,
        o."incidentId" IS NULL AND o."status" IN ('new', 'investigating') AS pending
      FROM old_rows AS o WHERE o."caseId" IS NOT NULL
    ) AS r
    GROUP BY r."caseId", r."tenantId"
  ) AS d
  WHERE c."id" = d.case_id AND c."tenantId" = d.tenant_id;
  RETURN NULL;
END;
$$;

-- O alerta que já nasce num caso. A atribuição é sempre por UPDATE; este gatilho só mantém a contagem exata se alguém
-- inserir direto. Por linha e com WHEN: no caminho normal (sem caso), não roda função nenhuma na gravação dos coletores.
CREATE FUNCTION "finding_case_counters_on_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_loose boolean := NEW."incidentId" IS NULL;
  v_pending boolean := NEW."incidentId" IS NULL AND NEW."status" IN ('new', 'investigating');
BEGIN
  UPDATE public."AlertCase" AS c SET
    "total" = c."total" + 1,
    "pendingCritical" = c."pendingCritical" + (v_pending AND NEW."severity" = 'critical')::integer,
    "pendingHigh" = c."pendingHigh" + (v_pending AND NEW."severity" = 'high')::integer,
    "pendingMedium" = c."pendingMedium" + (v_pending AND NEW."severity" = 'medium')::integer,
    "pendingLow" = c."pendingLow" + (v_pending AND NEW."severity" = 'low')::integer,
    "newCount" = c."newCount" + (v_loose AND NEW."status" = 'new')::integer,
    "investigatingCount" = c."investigatingCount" + (v_loose AND NEW."status" = 'investigating')::integer,
    "legitimateCount" = c."legitimateCount" + (v_loose AND NEW."status" = 'legitimate')::integer,
    "resolvedCount" = c."resolvedCount" + (v_loose AND NEW."status" = 'resolved')::integer,
    "incidentCount" = c."incidentCount" + (NOT v_loose)::integer,
    "pending" = c."newCount" + c."investigatingCount" + v_pending::integer > 0
  WHERE c."id" = NEW."caseId" AND c."tenantId" = NEW."tenantId";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Finding_case_counters_update"
  AFTER UPDATE ON "Finding"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "finding_case_counters_on_update"();

CREATE TRIGGER "Finding_case_counters_delete"
  AFTER DELETE ON "Finding"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "finding_case_counters_on_delete"();

CREATE TRIGGER "Finding_case_counters_insert"
  AFTER INSERT ON "Finding"
  FOR EACH ROW WHEN (NEW."caseId" IS NOT NULL)
  EXECUTE FUNCTION "finding_case_counters_on_insert"();

COMMIT;
