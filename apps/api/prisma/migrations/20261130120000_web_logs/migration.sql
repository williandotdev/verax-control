-- Ataques web pelos logs de acesso do ALB (PR-2 do desenho de 24/11/2026): o banco. Nenhuma tarefa, rota de gravação ou tela
-- usa estas tabelas ainda, e nenhum achado ganha evidência nesta versão.
--
-- 1. `WebSourceSettings`, `WebTrustedSource` e `WebRoute`: a configuração do cliente, por balanceador.
-- 2. `WebLogObject`: os objetos do S3 já tratados, um por objeto (nenhum conta duas vezes). 10 dias.
-- 3. `FindingEvidence`: a evidência mascarada de um achado, no lugar da linha de log, que nunca é guardada.
-- 4. `WebEngineState`: o resumo do dia de cada balanceador, entre reinícios do worker.
-- 5. `WebTrafficSlot` e `WebTrafficHour`: as contagens por país do mapa (48 h de 5 em 5 minutos; 35 dias por hora). Nenhum
--    IP e nenhum caminho.
--
-- Só acrescenta: tabelas novas e um índice único na `AwsSource` (o id já é único; é o alvo das chaves compostas). A imagem
-- anterior do nó continua funcionando neste esquema (a volta de versão não desfaz migrations):
--   - nenhuma coluna, enum ou CHECK que ela usa muda;
--   - toda chave estrangeira nova é em cascata: ela apaga achado, fonte, conta e cliente sem conhecer as tabelas novas, e o
--     que é deles sai junto;
--   - ela não grava nas tabelas novas, e o expurgo dela não as limpa: o que houver fica parado até a volta da versão.
--
-- As chaves compostas levam o cliente e não se propagam na troca dele (`ON UPDATE RESTRICT`): nada cruza de um cliente para
-- outro, venha a escrita de onde vier.
--
-- Numa transação só (BEGIN e COMMIT): o `prisma migrate deploy` não abre uma por arquivo, e uma falha no meio deixaria
-- metade do esquema. As migrations rodam com a API e o worker parados (`infra/node/bin/start.sh`).
BEGIN;

-- CreateTable
CREATE TABLE "WebSourceSettings" (
    "sourceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "mode" VARCHAR(16) NOT NULL DEFAULT 'observe',
    "observeUntil" TIMESTAMPTZ(3),
    "thresholdMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" VARCHAR(64),

    CONSTRAINT "WebSourceSettings_pkey" PRIMARY KEY ("sourceId","tenantId")
);

-- CreateTable
CREATE TABLE "WebTrustedSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID,
    "cidr" VARCHAR(49) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" VARCHAR(64),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" VARCHAR(64),

    CONSTRAINT "WebTrustedSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebRoute" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "host" VARCHAR(253),
    "method" VARCHAR(8) NOT NULL DEFAULT 'ANY',
    "path" VARCHAR(256) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "failureCodes" SMALLINT[] DEFAULT ARRAY[]::SMALLINT[],
    "successCodes" SMALLINT[] DEFAULT ARRAY[]::SMALLINT[],
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" VARCHAR(64),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" VARCHAR(64),

    CONSTRAINT "WebRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebLogObject" (
    "cloudAccountId" UUID NOT NULL,
    "objectHash" CHAR(64) NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "slotStart" TIMESTAMPTZ(3),
    "lines" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "malformed" INTEGER NOT NULL DEFAULT 0,
    "oversize" INTEGER NOT NULL DEFAULT 0,
    "foreign" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebLogObject_pkey" PRIMARY KEY ("cloudAccountId","objectHash")
);

-- CreateTable
CREATE TABLE "FindingEvidence" (
    "findingId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" SMALLINT NOT NULL,
    "data" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "samplesPurgedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FindingEvidence_pkey" PRIMARY KEY ("findingId","tenantId")
);

-- CreateTable
CREATE TABLE "WebEngineState" (
    "sourceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "loadBalancer" VARCHAR(128) NOT NULL,
    "version" SMALLINT NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebEngineState_pkey" PRIMARY KEY ("sourceId","tenantId")
);

-- CreateTable
CREATE TABLE "WebTrafficSlot" (
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "slotStart" TIMESTAMPTZ(3) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "clientClass" VARCHAR(10) NOT NULL,
    "requests" BIGINT NOT NULL,
    "blocked" BIGINT NOT NULL,
    "clientErrors" BIGINT NOT NULL,
    "serverErrors" BIGINT NOT NULL,
    "flagged" BIGINT NOT NULL,

    CONSTRAINT "WebTrafficSlot_pkey" PRIMARY KEY ("tenantId","sourceId","slotStart","country","clientClass")
);

