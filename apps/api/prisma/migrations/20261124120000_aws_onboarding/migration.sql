-- Onboarding self-service da AWS (`docs/ARQUITETURA.md`, "Onboarding AWS self-service"): o cliente clica em "Conectar
-- com AWS", o nó espera o papel de leitura aparecer, descobre sozinho as fontes de log da conta e o cliente autoriza as
-- que quer coletar. Só acrescenta: nenhuma coluna existente muda, e os buckets cadastrados (`cloudtrailBucket`,
-- `guarddutyBucket`, `wafBucket`) continuam valendo como antes.
--
-- 1. `CloudAccount`: o pedido do "Conectar" (`awsConnectRequestedAt`), a versão do template e as capacidades do papel
--    lidas das tags dele (`awsTemplateVersion`, `awsCapabilities`, `awsCapabilitiesCheckedAt`) e as regiões com recurso
--    ou fonte (`awsDiscoveredRegions`). Só conta AWS (CHECK).
-- 2. `AwsDiscoveryRun`: cada execução da descoberta (tarefa `aws-discovery` do worker), com o que ficou de fora
--    (`errors`) e o retrato da infraestrutura (`summary`).
-- 3. `AwsSource`: uma linha por fonte de log (conta, tipo, região e recurso), com a disponibilidade, a permissão, a
--    autorização do cliente, o estado e a saúde da coleta. As duas tabelas têm `tenantId` (entram no escopo do cliente)
--    e chave estrangeira composta com a conta: o banco recusa a linha de um cliente na conta de outro.
-- 4. Os buckets já cadastrados viram linhas `origin = legacy`, autorizadas, com a coleta a partir do `ingestFrom` da
--    conta: para quem já coleta, nada muda. Depois desta migration, quem mantém o espelho é a aplicação
--    (`aws/onboarding/legacy-sources.ts`), a cada mudança dos buckets ou do `ingestFrom`.
--
-- Os CHECKs repetem no banco os valores do contrato (`packages/shared/src/aws-onboarding.ts`); um teste confere que os
-- dois continuam iguais.

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "awsCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "awsCapabilitiesCheckedAt" TIMESTAMPTZ(3),
ADD COLUMN     "awsConnectRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "awsDiscoveredRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "awsTemplateVersion" INTEGER;

-- CreateTable
CREATE TABLE "AwsDiscoveryRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cloudAccountId" UUID NOT NULL,
    "trigger" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errors" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB,
    "requestedBy" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AwsDiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwsSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cloudAccountId" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "region" VARCHAR(32) NOT NULL,
    "resourceId" VARCHAR(512) NOT NULL,
    "name" VARCHAR(512) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "method" VARCHAR(16) NOT NULL,
    "availability" VARCHAR(32) NOT NULL,
    "loggingState" VARCHAR(16),
    "permission" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "permissionDetail" VARCHAR(96),
    "permissionCheckedAt" TIMESTAMPTZ(3),
    "probeRequestedAt" TIMESTAMPTZ(3),
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" VARCHAR(16) NOT NULL DEFAULT 'discovered',
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingSince" TIMESTAMPTZ(3),
    "authorizedAt" TIMESTAMPTZ(3),
    "authorizedBy" VARCHAR(64),
    "revokedAt" TIMESTAMPTZ(3),
    "collectFrom" DATE,
    "state" VARCHAR(24) NOT NULL,
    "stateCode" VARCHAR(64),
    "stateSince" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastEventAt" TIMESTAMPTZ(3),
    "lastIngestedAt" TIMESTAMPTZ(3),
    "lagSeconds" INTEGER,
    "eventsLast24h" INTEGER,
    "bytesLast24h" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AwsSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AwsDiscoveryRun_tenantId_idx" ON "AwsDiscoveryRun"("tenantId");

