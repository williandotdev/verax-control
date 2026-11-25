-- As chaves de acesso dos alertas de um caso, com o mesmo teto das outras amostras: sem elas, o caso que só toca a lista de
-- proteção pela chave não aparecia como protegido. Só acrescenta uma coluna com padrão e o teto dela: nenhuma coluna, regra
-- ou valor de enum muda, e a imagem anterior do nó (que não a grava) segue funcionando. Os casos só existem com
-- `CASES_MODE` ligado, então a tabela está vazia em todo nó que recebe esta migration.
ALTER TABLE "AlertCase" ADD COLUMN "accessKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AlertCase" ADD CONSTRAINT "AlertCase_access_keys_check" CHECK (cardinality("accessKeys") <= 20);
