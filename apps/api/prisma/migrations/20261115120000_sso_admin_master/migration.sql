-- Entrada única no SIEM pelo console do responsável (decisão de 15/11/2026; docs/ARQUITETURA.md, "Entrada única"). Só a
-- célula usa, e só no endereço da equipe; no nó dedicado, as duas tabelas ficam vazias.
--
-- 1. `SsoLoginAttempt`: o pedido em curso de um navegador (o `state`, o `nonce` e o verificador do PKCE), pelo SHA-256
--    do cookie de pré-login. Uso único e 10 minutos.
-- 2. `SsoTokenUse`: o `jti` de cada token de identidade aceito, até vencer: o mesmo token não vale duas vezes.

-- CreateTable
CREATE TABLE "SsoLoginAttempt" (
    "id" VARCHAR(64) NOT NULL,
    "stateHash" VARCHAR(64) NOT NULL,
    "nonce" VARCHAR(43) NOT NULL,
    "codeVerifier" VARCHAR(128) NOT NULL,
    "hostTenantId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SsoLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoTokenUse" (
    "jti" VARCHAR(43) NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SsoTokenUse_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "SsoLoginAttempt_expiresAt_idx" ON "SsoLoginAttempt"("expiresAt");

-- CreateIndex
CREATE INDEX "SsoTokenUse_expiresAt_idx" ON "SsoTokenUse"("expiresAt");
