-- Conexão do Cloudflare por OAuth, do lado do nó (CF-4). Só acrescenta: nenhuma coluna existente muda, e nada é apagado.
--
-- 1. `ControlPlaneSync.cloudflareOauth`: a configuração do app que a sincronização trouxe (o worker grava, a API lê).
--    Null, o "Conectar com Cloudflare" fica desligado, como em todo nó até hoje.
-- 2. `CloudflareConnectAttempt`: a configuração com que a tentativa começou (a troca usa a mesma), quando as contas da
--    autorização foram descobertas, se o ID da conta precisa ser digitado e as contas que o cliente escolheu.
--
-- Nada disso é segredo. Na volta para a versão anterior do nó, as colunas ficam paradas.

-- AlterTable
ALTER TABLE "ControlPlaneSync" ADD COLUMN     "cloudflareOauth" JSONB;

-- AlterTable
ALTER TABLE "CloudflareConnectAttempt" ADD COLUMN     "accountIdRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chosenAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "config" JSONB,
ADD COLUMN     "discoveredAt" TIMESTAMPTZ(3);
