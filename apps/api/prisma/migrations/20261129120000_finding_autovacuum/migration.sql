-- Autovacuum da tabela de alertas a cada 5% de linhas mudadas (o padrão é 20%).
--
-- A atribuição dos casos faz um UPDATE por alerta, que não é HOT (o caso entra num índice) e tira o alerta da fila
-- parcial. Com 20%, numa tabela de milhões de alertas, a limpeza esperaria centenas de milhares de linhas mortas, e o
-- começo da fila (`Finding_case_outbox_idx`) ficaria cheio de entradas mortas, lidas a cada passagem da tarefa.
--
-- Só um parâmetro da tabela, no catálogo: não reescreve nada, não muda coluna, dado nem índice, e a trava (SHARE UPDATE
-- EXCLUSIVE) não impede leitura nem escrita. A imagem anterior do nó não percebe. O Prisma não o declara nem o compara.
ALTER TABLE "Finding" SET (autovacuum_vacuum_scale_factor = 0.05);
