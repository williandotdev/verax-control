-- Plano por cliente (fase 3, CE-02). ⚠️ Cria uma função de expurgo da auditoria por cliente: revisão linha a linha,
-- como a migration `20261109120000_history_retention`.
--
-- 1. `TenantPlan`: o plano de cada cliente (limites, histórico e a franquia da Plataforma em GB/dia). No nó dedicado,
--    a API e o worker o semeiam do `node.conf`; na célula, o comando do plano de controle o grava. A combinação de
--    plano, limites e franquia vale por CHECK, a mesma regra de `tenantPlanProblems` (`packages/shared/src/plans.ts`).
-- 2. `TenantRetentionState`: o prazo do expurgo e a carência de 30 dias passam a ser de cada cliente. Cada cliente
--    herda o estado do nó (`RetentionState`), para uma carência em curso não se perder na troca de versão.
-- 3. `verax_purge_tenant_audit_log`: o expurgo da auditoria de um cliente só, com o mesmo piso de 13 meses conferido
--    no banco. Com prazos diferentes por cliente, o corte global (`verax_purge_audit_log`) usa o mais antigo de todos
--    e esta função apaga, de cada cliente com prazo menor, o que passou do dele. Nada mais muda na imutabilidade: o
--    trigger continua exigindo a flag do expurgo e os 13 meses linha a linha, o papel da aplicação continua sem DELETE
--    na tabela, e o EXECUTE sai de PUBLIC aqui (o db-bootstrap concede só ao papel da aplicação).

-- CreateEnum
CREATE TYPE "TenantPlanSource" AS ENUM ('env', 'control_plane');

-- CreateTable
CREATE TABLE "TenantPlan" (
    "tenantId" UUID NOT NULL,
    "planId" VARCHAR(20) NOT NULL,
    "maxCloudAccounts" INTEGER,
    "maxUsers" INTEGER,
    "monthlyGib" INTEGER,
    "historyDays" INTEGER,
    "franchiseGbPerDay" INTEGER,
    "source" "TenantPlanSource" NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TenantPlan_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "TenantRetentionState" (
    "job" VARCHAR(32) NOT NULL,
    "tenantId" UUID NOT NULL,
    "appliedDays" INTEGER,
    "pendingSince" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TenantRetentionState_pkey" PRIMARY KEY ("job","tenantId")
);

-- CreateIndex
CREATE INDEX "TenantRetentionState_tenantId_idx" ON "TenantRetentionState"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantPlan" ADD CONSTRAINT "TenantPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantRetentionState" ADD CONSTRAINT "TenantRetentionState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- O plano é um dos conhecidos, e cada limite fica na faixa que o plano aceita (`PLAN_LIMIT_BOUNDS` e
-- `FRANCHISE_GB_PER_DAY_BOUNDS`); null é sem limite.
ALTER TABLE "TenantPlan" ADD CONSTRAINT "TenantPlan_planId_check"
  CHECK ("planId" IN ('essencial', 'profissional', 'enterprise', 'interno', 'plataforma'));
ALTER TABLE "TenantPlan" ADD CONSTRAINT "TenantPlan_limits_range_check" CHECK (
  ("maxCloudAccounts" IS NULL OR "maxCloudAccounts" BETWEEN 1 AND 1000)
  AND ("maxUsers" IS NULL OR "maxUsers" BETWEEN 1 AND 1000)
  AND ("monthlyGib" IS NULL OR "monthlyGib" BETWEEN 1 AND 100000)
  AND ("historyDays" IS NULL OR "historyDays" BETWEEN 30 AND 3650)
  AND ("franchiseGbPerDay" IS NULL OR "franchiseGbPerDay" BETWEEN 1 AND 1000)
);
-- A combinação: o interno sem limite nenhum; a Plataforma com contas, usuários, histórico e franquia, sem volume do
-- mês; os outros com os quatro limites e sem franquia.
ALTER TABLE "TenantPlan" ADD CONSTRAINT "TenantPlan_combination_check" CHECK (
  CASE "planId"
    WHEN 'interno' THEN "maxCloudAccounts" IS NULL AND "maxUsers" IS NULL AND "monthlyGib" IS NULL
      AND "historyDays" IS NULL AND "franchiseGbPerDay" IS NULL
    WHEN 'plataforma' THEN "maxCloudAccounts" IS NOT NULL AND "maxUsers" IS NOT NULL AND "monthlyGib" IS NULL
      AND "historyDays" IS NOT NULL AND "franchiseGbPerDay" IS NOT NULL
    ELSE "maxCloudAccounts" IS NOT NULL AND "maxUsers" IS NOT NULL AND "monthlyGib" IS NOT NULL
      AND "historyDays" IS NOT NULL AND "franchiseGbPerDay" IS NULL
  END
);

-- O prazo aplicado a um cliente nunca fica abaixo do piso de 30 dias dos planos (null é sem limite).
ALTER TABLE "TenantRetentionState" ADD CONSTRAINT "TenantRetentionState_appliedDays_check"
  CHECK ("appliedDays" IS NULL OR "appliedDays" >= 30);

-- Cada cliente herda o estado do expurgo do nó: uma carência em curso (o plano diminuiu há menos de 30 dias) continua
-- contando da mesma data, e o prazo aplicado é o mesmo de antes.
INSERT INTO "TenantRetentionState" ("job", "tenantId", "appliedDays", "pendingSince", "updatedAt")
SELECT r."id", t."id", r."appliedDays", r."pendingSince", r."updatedAt"
FROM "RetentionState" AS r CROSS JOIN "Tenant" AS t;

-- Apaga um lote da auditoria de um cliente anterior ao corte, do mais antigo para o mais novo, e devolve quantos
-- registros saíram. As mesmas recusas de `verax_purge_audit_log`: corte mais novo que o piso de 13 meses e lote fora
-- de 1 a 1000; e também o cliente nulo (os registros sem cliente são da função global).
CREATE FUNCTION "verax_purge_tenant_audit_log"(p_tenant_id uuid, p_cutoff timestamptz, p_limit integer)
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
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'expurgo da auditoria recusado: informe o cliente'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cutoff IS NULL OR p_cutoff > now() - interval '13 months' THEN
    RAISE EXCEPTION 'expurgo da auditoria recusado: corte mais novo que o piso de 13 meses'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'expurgo da auditoria recusado: o lote vai de 1 a 1000 registros'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('verax.retention', 'on', true);
  WITH doomed AS (
    SELECT a."id" FROM public."AuditLog" AS a
    WHERE a."tenantId" = p_tenant_id::text AND a."occurredAt" < p_cutoff
    ORDER BY a."occurredAt"
    LIMIT p_limit
  )
  DELETE FROM public."AuditLog" AS a USING doomed AS d WHERE a."id" = d."id";
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM set_config('verax.retention', coalesce(v_flag, ''), true);
  RETURN v_deleted;
END;
$$;

-- Ninguém executa a função por padrão: o db-bootstrap concede o EXECUTE só ao papel da aplicação.
REVOKE ALL ON FUNCTION "verax_purge_tenant_audit_log"(uuid, timestamptz, integer) FROM PUBLIC;
