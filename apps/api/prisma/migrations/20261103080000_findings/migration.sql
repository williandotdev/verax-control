-- Achados (T5.3 a T5.5) e comentários. Os achados chegam pelo sync do Wazuh; aqui ficam os estados humanos.

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('new', 'investigating', 'legitimate', 'resolved');

-- CreateTable
CREATE TABLE "Finding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" VARCHAR(32) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "sourceEventId" VARCHAR(128) NOT NULL,
    "logSource" VARCHAR(32) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'new',
    "ruleId" VARCHAR(6) NOT NULL,
    "ruleLevel" SMALLINT NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "eventName" VARCHAR(256),
    "region" VARCHAR(64),
    "resource" VARCHAR(2048),
    "actorUser" VARCHAR(512),
    "actorType" VARCHAR(64),
    "accessKeyId" VARCHAR(128),
    "sourceIp" VARCHAR(64),
    "mitreTactics" TEXT[],
    "mitreTechniques" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingComment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "findingId" UUID NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Finding_tenantId_occurredAt_idx" ON "Finding"("tenantId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Finding_tenantId_status_idx" ON "Finding"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_source_sourceEventId_key" ON "Finding"("source", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_id_tenantId_key" ON "Finding"("id", "tenantId");

-- CreateIndex
CREATE INDEX "FindingComment_findingId_createdAt_idx" ON "FindingComment"("findingId", "createdAt");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingComment" ADD CONSTRAINT "FindingComment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingComment" ADD CONSTRAINT "FindingComment_findingId_tenantId_fkey" FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingComment" ADD CONSTRAINT "FindingComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Comentários só aceitam INSERT: são o registro de quem decidiu o quê sobre o achado. Qualquer UPDATE, DELETE ou
-- TRUNCATE falha, venha da aplicação, de um script ou de alguém com o usuário da aplicação.
CREATE FUNCTION "finding_comment_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FindingComment é somente inserção: % bloqueado', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "FindingComment_no_update_delete"
  BEFORE UPDATE OR DELETE ON "FindingComment"
  FOR EACH ROW EXECUTE FUNCTION "finding_comment_reject_change"();

CREATE TRIGGER "FindingComment_no_truncate"
  BEFORE TRUNCATE ON "FindingComment"
  FOR EACH STATEMENT EXECUTE FUNCTION "finding_comment_reject_change"();
