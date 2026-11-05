-- Inventário nativo da AWS (fase 2, PR-14'): o retrato marca a coleta parcial. `errors` guarda as partes que não
-- entraram (`parte:código` ou `parte:região:código`, só o nome do erro da AWS) e `truncated`, se alguma parte passou do
-- teto de itens. Os retratos que já existem ficam como coleta completa (lista vazia e `false`).

-- AlterTable
ALTER TABLE "InventorySnapshot" ADD COLUMN     "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "truncated" BOOLEAN NOT NULL DEFAULT false;
