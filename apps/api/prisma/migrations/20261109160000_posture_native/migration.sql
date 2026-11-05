-- Postura nativa da AWS (fase 2, PR-15'): a varredura guarda os resultados não lidos (`unknown`, a AWS recusou a
-- leitura: fora da nota), cada checagem do catálogo com as contagens (`checks`) e as leituras recusadas (`errors`,
-- `parte:código` ou `parte:região:código`, só o nome do erro da AWS). As varreduras que já existem ficam sem
-- resultados não lidos, sem checagens do catálogo e sem leituras recusadas.

-- AlterTable
ALTER TABLE "PostureScan" ADD COLUMN     "checks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "unknown" INTEGER NOT NULL DEFAULT 0;