-- CreateTable
CREATE TABLE "WebTrafficHour" (
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "hourStart" TIMESTAMPTZ(3) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "clientClass" VARCHAR(10) NOT NULL,
    "requests" BIGINT NOT NULL,
    "blocked" BIGINT NOT NULL,
    "clientErrors" BIGINT NOT NULL,
    "serverErrors" BIGINT NOT NULL,
    "flagged" BIGINT NOT NULL,

    CONSTRAINT "WebTrafficHour_pkey" PRIMARY KEY ("tenantId","sourceId","hourStart","country","clientClass")
);

-- CreateIndex
CREATE INDEX "WebSourceSettings_tenantId_idx" ON "WebSourceSettings"("tenantId");

-- CreateIndex
-- A faixa não se repete também entre as que valem para todos os balanceadores (sem fonte).
CREATE UNIQUE INDEX "WebTrustedSource_tenantId_sourceId_cidr_key" ON "WebTrustedSource"("tenantId", "sourceId", "cidr") NULLS NOT DISTINCT;

-- CreateIndex
-- A rota de qualquer host (sem host) também não se repete.
CREATE UNIQUE INDEX "WebRoute_tenantId_sourceId_host_method_path_key" ON "WebRoute"("tenantId", "sourceId", "host", "method", "path") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "WebLogObject_tenantId_readAt_idx" ON "WebLogObject"("tenantId", "readAt");

-- CreateIndex
CREATE INDEX "WebLogObject_sourceId_slotStart_idx" ON "WebLogObject"("sourceId", "slotStart");

