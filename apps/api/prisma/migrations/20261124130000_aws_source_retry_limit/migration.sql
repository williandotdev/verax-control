-- O "Tentar de novo" de uma fonte (onboarding self-service da AWS) passa a ter limite: no máximo um pedido a cada 30 s
-- por fonte (`AWS_SOURCE_RETRY_INTERVAL_MS`). O `probeRequestedAt` é desfeito quando a tarefa `aws-discovery` responde,
-- então o horário do último pedido fica numa coluna própria, que a resposta não toca. Só acrescenta: as fontes que já
-- existem ficam sem horário (nunca pediram, ou pediram antes do limite existir).

-- AlterTable
ALTER TABLE "AwsSource" ADD COLUMN     "lastProbeRequestAt" TIMESTAMPTZ(3);
