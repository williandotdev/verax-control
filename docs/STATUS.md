# Status de execução

Registro de cada task executada: arquivos, dependências, testes, definição de pronto, teste manual e riscos.
O campo "Status" no `PLANO.md` só é marcado como concluído depois da confirmação do responsável pelo produto.

## Desvios em relação ao plano

| Item                | Desvio                                                                                                        | Motivo                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nestjs-zod          | Removido; validação com o `StandardSchemaValidationPipe` nativo do NestJS 12, estendido (`AppValidationPipe`) | A versão 5.5.0 não suporta NestJS 12 (peer pede ≤ 11). O Nest 12 e o @nestjs/swagger 12 já aceitam schemas zod (Standard Schema) na rota e no OpenAPI                                                                           |
| pino-http 11.0.0    | Adicionado                                                                                                    | Peer obrigatório do nestjs-pino 5.3.1                                                                                                                                                                                           |
| Versões             | Algumas um patch abaixo da última                                                                             | Quarentena de 24h (`minimumReleaseAge`)                                                                                                                                                                                         |
| prisma 7.10.1 (CLI) | Exceção em `trustPolicyExclude`, só para essa versão; aprovada pelo responsável em 01/11/2026                 | O Prisma publica o CLI com token do bot desde prisma/orm#30035 (issue prisma/orm#30850). A 7.9.x teria advisories em mysql2 e deepmerge-ts e não teria a correção de transação aninhada. Remover quando voltar a ter provenance |

---

## T0.1 Criar o monorepo

