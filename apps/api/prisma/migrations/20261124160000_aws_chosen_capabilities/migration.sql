-- A escolha do cliente no "Conectar com AWS" (onboarding self-service da AWS): as autorizações que ele marcou no painel
-- para o arquivo da pilha. Sem ela, a tela recarregada voltava a marcar as três, e o arquivo baixado de novo concedia
-- mais do que o cliente tinha escolhido. A coluna guarda só a escolha (as autorizações separadas por espaço, na ordem do
-- catálogo; vazio: só a descoberta), para a tela devolver as mesmas caixas e avisar quando o papel na AWS ficou
-- diferente dela. O que o papel pode ler continua em `awsCapabilities`, pelas tags dele.
-- Só acrescenta: a coluna nasce vazia (null: nenhuma escolha gravada), e nenhuma linha que já existe é tocada.

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "awsChosenCapabilities" VARCHAR(64);

-- Só conta AWS, e só as três autorizações do template, sem repetir e na ordem do catálogo.
ALTER TABLE "CloudAccount" ADD CONSTRAINT "CloudAccount_aws_chosen_capabilities_check" CHECK (
  "awsChosenCapabilities" IS NULL
  OR (
    "provider" = 'aws'
    AND "awsChosenCapabilities" ~ '^((service-logs)( findings)?( log-groups)?|(findings)( log-groups)?|(log-groups))?$'
  )
);
