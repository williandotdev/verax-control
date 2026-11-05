-- Contato de escalonamento (decisão D8 da fase 2): os avisos críticos chegam também ao contato do cadastro do cliente,
-- mas só depois de ele confirmar o endereço por um link de uso único, e cada e-mail leva o link para deixar de receber.
-- Os links ficam só como SHA-256; o endereço continua só no cadastro do cliente (nada dele na fila de saída).

-- CreateEnum
CREATE TYPE "EscalationContactState" AS ENUM ('pending', 'confirmed', 'unsubscribed');

-- CreateEnum
CREATE TYPE "EscalationDelivery" AS ENUM ('sent', 'limited', 'stale');

-- CreateEnum
CREATE TYPE "EscalationTokenPurpose" AS ENUM ('confirm', 'unsubscribe');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'escalation_confirmation';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "escalationDeliveredAt" TIMESTAMPTZ(3),
ADD COLUMN     "escalationDelivery" "EscalationDelivery",
ADD COLUMN     "escalationGeneration" INTEGER;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "escalationConfirmedAt" TIMESTAMPTZ(3),
ADD COLUMN     "escalationGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "escalationState" "EscalationContactState",
ADD COLUMN     "escalationUnsubscribedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "EscalationContactToken" (
    "tokenHash" CHAR(64) NOT NULL,
    "tenantId" UUID NOT NULL,
    "purpose" "EscalationTokenPurpose" NOT NULL,
    "generation" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscalationContactToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "PublicLinkAttempt" (
    "key" VARCHAR(100) NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublicLinkAttempt_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "EscalationContactToken_tenantId_generation_idx" ON "EscalationContactToken"("tenantId", "generation");

-- CreateIndex
CREATE INDEX "PublicLinkAttempt_windowStart_idx" ON "PublicLinkAttempt"("windowStart");

-- AddForeignKey
ALTER TABLE "EscalationContactToken" ADD CONSTRAINT "EscalationContactToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Contatos que já existiam: aguardando confirmação. Nenhum e-mail sai sozinho por causa desta migration; quem administra
-- o cliente pede a confirmação pelo painel.
UPDATE "Tenant" SET "escalationState" = 'pending' WHERE "escalationEmail" IS NOT NULL;

-- Regras que o Prisma não descreve. No cadastro: há estado se e só se há endereço; a data da confirmação só no estado
-- confirmado, e a do descadastro só no descadastrado; a geração nunca é negativa.
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_escalation_state_check"
  CHECK (("escalationState" IS NULL) = ("escalationEmail" IS NULL));
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_escalation_confirmed_at_check"
  CHECK (("escalationState" IS NOT DISTINCT FROM 'confirmed') = ("escalationConfirmedAt" IS NOT NULL));
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_escalation_unsubscribed_at_check"
  CHECK (("escalationState" IS NOT DISTINCT FROM 'unsubscribed') = ("escalationUnsubscribedAt" IS NOT NULL));
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_escalation_generation_check" CHECK ("escalationGeneration" >= 0);

-- Na fila de saída: o pedido de confirmação tem a geração do endereço e nenhum outro alvo (o tipo novo é comparado como
-- texto, porque o valor acrescentado ao enum só vale depois do commit); a entrega ao contato só existe nos avisos
-- críticos de incidente e de achado, sempre com a hora.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_escalation_generation_check"
  CHECK (("kind"::text = 'escalation_confirmation') = ("escalationGeneration" IS NOT NULL));
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_escalation_confirmation_target_check"
  CHECK (
    "kind"::text <> 'escalation_confirmation'
    OR ("severity" IS NULL AND "incidentId" IS NULL AND "findingId" IS NULL AND "usageMonth" IS NULL AND "usagePercent" IS NULL)
  );
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_escalation_delivery_check"
  CHECK (
    "escalationDelivery" IS NULL
    OR ("severity" = 'critical' AND "kind"::text IN ('incident_opened', 'incident_escalated', 'critical_finding'))
  );
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_escalation_delivered_at_check"
  CHECK (("escalationDelivery" IS NULL) = ("escalationDeliveredAt" IS NULL));

-- Os links: geração de um endereço que já pediu confirmação (a partir de 1) e validade depois da criação.
ALTER TABLE "EscalationContactToken" ADD CONSTRAINT "EscalationContactToken_generation_check"
  CHECK ("generation" >= 1);
ALTER TABLE "EscalationContactToken" ADD CONSTRAINT "EscalationContactToken_expires_check"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "EscalationContactToken" ADD CONSTRAINT "EscalationContactToken_hash_check"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- O limite por IP das rotas públicas: contagem positiva.
ALTER TABLE "PublicLinkAttempt" ADD CONSTRAINT "PublicLinkAttempt_count_check" CHECK ("count" >= 1);