-- CreateIndex
CREATE INDEX "FindingEvidence_tenantId_samplesPurgedAt_lastSeenAt_idx" ON "FindingEvidence"("tenantId", "samplesPurgedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "WebEngineState_tenantId_updatedAt_idx" ON "WebEngineState"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "WebTrafficSlot_tenantId_slotStart_idx" ON "WebTrafficSlot"("tenantId", "slotStart");

-- CreateIndex
CREATE INDEX "WebTrafficHour_tenantId_hourStart_idx" ON "WebTrafficHour"("tenantId", "hourStart");

-- CreateIndex
CREATE UNIQUE INDEX "AwsSource_id_tenantId_key" ON "AwsSource"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "WebSourceSettings" ADD CONSTRAINT "WebSourceSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebSourceSettings" ADD CONSTRAINT "WebSourceSettings_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebTrustedSource" ADD CONSTRAINT "WebTrustedSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebTrustedSource" ADD CONSTRAINT "WebTrustedSource_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebRoute" ADD CONSTRAINT "WebRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebRoute" ADD CONSTRAINT "WebRoute_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebLogObject" ADD CONSTRAINT "WebLogObject_cloudAccountId_tenantId_fkey" FOREIGN KEY ("cloudAccountId", "tenantId") REFERENCES "CloudAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebLogObject" ADD CONSTRAINT "WebLogObject_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebLogObject" ADD CONSTRAINT "WebLogObject_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_findingId_tenantId_fkey" FOREIGN KEY ("findingId", "tenantId") REFERENCES "Finding"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebEngineState" ADD CONSTRAINT "WebEngineState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebEngineState" ADD CONSTRAINT "WebEngineState_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebTrafficSlot" ADD CONSTRAINT "WebTrafficSlot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebTrafficSlot" ADD CONSTRAINT "WebTrafficSlot_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebTrafficHour" ADD CONSTRAINT "WebTrafficHour_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebTrafficHour" ADD CONSTRAINT "WebTrafficHour_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "AwsSource"("id", "tenantId") ON DELETE CASCADE ON UPDATE RESTRICT;


-- Daqui para baixo, o que o Prisma não declara (e não compara: o `migrate diff` com o schema sai vazio).

-- Espaço na página para a soma não mexer em índice (update HOT): cada linha recebe alguns objetos no mesmo intervalo.
ALTER TABLE "WebTrafficSlot" SET (fillfactor = 70);

ALTER TABLE "WebSourceSettings" ADD CONSTRAINT "WebSourceSettings_values_check" CHECK (
  "mode" IN ('observe', 'alert')
  AND "thresholdMultiplier" >= 0.5 AND "thresholdMultiplier" <= 10
);

-- Os pisos de `weblogs/trusted-sources.ts`: IPv4 de /16 a /32, IPv6 de /32 a /64, sem bit de máquina (o tipo `cidr` recusa).
-- A validade conta da última mudança, com um dia de folga para a diferença entre relógios: o motor recusa acima de 365.
ALTER TABLE "WebTrustedSource" ADD CONSTRAINT "WebTrustedSource_values_check" CHECK (
  "cidr" ~ '^[0-9a-f.:]{2,45}/[0-9]{1,3}$'
  AND masklen("cidr"::cidr) >= CASE family("cidr"::cidr) WHEN 4 THEN 16 ELSE 32 END
  AND masklen("cidr"::cidr) <= CASE family("cidr"::cidr) WHEN 4 THEN 32 ELSE 64 END
  AND "kind" IN ('monitor', 'office', 'partner', 'pentest', 'proxy')
  AND btrim("reason") <> ''
  AND "expiresAt" <= "updatedAt" + interval '366 days'
);

-- O formato de `weblogs/routes.ts`: minúsculas, até 8 segmentos, `*` só no lugar de um segmento inteiro.
ALTER TABLE "WebRoute" ADD CONSTRAINT "WebRoute_values_check" CHECK (
  ("host" IS NULL OR "host" ~ '^[a-z0-9._~-]{1,253}$')
  AND "method" IN ('ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE')
  AND ("path" = '/' OR "path" ~ '^(/([a-z0-9._~-]+|[*])){1,8}$')
  AND "kind" IN ('login', 'mfa', 'reset', 'signup', 'api_token', 'ignore')
  AND COALESCE(cardinality("failureCodes"), 0) <= 20
  AND COALESCE(cardinality("successCodes"), 0) <= 20
  AND 100 <= ALL (COALESCE("failureCodes", '{}')) AND 599 >= ALL (COALESCE("failureCodes", '{}'))
  AND 100 <= ALL (COALESCE("successCodes", '{}')) AND 599 >= ALL (COALESCE("successCodes", '{}'))
  AND "multiplier" >= 0.5 AND "multiplier" <= 10
);

ALTER TABLE "WebLogObject" ADD CONSTRAINT "WebLogObject_values_check" CHECK (
  "objectHash" ~ '^[0-9a-f]{64}$'
  AND "status" IN ('read', 'late', 'quarantined', 'gap')
  AND ("slotStart" IS NOT NULL OR "status" IN ('quarantined', 'gap'))
  AND mod(extract(epoch FROM "slotStart"), 300) = 0
  AND "lines" >= 0 AND "bytes" >= 0 AND "malformed" >= 0 AND "oversize" >= 0 AND "foreign" >= 0
);

-- O mesmo teto do contrato (`MAX_EVIDENCE_BYTES`), sobre o JSON como o banco o devolve.
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_data_check" CHECK (
  jsonb_typeof("data") = 'object'
  AND octet_length("data"::text) <= 16384
  AND "version" >= 1
  AND COALESCE("data" ->> 'version', '') = "version"::text
  AND "firstSeenAt" <= "lastSeenAt"
);

ALTER TABLE "WebEngineState" ADD CONSTRAINT "WebEngineState_state_check" CHECK (
  jsonb_typeof("state") = 'object'
  AND octet_length("state"::text) <= 4194304
  AND "version" >= 1
);

ALTER TABLE "WebTrafficSlot" ADD CONSTRAINT "WebTrafficSlot_values_check" CHECK (
  "country" ~ '^[A-Z]{2}$'
  AND "clientClass" IN ('direct', 'proxy', 'private', 'unverified')
  AND mod(extract(epoch FROM "slotStart"), 300) = 0
  AND "requests" >= 0 AND "blocked" >= 0 AND "clientErrors" >= 0 AND "serverErrors" >= 0 AND "flagged" >= 0
);

ALTER TABLE "WebTrafficHour" ADD CONSTRAINT "WebTrafficHour_values_check" CHECK (
  "country" ~ '^[A-Z]{2}$'
  AND "clientClass" IN ('direct', 'proxy', 'private', 'unverified')
  AND mod(extract(epoch FROM "hourStart"), 3600) = 0
  AND "requests" >= 0 AND "blocked" >= 0 AND "clientErrors" >= 0 AND "serverErrors" >= 0 AND "flagged" >= 0
);

COMMIT;
