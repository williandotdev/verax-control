-- Conexão do Cloudflare por OAuth (`packages/shared/src/cloudflare-oauth.ts`): as tabelas e a coluna que o "Conectar com
-- Cloudflare" vai usar. Só acrescenta: nenhuma coluna existente muda, nada é apagado, e nada as usa ainda. As contas com
-- token colado continuam como estão.
--
-- 1. `CloudflareConnectAttempt`: cada tentativa, do clique ao fim, com o verificador e o código cifrados só enquanto
--    espera por eles.
-- 2. `CloudflareGrant`: a autorização do cliente, com os tokens cifrados, e quais contas a usam
--    (`CloudAccount.cloudflareGrantId`, só em conta do Cloudflare).
-- 3. `CloudflareZone`: as zonas de cada conta e a situação delas nos eventos de segurança.
--
-- As três têm `tenantId` (entram no escopo do cliente) e chaves estrangeiras compostas: o banco recusa a linha de um
-- cliente na conta ou na concessão de outro. A concessão em uso por uma conta não pode ser apagada. Na volta para a
-- versão anterior do nó, a coluna e as tabelas ficam paradas: ela não as lê.
--
-- Os CHECKs repetem no banco os valores do contrato; um teste confere que os dois continuam iguais.

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "cloudflareGrantId" UUID;

-- CreateTable
CREATE TABLE "CloudflareConnectAttempt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "sessionId" VARCHAR(64) NOT NULL,
    "stateHash" VARCHAR(64) NOT NULL,
    "verifierCiphertext" VARCHAR(8192),
    "codeCiphertext" VARCHAR(8192),
    "cloudAccountId" UUID,
    "grantId" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'started',
    "errorCode" VARCHAR(64),
    "accounts" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudflareConnectAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudflareGrant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientId" VARCHAR(128) NOT NULL,
    "ciphertext" VARCHAR(8192) NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "accessExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "scopes" TEXT[],
    "generation" INTEGER NOT NULL DEFAULT 1,
    "refreshStartedAt" TIMESTAMPTZ(3),
    "consentedAt" TIMESTAMPTZ(3) NOT NULL,
    "consentedBy" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "lastRefreshAt" TIMESTAMPTZ(3),
    "lastErrorKind" VARCHAR(64),
    "revokeRequestedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudflareGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudflareZone" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cloudAccountId" UUID NOT NULL,
    "zoneId" VARCHAR(32) NOT NULL,
    "name" VARCHAR(253) NOT NULL,
    "plan" VARCHAR(64),
    "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "lastReadAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(64),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingSince" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CloudflareZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloudflareConnectAttempt_stateHash_key" ON "CloudflareConnectAttempt"("stateHash");

-- CreateIndex
CREATE INDEX "CloudflareConnectAttempt_tenantId_userId_createdAt_idx" ON "CloudflareConnectAttempt"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "CloudflareConnectAttempt_status_expiresAt_idx" ON "CloudflareConnectAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CloudflareConnectAttempt_createdAt_idx" ON "CloudflareConnectAttempt"("createdAt");

-- CreateIndex
CREATE INDEX "CloudflareConnectAttempt_grantId_idx" ON "CloudflareConnectAttempt"("grantId");

-- CreateIndex
CREATE INDEX "CloudflareConnectAttempt_cloudAccountId_idx" ON "CloudflareConnectAttempt"("cloudAccountId");

-- CreateIndex
CREATE INDEX "CloudflareGrant_tenantId_idx" ON "CloudflareGrant"("tenantId");

-- CreateIndex
CREATE INDEX "CloudflareGrant_keyVersion_idx" ON "CloudflareGrant"("keyVersion");

-- CreateIndex
CREATE INDEX "CloudflareGrant_status_idx" ON "CloudflareGrant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CloudflareGrant_id_tenantId_key" ON "CloudflareGrant"("id", "tenantId");

-- CreateIndex
CREATE INDEX "CloudflareZone_tenantId_idx" ON "CloudflareZone"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudflareZone_cloudAccountId_zoneId_key" ON "CloudflareZone"("cloudAccountId", "zoneId");

-- CreateIndex
CREATE INDEX "CloudAccount_cloudflareGrantId_idx" ON "CloudAccount"("cloudflareGrantId");

