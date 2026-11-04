-- Chave estável do achado do Wazuh (fase 2, PR-W2): `sourceEventId` passa a ser o ID do evento na própria AWS, que se
-- repete quando o evento volta ao indexer, e o ID do alerta (o da primeira leitura), por onde o detalhe busca o evento
-- bruto, ganha coluna própria. Nenhum achado do Wazuh existe em produção, então nada é migrado.

-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "rawEventId" VARCHAR(128);
