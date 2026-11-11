-- Célula compartilhada (CE-01): cada requisição é do cliente do endereço da API (`api-<slug>.<domínio>`), e a sessão só
-- vale no endereço onde nasceu. O mapa endereço → cliente é gravado só pelo sistema. No nó dedicado nada disso é usado:
-- a tabela fica vazia e a coluna nova, nula.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "hostTenantId" UUID;

-- CreateTable
CREATE TABLE "TenantHost" (
    "tenantId" UUID NOT NULL,
    "slug" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantHost_pkey" PRIMARY KEY ("tenantId"),
    -- A regra do subdomínio do plano de controle e do painel: 3 a 16 caracteres, sem hífen na 3.ª e na 4.ª posições.
    CONSTRAINT "TenantHost_slug_format" CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,14}[a-z0-9]$' AND substr("slug", 3, 2) <> '--')
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantHost_slug_key" ON "TenantHost"("slug");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_hostTenantId_fkey" FOREIGN KEY ("hostTenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantHost" ADD CONSTRAINT "TenantHost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- O endereço de um cliente não muda de dono nem de nome: alterar a linha trocaria, sem passar pelo sistema que grava o
-- mapa, o cliente que responde num endereço. Mudar de endereço é apagar a linha e gravar outra.
CREATE FUNCTION "tenant_host_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TenantHost não aceita alteração: apague e grave de novo'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "TenantHost_no_update"
  BEFORE UPDATE ON "TenantHost"
  FOR EACH ROW EXECUTE FUNCTION "tenant_host_reject_update"();