-- AddForeignKey
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_cloudflareGrantId_tenantId_fkey" FOREIGN KEY ("cloudflareGrantId", "tenantId") REFERENCES "CloudflareGrant"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareConnectAttempt" ADD CONSTRAINT "CloudflareConnectAttempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareConnectAttempt" ADD CONSTRAINT "CloudflareConnectAttempt_cloudAccountId_tenantId_fkey" FOREIGN KEY ("cloudAccountId", "tenantId") REFERENCES "CloudAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareConnectAttempt" ADD CONSTRAINT "CloudflareConnectAttempt_grantId_tenantId_fkey" FOREIGN KEY ("grantId", "tenantId") REFERENCES "CloudflareGrant"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareGrant" ADD CONSTRAINT "CloudflareGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_cloudAccountId_tenantId_fkey" FOREIGN KEY ("cloudAccountId", "tenantId") REFERENCES "CloudAccount"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Só conta do Cloudflare é lida por uma concessão.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_cloudflare_grant_check" CHECK (
  "cloudflareGrantId" IS NULL OR "provider" = 'cloudflare'
);

-- A tentativa: o segredo só existe no passo que o usa (o verificador até a troca, o código entre o retorno e a troca), e o
-- retorno vale uma vez. A falha tem o código; a escolha e o fim têm a concessão.
ALTER TABLE "CloudflareConnectAttempt" ADD CONSTRAINT "CloudflareConnectAttempt_status_check" CHECK (
  "status" IN ('started', 'code_received', 'choosing', 'done', 'failed', 'expired')
  AND (("verifierCiphertext" IS NOT NULL) = ("status" IN ('started', 'code_received')))
  AND (("codeCiphertext" IS NOT NULL) = ("status" = 'code_received'))
  AND ("status" <> 'started' OR "consumedAt" IS NULL)
  AND ("status" NOT IN ('code_received', 'choosing', 'done') OR "consumedAt" IS NOT NULL)
  AND ("status" NOT IN ('choosing', 'done') OR "grantId" IS NOT NULL)
  AND ("status" NOT IN ('started', 'code_received') OR "grantId" IS NULL)
);
ALTER TABLE "CloudflareConnectAttempt" ADD CONSTRAINT "CloudflareConnectAttempt_error_check" CHECK (
  (("status" = 'failed') = ("errorCode" IS NOT NULL))
  AND (
    "errorCode" IS NULL
    OR "errorCode" IN (
      'oauth_denied', 'oauth_code_rejected', 'oauth_client_rejected', 'oauth_no_refresh', 'oauth_scope_missing',
      'oauth_scope_unexpected', 'oauth_no_account', 'oauth_account_mismatch', 'account_exists', 'plan_limit_reached',
      'tenant_plan_missing', 'source_unavailable', 'internal_error'
    )
  )
);
ALTER TABLE "CloudflareConnectAttempt" ADD CONSTRAINT "CloudflareConnectAttempt_format_check" CHECK (
  "stateHash" ~ '^[0-9a-f]{64}$'
  AND "userId" <> ''
  AND "sessionId" <> ''
  AND "expiresAt" > "createdAt"
  AND ("verifierCiphertext" IS NULL OR "verifierCiphertext" ~ '^v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$')
  AND ("codeCiphertext" IS NULL OR "codeCiphertext" ~ '^v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$')
  AND jsonb_typeof("accounts") = 'array'
);

-- A concessão: o envelope é o da versão da chave gravada ao lado (como na credencial colada), e a data da revogação só
-- existe enquanto ela espera.
ALTER TABLE "CloudflareGrant" ADD CONSTRAINT "CloudflareGrant_ciphertext_check" CHECK (
  "keyVersion" >= 1
  AND "ciphertext" ~ '^v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$'
  AND split_part("ciphertext", ':', 1) = 'v' || "keyVersion"
);
ALTER TABLE "CloudflareGrant" ADD CONSTRAINT "CloudflareGrant_status_check" CHECK (
  "status" IN ('active', 'reconnect', 'revoking')
  AND (("status" = 'revoking') = ("revokeRequestedAt" IS NOT NULL))
);
ALTER TABLE "CloudflareGrant" ADD CONSTRAINT "CloudflareGrant_format_check" CHECK (
  "clientId" ~ '^[A-Za-z0-9_-]{8,128}$'
  AND "scopes" IS NOT NULL
  AND cardinality("scopes") BETWEEN 1 AND 16
  AND "generation" >= 1
  AND "consentedBy" <> ''
  AND ("lastErrorKind" IS NULL OR "lastErrorKind" ~ '^[A-Za-z0-9_.:-]{1,64}$')
);

-- A zona: a que sumiu da conta tem a data, e só ela.
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_state_check" CHECK (
  "state" IN ('pending', 'reading', 'not_entitled', 'forbidden', 'over_limit', 'not_monitored', 'missing')
  AND (("state" = 'missing') = ("missingSince" IS NOT NULL))
);
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_format_check" CHECK (
  "zoneId" ~ '^[0-9a-f]{32}$'
  AND "name" <> ''
  AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Za-z0-9_.:-]{1,64}$')
);