-- CreateIndex
CREATE INDEX "AwsDiscoveryRun_cloudAccountId_requestedAt_idx" ON "AwsDiscoveryRun"("cloudAccountId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "AwsDiscoveryRun_status_requestedAt_idx" ON "AwsDiscoveryRun"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "AwsSource_tenantId_idx" ON "AwsSource"("tenantId");

-- CreateIndex
CREATE INDEX "AwsSource_cloudAccountId_state_idx" ON "AwsSource"("cloudAccountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "AwsSource_cloudAccountId_kind_region_resourceId_key" ON "AwsSource"("cloudAccountId", "kind", "region", "resourceId");

-- AddForeignKey
ALTER TABLE "AwsDiscoveryRun" ADD CONSTRAINT "AwsDiscoveryRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwsDiscoveryRun" ADD CONSTRAINT "AwsDiscoveryRun_cloudAccountId_tenantId_fkey" FOREIGN KEY ("cloudAccountId", "tenantId") REFERENCES "CloudAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_cloudAccountId_tenantId_fkey" FOREIGN KEY ("cloudAccountId", "tenantId") REFERENCES "CloudAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;


-- As colunas do onboarding só existem na conta AWS; a versão do template começa em 1, e as capacidades são as do
-- template.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_aws_onboarding_check" CHECK (
  (
    "provider" = 'aws'
    OR (
      "awsConnectRequestedAt" IS NULL
      AND "awsTemplateVersion" IS NULL
      AND "awsCapabilitiesCheckedAt" IS NULL
      AND cardinality("awsCapabilities") = 0
      AND cardinality("awsDiscoveredRegions") = 0
    )
  )
  AND ("awsTemplateVersion" IS NULL OR "awsTemplateVersion" >= 1)
  AND "awsCapabilities" <@ ARRAY['discovery', 'service-logs', 'findings', 'log-groups']::text[]
);

-- A execução: quem a pediu e em que passo está. Pendente ainda não começou; terminada tem o horário do fim.
ALTER TABLE "AwsDiscoveryRun" ADD CONSTRAINT "AwsDiscoveryRun_trigger_check" CHECK (
  "trigger" IN ('connect', 'manual', 'scheduled')
);
ALTER TABLE "AwsDiscoveryRun" ADD CONSTRAINT "AwsDiscoveryRun_status_check" CHECK (
  "status" IN ('pending', 'running', 'succeeded', 'partial', 'failed')
  AND (("status" = 'pending') = ("startedAt" IS NULL))
  AND (("status" IN ('succeeded', 'partial', 'failed')) = ("finishedAt" IS NOT NULL))
);
ALTER TABLE "AwsDiscoveryRun" ADD CONSTRAINT "AwsDiscoveryRun_payload_check" CHECK (
  jsonb_typeof("errors") = 'array'
  AND ("summary" IS NULL OR jsonb_typeof("summary") = 'object')
  AND ("requestedBy" IS NULL OR "trigger" = 'manual')
);

-- A fonte: os valores do contrato.
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_kind_check" CHECK (
  "kind" IN (
    'cloudtrail', 'vpc_flow_logs', 'waf', 'guardduty_export', 'guardduty', 'security_hub', 'inspector',
    'access_analyzer', 'cloudwatch_log_group', 'config', 'elb_logs'
  )
  AND "method" IN ('s3', 'api', 'cloudwatch')
  AND "origin" IN ('discovered', 'legacy')
);
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_region_check" CHECK (
  "region" = 'global' OR "region" ~ '^[a-z]{2}(-[a-z]{1,16}){1,2}-[0-9]$'
);
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_discovery_check" CHECK (
  "availability" IN ('available', 'not_enabled', 'no_destination', 'unsupported_destination', 'unsupported_format')
  AND ("loggingState" IS NULL OR "loggingState" IN ('logging', 'stopped', 'enabled', 'disabled', 'publishing'))
  AND "permission" IN ('granted', 'missing', 'unknown')
  AND ("permissionDetail" IS NULL OR "permissionDetail" ~ '^[A-Za-z0-9_:-]{1,96}$')
  AND jsonb_typeof("details") = 'object'
  AND "notes" <@ ARRAY[
    'aws_cost_guardduty', 'aws_cost_security_hub', 'aws_cost_inspector', 'aws_cost_access_analyzer',
    'aws_cost_new_trail', 'aws_cost_flow_logs', 'aws_cost_waf_logging', 'high_volume', 'tag_required',
    'stack_update_required', 'additional_bucket_required', 'central_bucket', 'covered_by_api', 'covered_by_legacy',
    'recommended', 'not_security_events', 'not_collected_yet'
  ]::text[]
);
-- O estado e a autorização andam juntos: só a fonte com a autorização valendo fica num estado de coleta; a revogada tem
-- o horário da revogação (e só ela); a coleta só tem data de início depois de uma autorização.
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_state_check" CHECK (
  "state" IN (
    'available', 'needs_permission', 'unavailable', 'authorized', 'configuring', 'waiting_events', 'collecting',
    'stalled', 'permission_error', 'ingestion_error', 'source_missing', 'revoked'
  )
  AND ("stateCode" IS NULL OR "stateCode" ~ '^[A-Za-z0-9_.:-]{1,64}$')
  AND (
    "state" NOT IN (
      'authorized', 'configuring', 'waiting_events', 'collecting', 'stalled', 'permission_error', 'ingestion_error'
    )
    OR ("authorizedAt" IS NOT NULL AND "revokedAt" IS NULL)
  )
  AND (("state" = 'revoked') = ("revokedAt" IS NOT NULL))
  AND ("revokedAt" IS NULL OR "authorizedAt" IS NOT NULL)
  AND ("authorizedBy" IS NULL OR "authorizedAt" IS NOT NULL)
  AND ("collectFrom" IS NULL OR "authorizedAt" IS NOT NULL)
);
-- A linha de um bucket cadastrado antes da descoberta: um dos três tipos lidos de bucket, uma por tipo e conta.
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_legacy_check" CHECK (
  ("origin" = 'legacy') = ("resourceId" = 'legacy')
  AND (
    "origin" <> 'legacy'
    OR ("kind" IN ('cloudtrail', 'guardduty_export', 'waf') AND "region" = 'global' AND "method" = 's3')
  )
);
ALTER TABLE "AwsSource" ADD CONSTRAINT "AwsSource_health_check" CHECK (
  ("lagSeconds" IS NULL OR "lagSeconds" >= 0)
  AND ("eventsLast24h" IS NULL OR "eventsLast24h" >= 0)
  AND ("bytesLast24h" IS NULL OR "bytesLast24h" >= 0)
);

