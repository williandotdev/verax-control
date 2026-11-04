-- Agentes do Wazuh nas instâncias do cliente (desligado por padrão em cada nó): a lista que o worker grava a partir do
-- que o host exporta da API do manager, no cliente do nó. O painel só lê.

-- CreateEnum
CREATE TYPE "WazuhAgentStatus" AS ENUM ('active', 'disconnected', 'pending', 'never_connected');

-- CreateTable
CREATE TABLE "WazuhAgent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "agentId" VARCHAR(8) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "ip" VARCHAR(64),
    "osName" VARCHAR(128),
    "osVersion" VARCHAR(64),
    "osPlatform" VARCHAR(32),
    "version" VARCHAR(32),
    "status" "WazuhAgentStatus" NOT NULL,
    "lastKeepAliveAt" TIMESTAMPTZ(3),
    "registeredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WazuhAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WazuhAgent_tenantId_name_idx" ON "WazuhAgent"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WazuhAgent_agentId_key" ON "WazuhAgent"("agentId");

-- AddForeignKey
ALTER TABLE "WazuhAgent" ADD CONSTRAINT "WazuhAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

