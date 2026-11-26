-- Alerta que se explica (26/11/2026): a alteração registrada no evento do CloudTrail, reduzida e saneada, gravada no
-- achado na chegada (`Finding.change`, contrato `findingChangeSchema` de `@verax/shared`), e a chave do objeto alterado
-- (`Finding.changeSubject`) para achar o estado anterior do mesmo objeto (a lista de IPs, a Web ACL ou o grupo de regras do
-- WAF v2), no mesmo cliente e na mesma conta.
--
-- Só acrescenta: duas colunas que aceitam nulo, um índice parcial e um CHECK. A imagem anterior do nó continua funcionando
-- neste esquema (a volta de versão não desfaz migrations): ela não conhece as colunas, grava a linha sem elas (nulas) e não
-- as lê. Os achados que já existem ficam com as duas nulas; o painel explica esses pelo evento bruto.
--
-- O CHECK entra como `NOT VALID`: as linhas que já existem têm as colunas nulas (passariam), e a validação leria a tabela
-- inteira com ela travada. As linhas novas e as alteradas são conferidas desde já.
--
-- O índice é parcial (só os achados com chave do objeto, uma parte pequena) e fica só no banco, como os outros parciais da
-- tabela: o Prisma 7.10 não o declara nem o compara.
--
-- Numa transação só (BEGIN e COMMIT). As migrations rodam com a API e o worker parados (`infra/node/bin/start.sh`).
BEGIN;

ALTER TABLE "Finding" ADD COLUMN "change" JSONB;
ALTER TABLE "Finding" ADD COLUMN "changeSubject" VARCHAR(320);

-- O mesmo teto do contrato (`MAX_FINDING_CHANGE_BYTES`), sobre o JSON como o banco o devolve; a chave só com a alteração.
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_change_check" CHECK (
  ("change" IS NULL OR (jsonb_typeof("change") = 'object' AND octet_length("change"::text) <= 16384))
  AND ("changeSubject" IS NULL OR "change" IS NOT NULL)
) NOT VALID;

-- O estado anterior do mesmo objeto: os achados do cliente com a mesma chave, do mais novo para o mais antigo.
CREATE INDEX "Finding_change_subject_idx" ON "Finding" ("tenantId", "changeSubject", "occurredAt" DESC)
  WHERE "changeSubject" IS NOT NULL;

COMMIT;