-- Os buckets já cadastrados: uma fonte por bucket, autorizada, com a coleta a partir do `ingestFrom` da conta (null
-- na conta ainda não verificada: a aplicação o preenche na primeira verificação). A permissão fica por conferir: a
-- descoberta a sonda.
INSERT INTO "AwsSource" (
  "id", "tenantId", "cloudAccountId", "kind", "region", "resourceId", "name", "details", "method", "availability",
  "permission", "origin", "authorizedAt", "collectFrom", "state", "stateCode", "updatedAt"
)
SELECT
  uuidv7(),
  account."tenantId",
  account."id",
  legacy."kind",
  'global',
  'legacy',
  legacy."bucket",
  jsonb_build_object('bucket', legacy."bucket", 'legacySource', legacy."source"),
  's3',
  'available',
  'unknown',
  'legacy',
  CURRENT_TIMESTAMP,
  account."ingestFrom",
  'authorized',
  'awaiting_collector',
  CURRENT_TIMESTAMP
FROM "CloudAccount" account
CROSS JOIN LATERAL (
  VALUES
    ('cloudtrail', 'cloudtrail', account."cloudtrailBucket"),
    ('guardduty_export', 'guardduty', account."guarddutyBucket"),
    ('waf', 'waf', account."wafBucket")
) AS legacy("kind", "source", "bucket")
WHERE account."provider" = 'aws' AND legacy."bucket" IS NOT NULL;
