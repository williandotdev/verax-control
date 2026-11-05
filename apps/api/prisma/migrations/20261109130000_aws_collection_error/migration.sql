-- Fase 2, PR-V4': o estado da coleta da AWS pelo Wazuh do nó ganha coluna própria. A tarefa `wazuh-config` do worker
-- grava nela os avisos do nó inteiro (o token do Google do host sem renovar, a configuração do manager que não subiu),
-- e a conferência da conexão (a tarefa `aws-check`, PR-V5') continua sozinha em `connectionError`: as duas nunca
-- escrevem no mesmo campo, e limpar uma não apaga a outra. Só conta AWS tem o estado, e só com os códigos que a coleta
-- grava (fora do schema do Prisma, que não descreve CHECK). Coluna nova e vazia: nenhum dado muda.
ALTER TABLE "CloudAccount" ADD COLUMN "collectionError" VARCHAR(64);
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_aws_collection_error_check"
  CHECK (
    "collectionError" IS NULL
    OR ("provider" = 'aws' AND "collectionError" IN ('aws_token_stale', 'wazuh_apply_failed'))
  );
