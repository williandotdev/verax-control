-- Preferência de aviso e resumo por hora (fase 2, PR-17'): a escolha de cada pessoa sobre os avisos de incidente por
-- e-mail e a hora de avisos de cada pessoa (a contagem dos e-mails avulsos e, do 6º em diante, o resumo). Nenhum
-- endereço de e-mail fica aqui: a pessoa é resolvida no envio, como na fila de saída do PR-16.

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "digestedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "incidentEmails" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "NotificationDigest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "hourStart" TIMESTAMPTZ(3) NOT NULL,
    "individualSent" SMALLINT NOT NULL DEFAULT 0,
    "noticeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "catchUp" BOOLEAN NOT NULL DEFAULT false,
    "status" "NotificationStatus",
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "lastError" VARCHAR(64),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationPreference_tenantId_idx" ON "NotificationPreference"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationDigest_status_nextAttemptAt_idx" ON "NotificationDigest"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationDigest_userId_idx" ON "NotificationDigest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDigest_tenantId_userId_hourStart_key" ON "NotificationDigest"("tenantId", "userId", "hourStart");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A pessoa da preferência e da hora de avisos é sempre do mesmo cliente da linha, como o incidente do aviso
-- (`notification_incident_same_tenant`): a tabela de usuários (do Better Auth) não tem o par id e cliente único para
-- uma chave estrangeira composta. A equipe da Verax, sem cliente, nunca passa.
CREATE FUNCTION "notice_user_same_tenant"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "User" WHERE "id" = NEW."userId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'preferência ou resumo de pessoa de outro cliente'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "NotificationPreference_user_same_tenant"
  BEFORE INSERT OR UPDATE OF "userId", "tenantId" ON "NotificationPreference"
  FOR EACH ROW EXECUTE FUNCTION "notice_user_same_tenant"();

CREATE TRIGGER "NotificationDigest_user_same_tenant"
  BEFORE INSERT OR UPDATE OF "userId", "tenantId" ON "NotificationDigest"
  FOR EACH ROW EXECUTE FUNCTION "notice_user_same_tenant"();

-- Regras que o Prisma não descreve: a hora é sempre cheia; o resumo só tem estado (e hora de sair) quando reuniu algum
-- aviso, e reunir um aviso sempre lhe dá estado; as tentativas vão de 0 a 5, como as do aviso.
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_hour_start_check"
  CHECK (EXTRACT(EPOCH FROM "hourStart") % 3600 = 0);
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_items_status_check"
  CHECK (("status" IS NULL) = (cardinality("noticeIds") = 0));
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_next_attempt_check"
  CHECK ("status" IS NULL OR "nextAttemptAt" IS NOT NULL);
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_individual_sent_check"
  CHECK ("individualSent" >= 0);
ALTER TABLE "NotificationDigest" ADD CONSTRAINT "NotificationDigest_attempts_check"
  CHECK ("attempts" BETWEEN 0 AND 5);
