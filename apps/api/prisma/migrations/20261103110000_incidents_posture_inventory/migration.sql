-- Incidentes (T5.6 e T5.7), postura (T5.8) e inventário (T5.9) gravados; achados ligados ao incidente e à triagem.

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('open', 'investigating', 'resolved');

-- CreateEnum
CREATE TYPE "PostureSeverity" AS ENUM ('critical', 'high', 'medium', 'low', 'informational');

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "incidentId" UUID,
ADD COLUMN     "triagedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'open',
    "riskScore" SMALLINT NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "keys" TEXT[],
    "accounts" TEXT[],
    "resources" TEXT[],
    "mitreTactics" TEXT[],
    "mitreTechniques" TEXT[],
    "assigneeId" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostureScan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" VARCHAR(32) NOT NULL,
    "scannedAt" TIMESTAMPTZ(3) NOT NULL,
    "score" SMALLINT,
    "weightPassed" INTEGER NOT NULL,
    "weightTotal" INTEGER NOT NULL,
    "passed" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "failedCritical" INTEGER NOT NULL,
    "failedHigh" INTEGER NOT NULL,
    "failedMedium" INTEGER NOT NULL,
    "failedLow" INTEGER NOT NULL,
    "failedInformational" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostureScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostureFailure" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "findingUid" VARCHAR(512) NOT NULL,
    "checkId" VARCHAR(160) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "severity" "PostureSeverity" NOT NULL,
    "region" VARCHAR(40) NOT NULL,
    "resource" VARCHAR(4000),
    "resourceType" VARCHAR(4000),
    "risk" VARCHAR(4000),
    "remediation" VARCHAR(4000),
    "references" TEXT[],

    CONSTRAINT "PostureFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" VARCHAR(32) NOT NULL,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL,
    "root" JSONB,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_tenantId_status_idx" ON "Incident"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Incident_tenantId_riskScore_idx" ON "Incident"("tenantId", "riskScore" DESC);

-- CreateIndex
CREATE INDEX "PostureScan_tenantId_accountId_scannedAt_idx" ON "PostureScan"("tenantId", "accountId", "scannedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PostureScan_tenantId_accountId_scannedAt_key" ON "PostureScan"("tenantId", "accountId", "scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostureScan_id_tenantId_key" ON "PostureScan"("id", "tenantId");

-- CreateIndex
CREATE INDEX "PostureFailure_tenantId_scanId_idx" ON "PostureFailure"("tenantId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "PostureFailure_scanId_findingUid_key" ON "PostureFailure"("scanId", "findingUid");

-- CreateIndex
CREATE INDEX "InventorySnapshot_tenantId_accountId_collectedAt_idx" ON "InventorySnapshot"("tenantId", "accountId", "collectedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_tenantId_accountId_collectedAt_key" ON "InventorySnapshot"("tenantId", "accountId", "collectedAt");

-- CreateIndex
CREATE INDEX "Finding_incidentId_idx" ON "Finding"("incidentId");

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostureScan" ADD CONSTRAINT "PostureScan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostureFailure" ADD CONSTRAINT "PostureFailure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostureFailure" ADD CONSTRAINT "PostureFailure_scanId_tenantId_fkey" FOREIGN KEY ("scanId", "tenantId") REFERENCES "PostureScan"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- O achado só entra em incidente do mesmo cliente, venha a escrita da API, do sync ou de alguém com o usuário da
-- aplicação. (A chave estrangeira composta não serve aqui: `incidentId` é opcional e `tenantId` não.)
CREATE FUNCTION "finding_incident_same_tenant"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."incidentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Incident" WHERE "id" = NEW."incidentId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'achado e incidente de clientes diferentes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Finding_incident_same_tenant"
  BEFORE INSERT OR UPDATE OF "incidentId", "tenantId" ON "Finding"
  FOR EACH ROW EXECUTE FUNCTION "finding_incident_same_tenant"();
