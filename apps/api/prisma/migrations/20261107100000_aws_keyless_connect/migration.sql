-- Fase 2, PR-V3': "Conectar AWS" com o papel de leitura sem chave (federação do Google). Três mudanças, numa transação
-- só: o ExternalId deixa de ser exigido e de ter valor, o "Verificar" do painel e o dia de início da coleta ganham
-- coluna, e o tipo `aws_access_key` sai do cofre. Nenhum dado em uso muda: nenhuma conta AWS depende do ExternalId (o
-- conector antigo nunca foi usado por cliente; a leitura é pelo papel sem chave) e nenhuma credencial `aws_access_key`
-- foi gravada (a rota da credencial nunca aceitou o tipo). Se uma linha dele existir, a migration para inteira, sem
-- mudar nada.
BEGIN;

-- 1. ExternalId: sai o CHECK que o exigia em toda conta AWS, e os valores gravados (do conector antigo, sem uso) são
-- apagados. A coluna fica, vazia e sem uso: a versão anterior da API ainda a lê, e uma volta de versão do nó não pode
-- quebrar a tela de contas. Ela sai numa migration de contração.
ALTER TABLE "CloudAccount" DROP CONSTRAINT "CloudAccount_aws_externalId_check";
UPDATE "CloudAccount" SET "externalId" = NULL WHERE "externalId" IS NOT NULL;

-- 2. O "Verificar" pendente (a tarefa `aws-check` do worker responde) e o dia a partir do qual o Wazuh lê os logs dos
-- buckets (`only_logs_after`, gravado na primeira verificação bem-sucedida). Só conta AWS tem os dois: fora do schema
-- do Prisma, que não descreve CHECK; a API e o worker só gravam em conta AWS.
ALTER TABLE "CloudAccount" ADD COLUMN "checkRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN "ingestFrom" DATE;
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_aws_check_fields_check"
  CHECK ("provider" = 'aws' OR ("checkRequestedAt" IS NULL AND "ingestFrom" IS NULL));

-- 3. O tipo `aws_access_key` sai do enum. O PostgreSQL não remove valor de enum: o tipo novo nasce sem ele, a coluna é
-- convertida pelo texto e o tipo antigo é apagado (a mesma sequência que o Prisma gera). A conversão já falharia numa
-- linha com o valor; a conferência antes dela dá o motivo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CloudCredential" WHERE "kind" = 'aws_access_key') THEN
    RAISE EXCEPTION 'há credencial aws_access_key no cofre: a AWS é lida pelo papel sem chave; apague a linha e rode de novo';
  END IF;
END
$$;
CREATE TYPE "CloudCredentialKind_new" AS ENUM ('cloudflare_api_token');
ALTER TABLE "CloudCredential" ALTER COLUMN "kind" TYPE "CloudCredentialKind_new"
  USING ("kind"::text::"CloudCredentialKind_new");
ALTER TYPE "CloudCredentialKind" RENAME TO "CloudCredentialKind_old";
ALTER TYPE "CloudCredentialKind_new" RENAME TO "CloudCredentialKind";
DROP TYPE "CloudCredentialKind_old";

COMMIT;
