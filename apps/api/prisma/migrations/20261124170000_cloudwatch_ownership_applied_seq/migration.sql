-- A prova do dono dos alertas do CloudWatch Logs passa a exigir continuidade no sinal `applied` do host. O sinal ganhou
-- um número de sequência, que o `wazuh-apply.sh` aumenta a cada troca da configuração do manager: sem ele, duas trocas
-- entre duas conferências da tarefa `wazuh-config` passavam sem ser vistas. A linha guarda o último número conferido.
-- Só acrescenta: a coluna nasce vazia, e a linha que já existe (gravada sem o número) deixa de valer como prova até a
-- conferência seguinte, que a refaz.

-- AlterTable
ALTER TABLE "CloudWatchAlertOwnership" ADD COLUMN     "appliedSeq" BIGINT;

-- O número só cresce a partir de zero.
ALTER TABLE "CloudWatchAlertOwnership" ADD CONSTRAINT "CloudWatchAlertOwnership_applied_seq_check" CHECK (
  "appliedSeq" IS NULL OR "appliedSeq" >= 0
);