- **Arquivos:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`, `.gitignore`, `.gitattributes`, `.editorconfig`, `apps/api/*`, `apps/web/*`, `packages/shared/*`
- **Dependências:** NestJS 12.3.2 (core, common, platform-express, testing, cli 12.0.11), reflect-metadata 0.2.2, rxjs 7.8.2, React 19.3.1, Vite 8.3.5, @vitejs/plugin-react 6.1.2, zod 4.6.7, TypeScript 6.0.3, Vitest 5.0.5, unplugin-swc 2.0.0 + @swc/core 1.16.20 (metadata de decorators nos testes), supertest 7.3.1, Testing Library (react 16.3.3, jest-dom 7.0.1), jsdom 30.1.3. Todas da lista aprovada.
- **Testes:** `pnpm build`, `pnpm typecheck` e `pnpm test` verdes (3 testes); a API compilada sobe e responde 404 em rota inexistente.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint n/a (T0.3) · tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔
- **Teste manual:** `pnpm install && pnpm build && pnpm test`
- **Notas:** a API é ESM puro (o NestJS 12 é ESM). O pnpm bloqueia versões com menos de 24h, rejeita queda de provenance e só roda script de instalação com allowlist (o do `@swc/core` está negado).

## T0.2 Arquivo de regras do agente ⚠️ altera regras do agente

- **Arquivos:** `CLAUDE.md`, `.claude/settings.json`
- **Dependências:** nenhuma
- **Testes:** `settings.json` validado como JSON; `CLAUDE.md` contém modo de trabalho, as 10 regras de segurança, definição de pronto, formato de resposta, estrutura de pastas, convenções e o ponteiro para `docs/PLANO.md`
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · tipos ✔ · dependências n/a · regras de segurança ✔
- **Teste manual:** abrir uma sessão nova do Claude Code na pasta e pedir "execute a T3.1"; o agente deve responder com o plano em 5 linhas e esperar o OK
- **Notas:** além da Parte 1 do plano, entraram a regra 10 (confidencialidade, porque o repo é público) e o bloqueio de leitura de `.env`, chaves, state do Terraform e caixa de e-mail local pelo agente

## T0.3 Lint, formatação e pre-commit

- **Arquivos:** `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `lefthook.yml`, `.gitleaks.toml`, `scripts/install-hooks.mjs`, `scripts/verify-lint-rules.mjs`, `package.json` (scripts), `pnpm-workspace.yaml`, `apps/web/tsconfig.json` (renomeado de `tsconfig.app.json`)
- **Dependências:** eslint 10.14.0, @eslint/js 10.0.1, typescript-eslint 8.72.1 (lint com informação de tipo), eslint-plugin-security 4.2.1, eslint-plugin-react-hooks 7.1.1, eslint-plugin-react-refresh 0.5.7, globals 17.13.0, prettier 3.9.10, lefthook 2.2.1 (ver desvios)
- **Testes:**
  - `pnpm test:lint-rules`: 10 sondas provam que as regras disparam para `$queryRawUnsafe`, `$executeRawUnsafe`, `eval`, `new Function`, `rejectUnauthorized: false` (com e sem aspas), `NODE_TLS_REJECT_UNAUTHORIZED`, CORS `*`, `query_string` do OpenSearch e `dangerouslySetInnerHTML`. Roda dentro de `pnpm test`.
  - `pnpm lint`, `pnpm format:check`, `pnpm typecheck` e `pnpm test` verdes
  - Pre-commit testado com um token falso do GitHub: commit bloqueado pelo Gitleaks (`leaks found: 1`) e pelo lint
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔
- **Teste manual:** instalar o Gitleaks (`winget install Gitleaks.Gitleaks`), rodar `pnpm install` e tentar commitar um arquivo com um token falso
- **Notas:** o pre-push roda typecheck e testes. Os hooks são instalados pelo script `prepare`, e não pelo postinstall do pacote (negado em `allowBuilds`). Quem não tiver o Gitleaks instalado não consegue commitar, por desenho: o hook falha fechado.

## T0.4 Ambiente local com Docker

- **Arquivos:** `docker-compose.yml`, `infra/docker/postgres-init/01-create-test-database.sql`, `.env.example`, `scripts/setup-env.mjs`, `apps/api/src/common/config/*` (schema, loader, módulo e testes), `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `README.md`
- **Dependências:** zod 4.6.7 na API (já aprovada; mesmo schema de validação do resto do projeto)
- **Testes:**
  - 10 testes de configuração: variáveis faltando listadas por nome, PORT fora do intervalo, NODE_ENV inválido, https obrigatório em produção, **valor secreto nunca aparece na mensagem de erro**, `.env` não sobrescreve variável já definida e não é lido em produção
  - Manual: com ambiente vazio a API sai com código 1 listando `NODE_ENV`, `WEB_ORIGIN` e `DATABASE_URL`; com `DATABASE_URL` inválida contendo uma senha, a senha não aparece; com o `.env` a API sobe
  - `docker compose up -d --wait`: container saudável, bancos `verax` e `verax_test` criados, `password_encryption = scram-sha-256`, porta só em `127.0.0.1:5432`
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔
- **Teste manual:** `pnpm setup:env && docker compose up -d --wait && pnpm --filter @verax/api build && pnpm --filter @verax/api start`
- **Notas:** imagem `postgres:18-alpine` fixada por digest (18.6). O `setup:env` gera segredos com `crypto.randomBytes` e grava o `.env` com permissão 600. Em produção o `.env` nunca é lido.

## T0.5 CI de segurança ⚠️ altera `.github/`

- **Arquivos:** `.github/workflows/ci.yml`, `.github/workflows/security.yml`, `.semgrep/rules.yaml`, `.semgrep/rules.ts`, `pnpm-workspace.yaml` (override do minimatch), `package.json` (`prelint`), `eslint.config.js` (ignora `.semgrep/`)
- **Dependências:** nenhuma no app. Override de segurança `minimatch@<11.0.1 → 11.0.1`.
- **Pipeline (PR e push na main):**
  - `ci.yml`: lint + formatação + tipos; testes com PostgreSQL 18 (serviço fixado por digest); build
  - `security.yml`: Semgrep (registry + 6 regras próprias com testes), Gitleaks no histórico inteiro, Trivy fs (vuln, secret, misconfig), OSV-Scanner, CodeQL (JS/TS e Actions, `security-extended`), Dependency Review (PR), actionlint + zizmor; varredura semanal
  - Todas as actions fixadas por SHA completo (o repositório também exige isso via `sha_pinning_required`), `permissions: contents: read` por padrão, `persist-credentials: false`
  - Trivy, Gitleaks, OSV-Scanner e actionlint instalados por binário com SHA-256 conferido; Semgrep por imagem fixada por digest
- **Testes locais antes do push:** `semgrep --test` (6/6), varredura Semgrep com 392 regras (0 achados), actionlint (0), zizmor (0), Trivy fs (0), OSV-Scanner (achou o minimatch; 0 depois do override), lint, testes e build verdes
- **Definição de pronto:** critérios de aceite ✔ (o bloqueio de merge entra com o ruleset na T0.6) · testes ✔ · lint e tipos ✔ · dependências ✔ · regras de segurança ✔
- **Teste manual:** abrir um PR e conferir os checks na aba "Checks"

## T0.6 Dependabot e Dependency Review ⚠️ altera `.github/`

- **Arquivos:** `.github/dependabot.yml`, `.github/rulesets/main.json`, `SECURITY.md`
- **Configuração no GitHub (via API):**
  - Dependabot semanal para npm, GitHub Actions e docker-compose, com cooldown de 7 dias (recomendação do Semgrep e do zizmor) e agrupamento de minor/patch; alertas e correções automáticas de segurança ligados (ignoram o cooldown)
  - Ruleset "Proteção da main" (`.github/rulesets/main.json`): PR obrigatório só com squash, 11 checks obrigatórios (incluindo Dependency Review), branch atualizada antes do merge, histórico linear, commits assinados, sem force push, sem exclusão e **sem bypass para ninguém**, nem para o dono
  - Já aplicados antes: secret scanning com push protection, private vulnerability reporting, `GITHUB_TOKEN` só leitura, actions exigidas por SHA, aprovação para workflows de forks, environments `staging` e `production` (este com aprovação manual)
- **Testes:** PR #1 com os 11 checks + CodeQL verdes; push direto na `main` rejeitado depois do ruleset (ver abaixo)
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔
- **Teste manual:** `git push origin main` com um commit local deve ser rejeitado pelo GitHub
- **Ajuste pós-teste:** o GitHub ativa por padrão `require_extra_approval_for_unattributed_changes`, que exige aprovação de outra pessoa para commits sem assinatura; com um único mantenedor, isso travava todo merge. O parâmetro foi desligado e os commits passaram a ser **assinados com chave SSH** (chave dedicada, registrada como signing key na conta, configuração local deste repositório). A regra "commits assinados" do ruleset continua ativa.

## T1.1 Prisma, health check e logger

### Parte 1: logger com redaction e `/health`

- **Arquivos:** `apps/api/src/common/logger/{sanitize,logger.options}.ts` (+ testes), `apps/api/src/health/*`, `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/test/logging.test.ts`, `apps/api/test/support/log-capture.ts`
- **Dependências:** nestjs-pino 5.3.1, pino 10.4.0, pino-http 11.0.0 (peer do nestjs-pino), pino-pretty 13.2.0 (dev, só saída legível em desenvolvimento)
- **Como a redaction funciona (três camadas):**
  1. Todo objeto logado passa por `sanitize`: oculta por nome de chave em qualquer profundidade (`authorization`, `cookie`, `password`, `token`, `secret`, `SecretAccessKey`, `SessionToken`, `AccessKeyId`, `apiKey`, `DATABASE_URL`, códigos de recuperação, TOTP etc.) e limpa valores com `Bearer ...`, ID de chave AWS (`AKIA`/`ASIA`) e senha embutida em URL. Erros têm mensagem, stack, propriedades e causa limpas.
  2. O texto da mensagem também passa pela limpeza por valor.
  3. Requisição e resposta saem só com `id`, método, caminho **sem query string** (pode ter token de convite), IP e status; nunca headers ou corpo.
- **Request id:** aceita `x-request-id` do proxy só no formato `[A-Za-z0-9-]{8,64}`; senão gera UUID. Volta no header da resposta.
- **Health check:** `GET /health` responde se o processo está vivo, sem consultar o banco, para que uma queda do banco não derrube as tasks do ECS em ciclo de reinício. Não gera log por requisição. A prontidão com o banco (`/health/ready`) entra na parte 2.
- **Testes:** 68 na API (eram 12). Prova da redaction: valores marcados em header, cookie, query string, corpo, credenciais AWS, erro com causa e child logger não aparecem em nenhuma linha. **Teste de mutação:** desligando a redaction, 3 testes falham.
- **Teste manual:** API compilada sobe com saída legível; `GET /health` → 200 `{"status":"ok"}` com `x-request-id`; uma requisição com `Authorization: Bearer ...` e `?token=...` aparece no log só como `GET /nao-existe` com status 404.

### Parte 2: Prisma e prontidão do banco

- **Arquivos:** `apps/api/prisma/schema.prisma`, `apps/api/prisma.config.ts`, `apps/api/prisma/migrations/20261101000000_baseline/`, `apps/api/src/common/prisma/*`, `apps/api/src/health/health.controller.ts` (+ teste), `apps/api/src/common/config/env.schema.ts` (+ teste), `apps/api/test/{database,health,health-unavailable}.test.ts`, `apps/api/test/support/{global-setup,create-app}.ts`, `apps/api/vitest.config.ts`, `apps/api/package.json` e `package.json` (scripts `db:*`), `.github/workflows/ci.yml` (`CHECKPOINT_DISABLE`), `pnpm-workspace.yaml`, `README.md`
- **Dependências:** @prisma/client 7.10.1, @prisma/adapter-pg 7.10.1, pg 8.23.1; dev: prisma 7.10.1 (CLI, ver desvios), @types/pg 8.23.1
- **Prisma 7:** generator `prisma-client` (ESM, gerado em `src/generated/prisma`, fora do git e gerado antes de build, teste, typecheck e lint), driver `pg` via adapter, URL só do ambiente (`prisma.config.ts` lê o `.env` da raiz fora de produção). Telemetria e checagem de atualização do CLI desligadas. Nenhum script de instalação do Prisma roda: o Schema Engine é baixado pelo CLI na primeira migration.
- **Primeira migration (linha de base):** revoga de PUBLIC o CREATE no schema `public` e o CONNECT/TEMP no banco. Só o dono do banco conecta; papéis futuros recebem GRANT explícito.
- **Prontidão:** `GET /health/ready` roda `SELECT 1` com limite de 2 s. Banco fora → 503 `{"status":"unavailable"}`, sem detalhe; o erro vai para o log já limpo. `/health` continua 200.
- **Produção:** a API não sobe se a `DATABASE_URL` não tiver `sslmode=verify-full` (TLS com certificado e hostname conferidos).
- **Testes:** 79 na API. Antes da suíte, o `globalSetup` aplica as migrations no banco de teste e **recusa qualquer banco cujo nome não termine em `_test`**; erro de conexão sai sem a senha.
  - Conexão pelo Prisma com PostgreSQL 18, migration aplicada, ACLs de PUBLIC conferidas no banco e no schema
  - `/health/ready` 200 com banco; 503 genérico com banco recusando conexão (sem senha no corpo nem no log); timeout quando o banco aceita a conexão e não responde
  - `sslmode` ausente, `disable`, `require` ou `no-verify` rejeitados em produção
- **Definição de pronto:** critérios de aceite ✔ (Prisma conectado com a primeira migration, `GET /health`, logger com redaction, teste da redaction) · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ (com a exceção abaixo, aprovada) · regras de segurança ✔
- **Teste manual:** API compilada contra o banco local: `/health` 200 e `/health/ready` 200; com `docker compose stop postgres`, `/health/ready` 503 e `/health` 200; com o banco de volta, 200 de novo.

## T1.2 Padrões de API

- **Arquivos:** `apps/api/src/app.setup.ts`, `apps/api/src/common/http/{api-error,validation.pipe,undeclared-input.interceptor,all-exceptions.filter,pagination,route-contracts,openapi}.ts` (+ testes), `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `packages/shared/src/pagination.ts` (+ teste), `apps/api/test/{api-standards,openapi,route-contracts}.test.ts`, `apps/api/test/support/{probe.module,create-app}.ts`, `.github/dependabot.yml`
- **Dependências:** @nestjs/swagger 12.0.5, helmet 8.3.0 (ambas aprovadas). Script de instalação do `@scarf/scarf` (telemetria trazida pelo swagger-ui-dist) negado.
- **Como ficou:**
  - Prefixo `/v1` em todas as rotas; `/health` e `/health/ready` ficam fora, para o ALB.
  - Validação: `@Body({ schema })`, `@Query({ schema })` e `@Param('id', { schema })` com zod. O pipe global nega por padrão (entrada sem schema → 500, nunca chega ao handler), remove `__proto__`/`constructor` antes de validar, e as mensagens saem em português sem repetir o valor recebido. Rota sem `@Query` recusa query string e rota sem `@Body` recusa corpo.
  - **Meta-teste de rotas:** percorre todas as rotas registradas e falha se alguma tiver corpo, query ou parâmetro sem schema, extrair só um campo do corpo/query, ou usar objeto não estrito em qualquer profundidade.
  - Só JSON (até 100 kB): sem parser de formulário, o que também elimina o envio por formulário HTML (vetor de CSRF).
  - Filtro de erro: 5xx sai como "Erro interno" (503 como "Serviço temporariamente indisponível") com `requestId`; 4xx sai com mensagem genérica do status; só `ApiError` mostra mensagem própria. O detalhe vai para o log já limpo.
  - Paginação: `paginationQuerySchema` (página ≥ 1, `pageSize` 1–100, padrão 25, estrito), `withPagination(filtros)` e `paginatedSchema(item)` em `packages/shared`; `toPrismaPage` e `toPaginated` na API.
  - OpenAPI em `/v1/docs` (JSON e YAML) **só com `NODE_ENV=development`**, gerado dos próprios schemas zod. A CSP mais aberta da interface vale só nesse caminho.
  - helmet: CSP `default-src 'none'` com `frame-ancestors`, `base-uri` e `form-action` fechados, HSTS, nosniff, `Referrer-Policy: no-referrer`, sem `X-Powered-By`, inclusive nas respostas de erro.
- **Testes:** 121 na API e 15 no shared. Cobrem prefixo, corpo/query/parâmetro válidos e inválidos, campo desconhecido no topo e aninhado, prototype pollution, JSON malformado, corpo grande demais, formulário recusado, query e corpo não declarados, erros 500/409/403 e headers. **Testes de mutação:** sem a negação por padrão, 1 teste falha; sem o interceptor, 2 falham.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔ · Semgrep local 0 achados
- **Teste manual:** API compilada em desenvolvimento: `/v1/docs` e `/v1/docs/openapi.json` 200; rota inexistente → 404 genérico com `requestId`; `/health/ready?x=1` → 400; CSP e HSTS presentes.
- **Ajuste à parte:** o Dependabot abriu o PR #2 sugerindo `@types/node` 26 com o runtime no Node 24; a config agora ignora majors do `@types/node` (eles mudam junto com o runtime).

## T1.3 Trilha de auditoria

- **Arquivos:** `apps/api/prisma/schema.prisma` (model `AuditLog`, enums), `apps/api/prisma/migrations/20261101204700_audit_log/`, `apps/api/src/common/audit/*`, `apps/api/src/common/context/request-context.ts`, `apps/api/src/common/auth/request-auth.ts`, `apps/api/src/common/prisma/prisma.service.ts` (`db`), `apps/api/src/common/config/env.schema.ts` (`TRUST_PROXY_HOPS`), `apps/api/src/app.{module,setup}.ts`, `.env.example`, `apps/api/test/{audit,audit-proxy}.test.ts`, `apps/api/test/support/{widget-probe.module,global-setup,create-app}.ts`
- **Dependências:** nenhuma nova
- **Como funciona:**
  - Tabela `AuditLog`: quem (tipo e ID do ator), cliente, ação, recurso, estado anterior, estado novo, data (`timestamptz`), IP, user agent, request id, resultado e status HTTP. Sem chave estrangeira para usuário/cliente: o registro sobrevive à exclusão deles.
  - `AuditInterceptor` em todo POST, PUT, PATCH e DELETE. O handler roda numa transação exposta aos services por `PrismaService.db` (AsyncLocalStorage); no sucesso, a auditoria é gravada **na mesma transação**: se ela falhar, a alteração é desfeita. Na falha (validação, permissão, erro), a transação é desfeita e a tentativa é registrada à parte como `failure` ou `denied` (401/403). Se nem isso for possível (banco fora), a tentativa vai para o log com redaction.
  - Os services descrevem a operação com `AuditContext.describe({ action, resourceType, resourceId, before, after })`. Sem descrição, a ação é `MÉTODO /rota`.
  - Estados passam pela mesma limpeza dos logs (senha, token e segredos AWS viram `[REDACTED]`) e acima de 16 kB guardam só o tamanho.
  - **Imutável:** trigger no Postgres bloqueia UPDATE, DELETE e TRUNCATE; o `AuditService` só tem `write`; nenhuma rota escreve em auditoria.
  - IP real atrás do ALB com `TRUST_PROXY_HOPS` (padrão 0, que ignora `X-Forwarded-For` e impede IP forjado; 1 atrás do ALB).
  - O `globalSetup` dos testes agora recria o schema do banco de teste a cada execução (sempre um banco `_test`).
- **Testes:** 139 na API. Cobrem os campos gravados, estado anterior e novo, ação padrão com o status declarado, limite de tamanho, rollback quando o handler falha depois de gravar, **rollback quando a própria auditoria falha**, validação recusada auditada, corpo não declarado auditado, acesso negado como `denied`, leitura não auditada, UPDATE/DELETE/TRUNCATE bloqueados (SQL e Prisma), IP pelo proxy confiável e X-Forwarded-For forjado ignorado. **Testes de mutação:** com o handler fora da transação, 2 testes falham; com a ordem dos interceptors invertida, 1 falha.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔ · Semgrep local 0 achados
- **Teste manual:** `pnpm db:deploy` e, no `psql` do banco de desenvolvimento, INSERT aceito e UPDATE, DELETE e TRUNCATE recusados com "AuditLog é somente inserção".
- **Pendente para o E8:** em produção a aplicação deve rodar com um papel de banco sem privilégio de dono (só as migrations usam o dono), para que nem a própria aplicação consiga remover o trigger.

## T5.1 Módulo do indexer

- **Arquivos:** `apps/api/src/indexer/{indexer.config,indexer-secrets,alert-queries,indexer.client}.ts`, `apps/api/test/indexer/{alert-queries,indexer-config,indexer-client}.test.ts`, `apps/api/package.json`, `pnpm-lock.yaml`
- **Dependências:** `@opensearch-project/opensearch` 3.9.0, `@aws-sdk/client-secrets-manager` 3.1161.0 e `@aws-sdk/client-ssm` 3.1161.0, todas da lista aprovada, nas versões mais recentes, fora da quarentena e com a política de confiança do workspace respeitada.
- **Como funciona:**
  - **Credencial e CA:** em produção, o usuário só leitura vem do Secrets Manager (segredo `wazuh-api-read`, T4.8), com cache de 5 minutos, e a CA do Wazuh vem do SSM Parameter Store, conferida como PEM. A configuração **recusa credencial no ambiente em produção** e exige `https`. Em desenvolvimento e teste, credencial no ambiente e CA num arquivo. As mensagens de erro de configuração citam só os nomes das variáveis.
  - **Cliente:** só busca, só em `wazuh-alerts-*`, sem método de escrita. TLS validado contra a CA do Wazuh (`rejectUnauthorized`), timeout de 10 s (de 1 a 30 s), uma nova tentativa, sem sniffing. Se o indexer recusar a credencial (401), renova uma vez, para acompanhar a rotação de senha. A resposta é validada com zod. **Os erros não carregam a requisição:** os erros do driver trazem o cabeçalho de autenticação, então o cliente devolve só o status ou o tipo de falha.
  - **Consultas** só pelos construtores tipados (`alertsAfter`, `alertById`): campos de filtro numa lista fechada, conferida também em execução; valores só como `term`, `terms` e `range`, curtos e sem caractere de controle; leitura incremental por cursor (`search_after` com timestamp e id, sem pular nem repetir); página de até 1.000. Uma guarda percorre toda consulta antes do envio e recusa `query_string`, `wildcard`, `regexp`, `script` e outras construções que interpretam texto ou executam código.
- **Testes:** 23. Consultas: DSL exato, cursor, filtros, **texto malicioso vira valor literal de term**, campo fora da lista recusado mesmo com tipo forçado, valores inválidos, guarda em qualquer nível. Configuração e segredos: produção só com AWS, sem vazar valores, cache e renovação, segredo malformado, CA em PEM. Cliente contra um indexer HTTPS local com CA descartável: busca com TLS e credencial; **servidor de outra CA recusado sem enviar nada**; tempo limite; renovação depois de rotação; erro sem credencial nem requisição; nada enviado fora do padrão de alertas ou com consulta interpretável. Suíte da API completa: 162. ESLint e Semgrep limpos (a validação do PEM deixou de usar regex, apontada como risco de ReDoS).
- **Definição de pronto:** credencial do Secrets Manager, TLS validado e timeout ✔ · query DSL estruturado, nunca texto do usuário ✔ · somente leitura ✔
- **Desvio:** a configuração do indexer tem schema próprio até o módulo ser registrado na API (T5.3, depois do merge do E2, que reescreve o `env.schema.ts`). Aí os campos passam para o schema principal e para o `.env.example`.
- **Correção (revisor automático do PR #8):** por padrão, o OpenSearch responde 200 com o que conseguiu quando um shard falha ou o tempo estoura (`allow_partial_search_results`). Na leitura incremental, o cursor avançaria sobre a página incompleta e os alertas que faltaram nunca seriam lidos. Agora a busca pede `allow_partial_search_results=false`, e qualquer resposta com `timed_out` ou `_shards.failed > 0` é recusada como erro: o sync tenta de novo a partir do mesmo cursor. Testes: resposta parcial por tempo e por shard recusada, parâmetro presente na requisição. Mutação: sem a checagem, 2 testes falham; sem o parâmetro, 1 falha.

## T5.2 Vínculo entre alerta e cliente: núcleo (persistência depois do E3)

- **Arquivos:** `apps/api/src/alerts/{wazuh-alert,alert-owner}.ts`, `apps/api/test/alerts/{fixtures,wazuh-alert.test,alert-owner.test}.ts`
- **Dependências:** nenhuma nova.
- **Conferido antes de escrever** (código do wodle aws-s3 e ruleset do Wazuh 4.14.9, direto da imagem):
  - só o CloudTrail grava a conta no alerta (`aws_account_id`, da pasta `AWSLogs/<conta>`, que o gerador fixa por conta);
  - no GuardDuty e no WAF, a conta vem do próprio evento (`accountId` e `arn`; ARN do `webaclId`), que **o cliente controla**, porque o bucket é dele;
  - listas de um item viram objeto;
  - o horário vem com fuso sem dois-pontos (`+0000`), que o validador ISO do zod recusa.

  A leitura também revelou as correlações entre contas, corrigidas no E4 (seção "Correção nas T4.4 a T4.6", no PR do E4).

- **Como funciona:**
  - **`parseWazuhAlert`:** valida o envelope (id, horário, regra, MITRE) e extrai do evento da AWS só o que a API usa: fonte, bucket de origem, contas citadas, região, nome do evento, severidade da AWS, identidade, chave de acesso, IP e recurso. Cada campo é conferido no formato (IP real, ARN, chave, bucket, sem caractere de controle). O resto, inclusive `full_log`, `previous_output` e cabeçalhos HTTP, não é guardado.
  - **`resolveAlertOwner`:** a única função que decide de quem é um alerta. Ele só é do cliente quando **duas origens independentes concordam**:
    1. o bucket de onde o Wazuh leu está cadastrado para aquela fonte, e só por esse cliente;
    2. o evento cita uma única conta, cadastrada para o mesmo cliente. No CloudTrail, essa conta também precisa ser uma das que cadastraram o bucket.

    Um cliente que forje no próprio bucket um evento com a conta de outro cai na fila sem dono, assim como bucket não cadastrado, bucket ou conta em dois clientes, contas divergentes no evento, evento sem conta e campo de conta fora do formato (este invalida o alerta, em vez de sobrar outro campo). O motivo vai junto, para o `admin_verax`.

  - **Casos legítimos cobertos:** trilha da organização (contas do mesmo cliente com o mesmo bucket) e GuardDuty com administrador delegado (achado de outra conta do mesmo cliente).
- **Testes:** 20, com alertas no formato real das três fontes e contas de dois clientes:
  - atribuição certa por fonte;
  - eventos forjados com a conta de outro cliente (GuardDuty, WAF e CloudTrail);
  - todos os motivos de "sem dono";
  - trilha da organização e administrador delegado;
  - horário do Wazuh;
  - extração e saneamento campo a campo;
  - nada além do necessário serializado.

  **Mutação:** seis alterações nas regras de dono (não cruzar bucket e conta, aceitar bucket ou conta de dois clientes, pular campo inválido, usar a primeira de contas divergentes, não exigir a conta do bucket no CloudTrail) são todas pegas pelos testes.

- **Pendente (depois do E2/E3):**
  - montar o `AccountDirectory` a partir do cadastro de contas da T3.3, que precisa guardar os buckets de cada fonte e recusar a mesma conta em dois clientes;
  - a tabela `UnownedAlert` com o motivo;
  - o teste de isolamento ponta a ponta no sync (T5.3).
- **Definição de pronto (parcial):** função única que descobre o cliente pela conta do alerta ✔ · alerta de conta não cadastrada para a fila sem dono ✔ (decisão; a gravação vem com a T5.3) · testes com alertas de duas contas de clientes diferentes ✔

## T5.3 Sync de alertas para achados: núcleo (job e gravação depois do E3)

- **Arquivos:** `apps/api/src/alerts/{finding-draft,sync-query,raw-alert}.ts`, `apps/api/src/indexer/alert-queries.ts` (filtro `data.integration`), `apps/api/test/alerts/finding-draft.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Achado** (`toFindingDraft`): leva o cliente e a conta decididos pela T5.2, o id do alerta como chave de idempotência (`source` + `sourceEventId`), horário em UTC, regra, fonte, evento, região, recurso, identidade, chave, IP e táticas/técnicas MITRE.
  - **Severidade:**
    - GuardDuty: a da própria AWS, nas faixas do GuardDuty (9+ crítica, 7+ alta, 4+ média), porque as regras do Wazuh juntam 7 a 9 num nível só;
    - demais fontes: pelo nível da regra (12+ crítica, 10+ alta, 7+ média, abaixo baixa). Assim, a força bruta no console e a rajada de bloqueios do WAF (nível 10) ficam altas, e um login com falha isolado (5) fica baixo.
  - **Leitura incremental** (`syncWindowStart`, `syncPage`, `cursorFromSort`):
    - cada execução relê 10 minutos antes do último alerta processado (o alerta pode chegar ao indexer fora de ordem), e a gravação idempotente evita duplicata;
    - dentro da execução, as páginas seguem pelo cursor de horário e id;
    - o cursor vem dos valores de ordenação devolvidos pelo indexer, para um alerta inválido também ser pulado;
    - a consulta pega só alertas do módulo aws-s3, das três fontes coletadas, com nível 5 ou mais. Abaixo disso ficam os eventos de auditoria do CloudTrail (nível 3), que viram contexto e não achado.
  - **Evento bruto do detalhe** (`sanitizeRawAlert`, para a T5.4):
    - tira `full_log` e `previous_output` em qualquer nível;
    - troca o valor de cabeçalhos de credencial (`authorization`, `cookie`, `x-api-key`...);
    - descarta chaves de protótipo e limita a profundidade.
- **Testes:** 30 nos alertas, 53 contando o indexer.
  - Faixas de severidade nas duas regras, achado completo e campos ausentes como `null`.
  - Saneamento: log bruto, cabeçalhos sem diferenciar maiúsculas, `__proto__` sem contaminar e profundidade.
  - Janela, página em DSL estruturado e cursor.
  - **Conferido também contra o indexer real** (wazuh-indexer 4.14.9 com o template oficial do Wazuh, num contêiner local): o `search_after` com a data ISO e o id pagina sem pular nem repetir, inclusive com empate de horário na virada de página. Os filtros excluem nível baixo, alerta do manager, fonte não coletada e o que é anterior à janela, e `+0000` e `-0300` caem no mesmo instante.
- **Premissas a confirmar:**
  - nível mínimo 5 para virar achado;
  - sobreposição de 10 minutos;
  - na primeira execução, as últimas 24 horas.

  Os três ficam em configuração.

- **Pendente (depois do E2/E3):**
  - o job (`worker` com advisory lock);
  - o model `Finding` com `@@unique([source, sourceEventId])`, o `UnownedAlert` e o estado do sync;
  - as exceções da T3.5;
  - `lastEventAt` por conta;
  - as métricas do worker para os alarmes da T8.6.
- **Riscos:** um alerta indexado mais de 10 minutos depois do horário dele (filebeat parado, por exemplo) fica de fora. O alarme de sync parado da T8.6 cobre o caso do filebeat, e a sobreposição pode subir em configuração.

## T5.6 Agrupamento em incidentes: núcleo (gravação depois do E3)

- **Arquivos:** `apps/api/src/incidents/correlation.ts`, `apps/api/test/incidents/correlation.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona** (regra v1 do plano):
  - **Chaves de correlação:** usuário, chave de acesso, IP e recurso do achado.
  - **`planIncident`:** o achado entra no incidente aberto **do mesmo cliente** que tenha uma chave em comum e cujo período, alargado pela janela (60 minutos, configurável), contenha o horário do achado. Havendo vários, entra no de atividade mais recente.
    - Incidente de outro cliente nunca é candidato, nem com o mesmo IP.
    - Sem incidente para entrar, achado médio ou mais grave abre um novo, e achado baixo fica só como achado.
  - **Nota de risco** (premissa aprovada):
    - base pela severidade mais alta (70, 50, 30, 10);
    - +15 com item da lista de proteção do cliente;
    - +10 com identidade root ou "admin" no nome;
    - +3 por achado além do primeiro, até +15;
    - teto 100.
  - **`summarizeIncident`:** severidade, nota, período, chaves, contas, recursos e táticas/técnicas MITRE sem repetição, para a lista e o detalhe da T5.7. Recusa achados de clientes diferentes no mesmo incidente.
- **Testes:** 12:
  - janela nas duas pontas, inclusive o achado atrasado;
  - isolamento por cliente;
  - desempate;
  - abertura por severidade;
  - nota nas faixas e no teto;
  - identidade privilegiada (sem pegar "badminton");
  - resumo completo.

  **Mutação:** tirar o filtro de cliente, tirar a guarda do resumo, contar o primeiro achado na nota ou ignorar o fim da janela é pego pelos testes.

- **Premissa a confirmar:** achado baixo não abre incidente sozinho, para a Torre não virar uma lista de achados.
- **Pendente (depois do E3):** models `Incident` e `IncidentFinding`, a lista de proteção (T3.4), gravação dentro do sync com lock e os endpoints da T5.7.

## T5.8 Postura a partir do Prowler: núcleo (job e endpoints depois do E3)

- **Arquivos:** `apps/api/src/posture/prowler-report.ts`, `apps/api/test/posture/prowler-report.test.ts`
- **Dependências:** nenhuma nova.
- **Conferido no código do Prowler 5.47.0, direto da imagem:**
  - estrutura do JSON-OCSF (`ocsf.py`);
  - nomes dos enums de severidade e status do py-ocsf-models;
  - `status_code` também pode ser **MUTED**: a lista de exceções troca o status original por MUTED (`mutelist.py`). Um parser só com PASS/FAIL/MANUAL recusaria esses itens e, acima de 1%, o relatório inteiro.
- **Como funciona:**
  - **Caminho no bucket** (`parseReportKey`): `<tenantId>/<conta>/<AAAA-MM-DD>/prowler-<horário>.ocsf.json`, como a tarefa da T4.7 grava. Data e horário precisam existir no calendário e ser do mesmo dia; fora disso, o arquivo é ignorado.
  - **Relatório** (`parseProwlerReport`): lê só os campos usados (checagem, resultado, severidade, título, região, recurso, detalhe, risco, correção e referências). Os metadados do recurso (`resources[].data`) não são lidos.
    - **Um resultado de outra conta recusa o relatório inteiro:** a pasta é da conta, e um resultado alheio ali não vira postura de ninguém.
    - Itens fora do formato são contados, e acima de 1% o relatório é recusado (sinal de formato novo).
    - Limite de 100 mil resultados; resultado repetido conta uma vez.
  - **Nota de postura** (`summarizePosture`, premissa aprovada): aprovação ponderada pela severidade (crítica 10, alta 5, média 2, baixa 1; informativa não pesa).
    - Manuais e silenciadas ficam fora.
    - Sem peso, a nota é `null`, e não zero.
    - Também conta aprovadas, reprovadas por severidade, manuais e silenciadas, para o histórico por data.
- **Testes:** 11, com resultados na estrutura exata do Prowler 5.47.0:
  - caminho válido e seis inválidos (inclusive `..` e data inexistente);
  - campos lidos sem os metadados do recurso;
  - **relatório com resultado de outra conta recusado**;
  - limite de itens inválidos e de tamanho;
  - MUTED;
  - repetição;
  - nota nas regras e do relatório até a nota.

  **Mutação:** tirar a checagem da conta, contar as silenciadas, ignorar o limite de inválidos ou aceitar a pasta de outro dia é pego pelos testes.

- **Pendente (depois do E3):**
  - o job que lista a pasta de cada conta cadastrada (`<tenantId>/<conta>/`, montada pelo cadastro, nunca pelo conteúdo do bucket) e lê o relatório mais novo, com limite de tamanho do objeto;
  - os models de postura e histórico;
  - os endpoints de nota e de achados de postura.

## T5.10 Resumo da Torre: núcleo (endpoint depois do E3)

- **Arquivos:** `apps/api/src/tower/tower-rules.ts`, `apps/api/test/tower/tower-rules.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Semáforo** (pendência 9, aprovada; regra escrita no código):
    - vermelho com incidente crítico aberto;
    - amarelo com incidente alto aberto ou postura abaixo de 70;
    - verde nos demais casos.

    Sem nota de postura, a postura não pesa. Os motivos voltam junto com a cor, para a tela explicar o porquê, e o corte de postura fica em configuração.

  - **Cobertura:** contas conectadas, o evento mais recente e as contas silenciosas (sem evento há mais de 24 horas, configurável, ou que nunca mandaram nada).
  - **Decisões pendentes** (premissa aprovada), só as que existem e em ordem de prioridade:
    - incidente aberto sem responsável;
    - achado alto ou crítico em "novo" fora de incidente;
    - só para `admin_verax`, alertas sem dono.
- **Testes:** 8:
  - as três cores e a precedência do vermelho;
  - incidente médio ou baixo não muda a cor;
  - 70 já é verde;
  - sem nota não pesa;
  - corte configurável;
  - cobertura com conta silenciosa e conta que nunca mandou evento;
  - decisões com e sem `admin_verax`.
- **Pendente (depois do E3):**
  - o endpoint `GET /v1/tower`, com as contagens por cliente via `db.tenant()`;
  - o horário do último evento por conta, que precisa de uma consulta própria ao indexer com agregação por conta, porque o sync só lê alertas de nível 5 ou mais e uma conta tranquila pareceria silenciosa.

## T5.9 Inventário de ativos e identidades: núcleo (job e endpoints depois do E3)

- **Arquivos:**
  - `apps/api/src/inventory/{read-only-session,collectors,risk-rules,inventory}.ts`;
  - `apps/api/test/inventory/{fake-aws,read-only-session.test,inventory.test,risk-rules.test}.ts`;
  - `apps/api/package.json`, `pnpm-lock.yaml`.
- **Dependências:** `@aws-sdk/client-sts`, `@aws-sdk/client-iam`, `@aws-sdk/client-ec2` e `@aws-sdk/client-s3` 3.1161.0, da lista aprovada. É a última versão, de 30/10, fora da quarentena, e a mesma dos clientes que já estavam no projeto. Entraram só 7 pacotes novos (o resto é compartilhado), e a política de confiança do workspace aceitou todos.
- **Como funciona:**
  - **Sessão** (`assumeReadOnlyRole`): papel `arn:aws:iam::<conta>:role/VeraxControlReadOnly`, derivado do ID (o cadastro não escolhe papel). Usa o ExternalId da conta, sessão de 15 minutos e nome fixo.
    - Conta e ExternalId fora do formato são recusados antes de chamar a AWS.
    - **As credenciais temporárias ficam num campo privado**, e o objeto se apresenta como `[credenciais temporárias]` no JSON, no texto e no log.
    - Os erros citam só a conta e o código da AWS (a mensagem da AWS traz ARNs e detalhes).
  - **Coleta**, só com leituras cobertas pelo papel (SecurityAudit + ViewOnlyAccess):
    - root (MFA e chaves);
    - usuários IAM (console, MFA, chaves com idade e último uso);
    - instâncias EC2 (estado, IP público, IMDSv2) e security groups (regras abertas para 0.0.0.0/0 ou ::/0), nas regiões habilitadas ou nas do cadastro;
    - buckets (política pública, ACL pública e bloqueio de acesso público).

    Paginação completa, teto de 1.000 itens por tipo (com aviso de corte) e no máximo 4 chamadas simultâneas. Políticas, tags e conteúdo não são lidos. Uma parte que falha (permissão, região desligada) fica em `errors` com o código e não derruba as outras. "Sem perfil de console" só vale para o erro `NoSuchEntity`: outro erro sobe, para não virar "sem console" por engano.

  - **Risco por ativo** (regras v1, com motivo para a tela):
    - root sem MFA ou com chave: crítico;
    - console sem MFA: alto;
    - chave ativa com mais de 90 dias: médio;
    - chave parada há 90 dias (contando da criação, se nunca usada): baixo;
    - security group: tudo aberto, 22 ou 3389 é crítico; porta de banco é alto; outra porta é médio; só 80/443 ou ICMP é baixo;
    - instância: IMDSv1 com IP público é médio, sem IP público é baixo;
    - bucket com política ou ACL pública que o bloqueio do bucket não impede: alto;
    - bucket sem bloqueio ou com leitura recusada: baixo.
- **Testes:** 18, com clientes falsos da AWS que registram cada chamada e nada de rede:
  - parâmetros exatos do AssumeRole;
  - credenciais escondidas em JSON, texto e `inspect`;
  - entrada inválida sem chamada;
  - erro sem ExternalId nem mensagem da AWS;
  - IAM em duas páginas e no teto;
  - S3 com cada caso de leitura;
  - conta inteira com uma região sem permissão e com regiões do cadastro;
  - papel recusado sem coleta;
  - todas as regras de risco.

  **Mutação:** tirar a validação do ExternalId, pôr a mensagem da AWS no erro, tratar qualquer erro como "sem console", ignorar o bloqueio do bucket, contar a chave nova como parada ou remover uma das camadas que escondem a credencial é pego pelos testes.

- **Desvio:** o bloqueio de acesso público **no nível da conta** não é lido, porque exigiria o `@aws-sdk/client-s3-control`, fora da lista aprovada. Por isso o bucket público fica "alto", e não "crítico". A postura do Prowler (T5.8) confere esse caso por completo. Se quiser, aprove o pacote e eu completo.
- **Pendente (depois do E3):**
  - o job, por conta cadastrada, com o ExternalId do cadastro e o papel IAM próprio do worker (T8.4);
  - os models do inventário;
  - os endpoints de listagem com o risco.
