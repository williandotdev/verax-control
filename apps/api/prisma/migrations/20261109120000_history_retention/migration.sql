-- Expurgo diário do histórico pelo plano (fase 2, PR-19). ⚠️ Altera a imutabilidade da trilha de auditoria e dos
-- comentários dos achados: revisão linha a linha.
--
-- Até aqui, `AuditLog` e `FindingComment` só aceitavam INSERT (T1.3 e T5.5). Continua assim, com uma única exceção
-- estreita: o DELETE de registro antigo, feito pelas duas funções de expurgo abaixo. UPDATE e TRUNCATE continuam
-- sempre bloqueados, para todo mundo. Um DELETE só passa no trigger com as duas condições ao mesmo tempo:
--   1. a flag `verax.retention` ligada. Só as funções de expurgo a ligam, e só em volta do próprio DELETE: ligam com
--      `set_config(..., true)` (vale só na transação) logo antes e devolvem o valor anterior logo depois. Com erro no
--      meio, a transação (ou o savepoint) desfaz a flag junto. A cláusula SET da função não serve aqui: o Postgres
--      não deixa um papel sem superusuário fixar uma variável própria (`verax.*`) na definição da função;
--   2. o registro mais velho que o piso de idade, conferido aqui, no banco, linha a linha: 13 meses na auditoria e
--      30 dias nos comentários (o menor prazo de histórico que um plano aceita, `PLAN_LIMIT_BOUNDS`).
-- Ligar a flag na sessão não basta: o papel da aplicação não tem DELETE em nenhuma das duas tabelas (db-bootstrap), e
-- nem o dono das tabelas apaga um registro mais novo que o piso sem derrubar o trigger.
--
-- As funções são `SECURITY DEFINER`: rodam com o dono delas, que é quem aplica as migrations (o papel
-- `verax_migrator`, dono das tabelas). Têm `search_path` fixo, referências com schema, piso conferido por elas mesmas
-- (um corte mais novo é recusado pela função, não só pela aplicação) e lote limitado. O EXECUTE sai de PUBLIC aqui;
-- o db-bootstrap concede só ao papel da aplicação (o nome dele só é conhecido lá).

-- CreateTable
CREATE TABLE "RetentionState" (
    "id" VARCHAR(32) NOT NULL,
    "appliedDays" INTEGER,
    "pendingSince" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RetentionState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "Incident_tenantId_lastSeenAt_idx" ON "Incident"("tenantId", "lastSeenAt");

-- O prazo aplicado nunca fica abaixo do piso de 30 dias dos planos (null é sem limite).
ALTER TABLE "RetentionState" ADD CONSTRAINT "RetentionState_appliedDays_check"
  CHECK ("appliedDays" IS NULL OR "appliedDays" >= 30);

-- Trilha de auditoria: UPDATE e TRUNCATE sempre bloqueados; DELETE só com a flag do expurgo e só de registro com mais
-- de 13 meses. A mensagem do bloqueio é a mesma de antes.
CREATE OR REPLACE FUNCTION "audit_log_reject_change"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('verax.retention', true) = 'on'
       AND OLD."occurredAt" < now() - interval '13 months' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'AuditLog é somente inserção: % bloqueado', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Comentários dos achados: o mesmo, com o piso de 30 dias pela data do comentário.
CREATE OR REPLACE FUNCTION "finding_comment_reject_change"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('verax.retention', true) = 'on'
       AND OLD."createdAt" < now() - interval '30 days' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'FindingComment é somente inserção: % bloqueado', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Apaga um lote da auditoria anterior ao corte, do mais antigo para o mais novo, e devolve quantos registros saíram de
-- cada cliente (null: registro sem cliente). Recusa um corte mais novo que o piso de 13 meses e um lote fora de 1 a
-- 1000.
CREATE FUNCTION "verax_purge_audit_log"(p_cutoff timestamptz, p_limit integer)
RETURNS TABLE (tenant_id text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
AS $$
DECLARE
  v_flag text := current_setting('verax.retention', true);
BEGIN
  IF p_cutoff IS NULL OR p_cutoff > now() - interval '13 months' THEN
    RAISE EXCEPTION 'expurgo da auditoria recusado: corte mais novo que o piso de 13 meses'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'expurgo da auditoria recusado: o lote vai de 1 a 1000 registros'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('verax.retention', 'on', true);
  RETURN QUERY
  WITH doomed AS (
    SELECT a."id" FROM public."AuditLog" AS a
    WHERE a."occurredAt" < p_cutoff
    ORDER BY a."occurredAt"
    LIMIT p_limit
  ), gone AS (
    DELETE FROM public."AuditLog" AS a USING doomed AS d
    WHERE a."id" = d."id"
    RETURNING a."tenantId"
  )
  SELECT g."tenantId", count(*)::integer FROM gone AS g GROUP BY g."tenantId";
  PERFORM set_config('verax.retention', coalesce(v_flag, ''), true);
END;
$$;

-- Apaga os comentários de um lote de achados que o expurgo vai apagar em seguida, na mesma transação (a chave
-- estrangeira do comentário é RESTRICT). Recusa o lote inteiro se algum achado tiver menos de 30 dias; o trigger
-- recusa o comentário com menos de 30 dias. Devolve quantos comentários saíram.
CREATE FUNCTION "verax_purge_finding_comments"(p_finding_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET timezone = 'UTC'
AS $$
DECLARE
  v_flag text := current_setting('verax.retention', true);
  v_deleted integer;
BEGIN
  IF p_finding_ids IS NULL OR cardinality(p_finding_ids) > 1000 THEN
    RAISE EXCEPTION 'expurgo dos comentários recusado: o lote vai até 1000 achados'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."Finding" AS f
    WHERE f."id" = ANY (p_finding_ids) AND f."occurredAt" >= now() - interval '30 days'
  ) THEN
    RAISE EXCEPTION 'expurgo dos comentários recusado: achado mais novo que o piso de 30 dias'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('verax.retention', 'on', true);
  DELETE FROM public."FindingComment" AS c WHERE c."findingId" = ANY (p_finding_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM set_config('verax.retention', coalesce(v_flag, ''), true);
  RETURN v_deleted;
END;
$$;

-- Ninguém executa as funções por padrão: o db-bootstrap concede o EXECUTE só ao papel da aplicação.
REVOKE ALL ON FUNCTION "verax_purge_audit_log"(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION "verax_purge_finding_comments"(uuid[]) FROM PUBLIC;
