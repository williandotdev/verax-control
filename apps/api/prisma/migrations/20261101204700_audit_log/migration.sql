-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'system', 'anonymous');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'failure', 'denied');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "tenantId" TEXT,
    "action" VARCHAR(200) NOT NULL,
    "resourceType" VARCHAR(100),
    "resourceId" VARCHAR(200),
    "outcome" "AuditOutcome" NOT NULL,
    "statusCode" SMALLINT,
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(256),
    "requestId" VARCHAR(64),

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_occurredAt_idx" ON "AuditLog"("tenantId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_occurredAt_idx" ON "AuditLog"("actorId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- Imutabilidade (T1.3): a trilha de auditoria só aceita INSERT. Qualquer UPDATE, DELETE ou TRUNCATE falha,
-- venha da aplicação, de um script ou de alguém com acesso ao banco pelo usuário da aplicação.
-- Em produção a aplicação roda com um papel sem privilégio de dono (E8), que nem pode remover o trigger.
CREATE FUNCTION "audit_log_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog é somente inserção: % bloqueado', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "AuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_change"();

CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_reject_change"();
