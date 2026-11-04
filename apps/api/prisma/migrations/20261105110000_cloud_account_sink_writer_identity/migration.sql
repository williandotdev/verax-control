-- Projeto GCP de cliente (fase 2, PR-05): a identidade de escrita do sink que o cliente cria no projeto dele, com o
-- comando pronto do painel, e cola de volta. Não é segredo: é a quem o Terraform do nó dá a publicação no tópico do
-- projeto. As contas existentes ficam sem ela (os projetos da Verax têm o sink criado pelo Terraform).

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "sinkWriterIdentity" VARCHAR(128);

-- Só conta da GCP tem identidade de sink. Fora do schema do Prisma, que não descreve CHECK; a API recusa o campo nos
-- outros provedores.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_gcp_sinkWriterIdentity_check"
  CHECK ("provider" = 'gcp' OR "sinkWriterIdentity" IS NULL);
