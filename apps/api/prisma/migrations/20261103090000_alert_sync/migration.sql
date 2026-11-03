-- Sync de alertas (T5.3): fila sem dono, estado da sincronização, exceção aplicada e último evento por conta.

-- CreateEnum
CREATE TYPE "UnownedReason" AS ENUM ('invalid_alert', 'not_aws', 'unknown_source', 'ambiguous_source', 'no_account', 'conflicting_accounts', 'unknown_account', 'source_mismatch');

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "lastEventAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "exceptionId" UUID;

-- CreateTable
CREATE TABLE "UnownedAlert" (
    "id" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "sourceEventId" VARCHAR(128) NOT NULL,
    "reason" "UnownedReason" NOT NULL,
    "accounts" TEXT[],
    "occurredAt" TIMESTAMPTZ(3),
    "ruleId" VARCHAR(6),
    "ruleLevel" SMALLINT,
    "title" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnownedAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "name" VARCHAR(32) NOT NULL,
    "lastProcessedAt" TIMESTAMPTZ(3),
    "lastRunAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastError" VARCHAR(64),
    "leaseOwner" VARCHAR(64),
    "leaseUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "UnownedAlert_createdAt_idx" ON "UnownedAlert"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UnownedAlert_source_sourceEventId_key" ON "UnownedAlert"("source", "sourceEventId");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "AlertException"("id") ON DELETE SET NULL ON UPDATE CASCADE;

