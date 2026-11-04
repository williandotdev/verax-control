# Status de execução

Registro de cada task executada: arquivos, dependências, testes, definição de pronto, teste manual e riscos.
O campo "Status" no `PLANO.md` só é marcado como concluído depois da confirmação do responsável pelo produto.

## Desvios em relação ao plano

| Item                      | Desvio                                                                                                            | Motivo                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nestjs-zod                | Removido; validação com o `StandardSchemaValidationPipe` nativo do NestJS 12, estendido (`AppValidationPipe`)     | A versão 5.5.0 não suporta NestJS 12 (peer pede ≤ 11). O Nest 12 e o @nestjs/swagger 12 já aceitam schemas zod (Standard Schema) na rota e no OpenAPI                                                                                                 |
| pino-http 11.0.0          | Adicionado                                                                                                        | Peer obrigatório do nestjs-pino 5.3.1                                                                                                                                                                                                                 |
| Versões                   | Algumas um patch abaixo da última                                                                                 | Quarentena de 24h (`minimumReleaseAge`)                                                                                                                                                                                                               |
| prisma 7.10.1 (CLI)       | Exceção em `trustPolicyExclude`, só para essa versão; aprovada pelo responsável em 01/11/2026                     | O Prisma publica o CLI com token do bot desde prisma/orm#30035 (issue prisma/orm#30850). A 7.9.x teria advisories em mysql2 e deepmerge-ts e não teria a correção de transação aninhada. Remover quando voltar a ter provenance                       |
| Trivy AWS-0104 (Wazuh)    | Exceção inline (`#trivy:ignore`) na saída HTTPS para `0.0.0.0/0` do security group do Wazuh                       | O host baixa imagens do Docker Hub e o feed de vulnerabilidades do Wazuh, ambos com IPs dinâmicos. Saída limitada à porta 443, pelo NAT e com flow logs. A alternativa mais restrita (filtro por domínio) é o AWS Network Firewall, com custo próprio |
| Trivy AWS-0015 (conector) | Exceção inline na trilha do CloudTrail do template do conector                                                    | Falso positivo: o adaptador de CloudFormation do Trivy lê `KmsKeyId`, mas o esquema exige `KMSKeyId`, que está definido com a chave do conector. O teste `test_trail_is_multi_region_validated_and_encrypted` garante a chave                         |
| Política extra do Prowler | Sem `securityhub:BatchImportFindings`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` e `logs:FilterLogEvents` | Escrita, download de imagens e leitura do conteúdo de logs de aplicação (LGPD) vão além de ler configuração. As checagens do Prowler que dependem delas não rodam                                                                                     |
| shadcn/ui                 | Componentes no padrão shadcn/ui escritos no repositório sobre `radix-ui`, sem rodar o CLI                         | O `init` do CLI instala pacotes fora da lista aprovada e baixa código da internet direto para o repo; os componentes são os mesmos padrões, revisados linha a linha                                                                                   |

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

## T2.1 Login com Better Auth ⚠️ épico de autenticação (revisão linha a linha no fim do E2)

- **Arquivos:** `apps/api/src/auth/{auth.constants,auth.factory,auth.controller,auth.module,session.guard,me.controller,decorators,user-provisioning}.ts`, `apps/api/src/cli/seed.ts`, `apps/api/prisma/schema.prisma` (Tenant mínimo, User, Session, Account, Verification), `apps/api/prisma/migrations/20261101214647_auth_core/`, `apps/api/src/common/auth/request-auth.ts`, `apps/api/src/common/config/env.schema.ts`, `apps/api/src/common/http/route-contracts.ts`, interceptors de auditoria e de entrada (`@SelfManaged`), `scripts/setup-env.mjs`, `.env.example`, testes `apps/api/test/auth-login.test.ts` e `test/support/auth-helpers.ts`
- **Dependências:** better-auth 1.7.14 (aprovada)
- **Como ficou:**
  - Better Auth montado em `/v1/auth/*` por um controller Nest (herda request id, logs com redaction, helmet e filtro de erro). **Lista fechada de 9 rotas** (login, logout, sessão, redefinição e troca de senha, listar/revogar sessões); cadastro, alteração de usuário, exclusão de conta, troca de e-mail e login social respondem 404 sem chegar à biblioteca.
  - Todo POST de autenticação exige `Origin` do painel e corpo JSON. O Better Auth só confere a origem quando já há cookie; a checagem extra impede login CSRF.
  - Sessão em cookie `__Secure-verax.session_token`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. Sem cache em cookie: revogar vale na hora.
  - Expira após 30 min sem uso (renovada a cada minuto de atividade) e dura no máximo 12 h, conferido pelo `SessionGuard` a cada requisição. Usuário desativado perde o acesso na hora.
  - Hash de senha pelo Better Auth (scrypt); senha de 12 a 128 caracteres. Tokens de redefinição guardados com hash. Telemetria desligada.
  - `role`, `tenantId` e `status` com `input: false`: nenhum endpoint de autenticação aceita esses campos do cliente. Só usuário `active` de cliente `active` recebe sessão.
  - O IP repassado ao Better Auth vem do Express (respeitando `TRUST_PROXY_HOPS`); qualquer valor mandado pelo cliente no header interno é sobrescrito.
  - **Guard global:** toda rota exige sessão, exceto `@Public()`. O meta-teste mantém a lista de rotas públicas fechada (health check e autenticação) e a de rotas `@SelfManaged` (só a autenticação).
  - Banco: CHECK garante que `admin_verax` não tem cliente e os outros papéis sempre têm; CHECK garante e-mail normalizado.
  - `GET /v1/me` devolve a identidade da sessão.
  - Seed de desenvolvimento (`pnpm db:seed`): um `admin_verax` (credenciais em `SEED_ADMIN_*` no `.env` local) e dois clientes fictícios. Idempotente; recusa produção.
  - `pnpm setup:env` passou a completar um `.env` existente com as variáveis novas, sem alterar as que já estão lá e sem imprimir valores.
- **Testes:** 163 na API (+24). Cobrem atributos do cookie, `/v1/me` com e sem sessão e com cookie forjado, logout revogando no servidor, senha errada e e-mail inexistente com resposta idêntica, usuário desativado, convidado e de cliente inativo sem sessão, hash no banco, 6 rotas da biblioteca fora da lista (404), login por formulário (415), login de outra origem (403), expiração por inatividade e por 12 h, desativação com sessão aberta, IP forjado ignorado e os CHECKs do banco.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔ · Semgrep 0 achados, Gitleaks limpo
- **Teste manual:** API compilada com o admin do seed (script que lê a senha do `.env` sem exibi-la): login 200 com cookie `HttpOnly`/`Secure`/`SameSite`; `/v1/me` 200; logout 200; `/v1/me` depois do logout 401; senha errada 401; nenhum segredo no log.

## T2.2 MFA obrigatório ⚠️ épico de autenticação

- **Arquivos:** `apps/api/src/auth/{auth.factory,auth.controller,auth.constants,decorators,session.guard,me.controller}.ts`, `apps/api/src/common/http/{api-error,all-exceptions.filter}.ts` (código estável opcional no `ApiError`), `apps/api/src/common/auth/request-auth.ts`, `apps/api/prisma/schema.prisma` (`User.twoFactorEnabled`, `TwoFactor`), `apps/api/prisma/migrations/20261101220927_two_factor/`, testes `apps/api/test/auth-mfa.test.ts` e `test/support/{auth-helpers,totp}.ts`
- **Dependências:** nenhuma nova (plugin `twoFactor` do próprio Better Auth)
- **Como ficou:**
  - TOTP de 6 dígitos (30 s) e 10 códigos de recuperação de uso único. Segredo e códigos são cifrados pelo Better Auth antes de ir para o banco.
  - **Primeiro login:** a sessão só alcança `GET /v1/me` (com `mfaEnabled: false`) e as rotas de cadastro do MFA. Qualquer outra rota responde 403 com `code: MFA_REQUIRED`. O cadastro exige a senha e só ativa depois do primeiro código válido.
  - **Logins seguintes:** a senha devolve só um desafio (`twoFactorRedirect`, sem cookie de sessão); a sessão só nasce com o código TOTP ou um código de recuperação.
  - 5 códigos errados bloqueiam a conta por 15 min (bloqueio por conta do plugin); o desafio vale 5 min.
  - "Confiar neste dispositivo" é recusado (400): o código é pedido em todo login.
  - O MFA não pode ser desligado (a rota não existe na lista) nem recadastrado por quem já o tem, para não trocar o autenticador sem o código atual. A troca de autenticador perdido será uma ação de administrador (T3.2).
  - Rotas de OTP por e-mail do plugin ficam fora da lista (404).
- **Testes:** 175 na API (+12). Os códigos TOTP dos testes vêm de um gerador RFC 6238 próprio dos testes, independente da biblioteca. Cobrem bloqueio sem MFA, cadastro com senha errada e certa, MFA inativo até o primeiro código, cifragem no banco, senha sozinha sem sessão, código errado, código de recuperação de uso único, `trustDevice` recusado, bloqueio após 5 erros, rota de desligar inexistente, recadastro recusado e OTP por e-mail inexistente. **Testes de mutação:** sem o portão de MFA no guard, 2 testes falham; liberando a rota de desligar, 1 falha.
- **Definição de pronto:** critérios de aceite ✔ (TOTP no primeiro login e em todo login, códigos de recuperação, sem MFA só a tela de cadastro) · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔ · Semgrep 0, Gitleaks limpo
- **Teste manual:** coberto pelos testes de ponta a ponta da API; o fluxo pela tela entra na T6.5 (QR gerado localmente no navegador).

## T2.3 Proteções de login e sessão ⚠️ épico de autenticação

- **Arquivos:** `apps/api/src/auth/{login-attempts,auth-audit,csrf}.ts`, `apps/api/src/auth/{auth.factory,auth.controller,auth.module,auth.constants}.ts`, `apps/api/src/app.setup.ts` (CORS, cookie-parser), `apps/api/src/common/config/env.schema.ts` (`CSRF_SECRET`, `AUTH_RATE_LIMIT_ENABLED`), `apps/api/src/cli/seed.ts`, `apps/api/prisma/schema.prisma` (`RateLimit`, `LoginAttempt`), `apps/api/prisma/migrations/20261101222623_login_protection/`, `apps/api/vitest.config.ts`, `.env.example`, testes `apps/api/test/{auth-protections,auth-rate-limit}.test.ts`
- **Dependências:** csrf-csrf 4.0.3 e cookie-parser 1.4.7 (aprovadas), @types/cookie-parser (dev)
- **Como ficou:**
  - **Por IP:** limite do Better Auth guardado no banco (vale entre instâncias): login 20 a cada 5 min, código MFA 5 por minuto, pedido de redefinição 5 a cada 15 min, redefinição e troca de senha 10 a cada 15 min, demais rotas 100 por minuto. O IP é o calculado pelo Express (`TRUST_PROXY_HOPS`). Só os testes desligam o limite (`AUTH_RATE_LIMIT_ENABLED`); a API não sobe em produção com ele desligado.
  - **Por conta:** 5 senhas erradas em 15 min bloqueiam o e-mail por 15 min (429 `ACCOUNT_LOCKED`), inclusive para e-mail inexistente, para não revelar quem existe. Contagem atômica numa única instrução SQL; login certo zera. O MFA tem bloqueio próprio (T2.2).
  - **CSRF:** toda escrita autenticada exige `Origin` do painel e o token de `GET /v1/csrf-token` no header `X-CSRF-Token`. O token é ligado à sessão atual (csrf-csrf, HMAC com `CSRF_SECRET`), e o cookie `__Host-verax.csrf` é `HttpOnly`, `Secure` e `SameSite=Strict`, sem `Domain`. As rotas de autenticação têm a checagem de origem própria (T2.1).
  - **CORS:** só a origem do painel, com cookies; métodos e headers restritos. Outra origem não recebe header de permissão nenhum.
  - **Expiração por inatividade:** 30 min, desde a T2.1.
  - **Auditoria:** login (sucesso, falha e conta bloqueada), logout, cadastro e verificação de MFA, uso e regeneração de código de recuperação, pedido de redefinição, redefinição e troca de senha e revogação de sessões vão para a trilha `AuditLog` com ator, e-mail tentado, IP, user agent e request id. A senha tentada nunca é gravada. Uma falha ao gravar a auditoria vai para o log e não derruba o login.
- **Testes:** 191 na API (+16). Cobrem bloqueio após 5 erros (até com a senha certa), e-mail inexistente bloqueado igual, contagem zerada pelo login certo, expiração do bloqueio, eventos de login com sucesso/falha/bloqueio/MFA/logout na auditoria, CSRF (sem token, token de outra sessão, origem errada, leitura sem token, atributos do cookie), CORS liberado só para o painel, limite por IP no login (outro IP segue livre) e no código MFA. **Testes de mutação:** sem o `CsrfGuard`, 3 testes falham; sem o bloqueio por conta, 3 falham.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔ · Semgrep 0, Gitleaks limpo
- **Teste manual:** coberto pelos testes de ponta a ponta da API contra o PostgreSQL; o fluxo pela tela entra na T6.5.

## T2.4 Papéis e permissões ⚠️ épico de autenticação

- **Arquivos:** `packages/shared/src/permissions.ts` (+ teste), `apps/api/src/auth/{permissions.guard,decorators,auth.module,me.controller,csrf}.ts`, `apps/api/src/common/http/route-contracts.ts`, testes `apps/api/test/{permissions,route-contracts}.test.ts`
- **Dependências:** nenhuma nova
- **Como ficou:**
  - Papéis `admin_verax`, `admin_cliente`, `analista_cliente` e `leitura`, e uma matriz `recurso:ação` → papéis em `packages/shared` (fonte única da API e do painel). `admin_verax` tem tudo; `leitura` só tem permissões `:read`; cadastrar clientes, trocar de cliente e ver alertas sem dono são exclusivos da Verax; gerenciar usuários e ver auditoria são de administradores.
  - Rotas declaram `@RequirePermission('recurso:ação')` (todas exigidas) ou `@Authenticated()` (qualquer logado, explícito). **Rota sem declaração é negada até para `admin_verax`** e o descuido vai para o log.
  - Ordem dos guards globais: sessão (+ MFA) → permissão → CSRF.
  - `GET /v1/me` devolve as permissões do papel, para o painel esconder o que não cabe (a API continua decidindo).
  - Meta-teste: toda rota que exige sessão declara permissão ou `@Authenticated`.
- **Testes:** 219 na API e 21 no shared. Matriz completa de 6 rotas × 4 papéis, rota sem declaração negada para todos (com log), 401 sem sessão, permissões em `/v1/me`, invariantes da matriz no shared. **Teste de mutação:** sem o guard de permissão, 11 testes falham.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔ · Semgrep 0, Gitleaks limpo
- **Ajuste à parte:** o CodeQL do PR #4 apontou condição de corrida (checar e depois escrever) no `scripts/setup-env.mjs`; o `.env` agora é criado em modo exclusivo e completado pelo mesmo descritor de arquivo.

## T2.5 Isolamento por cliente ⚠️ épico de autenticação

- **Arquivos:** `apps/api/src/common/prisma/{tenant-scope,prisma.service}.ts` (+ teste), `apps/api/src/common/context/{request-context,request-context.interceptor}.ts`, `apps/api/src/auth/{session-tenant.controller,session.guard,auth.factory,auth.module}.ts`, `apps/api/src/common/auth/request-auth.ts`, `apps/api/src/common/audit/{audit.interceptor,audit-context.service}.ts`, `apps/api/src/common/http/all-exceptions.filter.ts`, `apps/api/src/app.module.ts`, `apps/api/prisma/schema.prisma` (`Session.activeTenantId`), `apps/api/prisma/migrations/20261101225811_session_active_tenant/`, testes `apps/api/test/tenant-isolation.test.ts` e `test/support/tenant-isolation.ts`
- **Dependências:** nenhuma nova
- **Como ficou:**
  - O cliente do escopo (`scopeTenantId`) sai **sempre da sessão**: o próprio cliente para papéis de cliente; o cliente selecionado para `admin_verax`. Um `activeTenantId` gravado na sessão de um usuário de cliente é ignorado.
  - `prisma.scoped()` devolve o cliente do banco restrito ao cliente da sessão, inclusive dentro da transação da escrita. Em todo model com dado de cliente (`TENANT_SCOPED_MODELS`), toda leitura, contagem, alteração e exclusão recebe `tenantId` no filtro (sobrescrevendo qualquer valor da chamada), toda criação grava o `tenantId` da sessão, e mover um registro para outro cliente ou ligá-lo pela relação é recusado. SQL cru não existe no escopo, e operação desconhecida do Prisma é recusada até ser revisada.
  - `prisma.forTenant(id)` é o escopo explícito para jobs sem sessão (sync, Prowler), nunca com valor vindo do usuário.
  - Registro fora do cliente responde 404, igual a registro inexistente (não confirma que existe). Violação do escopo responde 403 e vai para o log como erro.
  - `admin_verax` sem cliente selecionado recebe 409 `TENANT_REQUIRED` nas rotas de dado de cliente. `POST /v1/session/tenant` (só `admin_verax`, com CSRF) seleciona um cliente ativo para **aquela sessão** e grava a troca na auditoria com o estado anterior e o novo; `DELETE` limpa a seleção.
  - O contexto da requisição (AsyncLocalStorage) agora vale para toda requisição, não só para escritas. Na auditoria, o cliente registrado é o do escopo da operação.
  - **Suíte negativa reutilizável** (`describeTenantIsolation`): A não lista, não lê, não altera e não apaga dado de B, e B continua vendo o próprio. Todo módulo do E3 em diante usa esta suíte.
  - Meta-teste: todo model com coluna `tenantId` no `schema.prisma` precisa estar em `TENANT_SCOPED_MODELS`.
- **Correção encontrada no caminho:** `PrismaService.db` era getter. O `PrismaClient` do Prisma 7 é um Proxy, e getters de subclasse rodam sobre o objeto interno, sem os models; fora de transação, `db.user` era `undefined`. Virou o método `db()`, e o teste de isolamento cobre o caso.
- **Testes:** 259 na API (+40). Escopo unitário (cada operação, sobrescrita de `tenantId`, `OR` preservado, criação, tentativas de mudar de cliente, upsert, operação desconhecida, SQL cru bloqueado) e integração (suíte A→B completa, `tenantId` na query e no corpo recusados, listagem só do próprio cliente, troca de cliente com auditoria, seleção por sessão, limpeza, cliente inexistente/inválido/inativo, usuário de cliente sem troca, `activeTenantId` forjado ignorado, meta-teste do schema). **Testes de mutação:** sem o filtro no `where`, 6 testes falham; aceitando `activeTenantId` de qualquer papel, 1 falha.
- **Definição de pronto:** critérios de aceite ✔ (`tenantId` sempre da sessão, extensão que filtra toda consulta de dado de cliente, só `admin_verax` troca de cliente e a troca é auditada, teste negativo A→B) · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔ · Semgrep 0, Gitleaks limpo

## T2.6 Convite e redefinição de senha ⚠️ épico de autenticação

- **Arquivos:** `apps/api/src/mail/{mail.types,ses.transport,dev-mailbox.transport,templates,mail.module}.ts`, `apps/api/src/auth/{invitation.service,password-links,auth.factory,auth.module}.ts`, `apps/api/src/common/config/{env.schema,load-env-file}.ts`, `apps/api/src/app.module.ts`, `apps/api/src/cli/seed.ts`, `.env.example`, testes `apps/api/test/auth-invitation.test.ts` e `test/support/{memory-mail,create-app}.ts`
- **Dependências:** @aws-sdk/client-sesv2 3.1161.0 (aprovada)
- **Como ficou:**
  - **Convite:** `InvitationService.invite` cria o usuário `invited`, sem senha, e manda um link de uso único que vale 60 min. Definir a senha pelo link ativa a conta; no primeiro login, o usuário cadastra o MFA (T2.2). As rotas de gestão de usuários (T3.2) usam este serviço.
  - **Redefinição:** mesmo mecanismo (token aleatório do Better Auth, guardado só com hash, uso único, 60 min). Redefinir derruba todas as sessões abertas; o MFA continua exigido.
  - **Sem enumeração:** resposta idêntica para e-mail existente, inexistente e de usuário desativado (que não recebe nada). O e-mail sai em segundo plano, então o tempo de resposta também não denuncia quem existe (medido: mediana de 27 ms contra 25 ms).
  - O token vai no **fragmento** do link (`/convite#token=…`, `/redefinir-senha#token=…`): o navegador nunca o envia a servidor nenhum, nem no `Referer`, e ele não aparece em log de CDN, de proxy ou da API.
  - E-mail: SES em produção (credenciais do papel IAM da task, sem chave na configuração; a API não sobe em produção com outro transporte); em desenvolvimento, caixa local `.dev-mailbox/` na raiz (fora do git, arquivos com permissão 600 e pasta bloqueada para o agente); nos testes, memória. Modelos em português com o nome escapado no HTML.
  - Pedido de redefinição, redefinição e troca de senha (que exige a senha atual) vão para a auditoria, sem token nem senha.
- **Testes:** 274 na API (+15). Cobrem convite (usuário sem senha, e-mail com o link no fragmento), ativação pela senha, link de uso único, expiração, token só com hash no banco, senha curta recusada sem queimar o link, resposta idêntica nos três casos, nenhum e-mail para inexistente e desativado, sessões derrubadas na redefinição, auditoria sem token nem senha, troca de senha com a atual, nenhum token no log, caixa local com arquivo `0600`, HTML escapado e validação da região AWS. **Testes de mutação:** sem a ativação no convite, 1 teste falha; mandando link a usuário desativado, 1 falha.
- **Definição de pronto:** critérios de aceite ✔ (convite com link de uso único e validade curta, redefinição no mesmo padrão, resposta idêntica para e-mail existente ou não) · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔ · Semgrep 0, Gitleaks limpo
- **Teste manual:** API compilada com `MAIL_TRANSPORT=dev-mailbox`: pedido de redefinição para o admin do seed e para um e-mail inexistente devolveu o mesmo corpo; só uma mensagem chegou à caixa local (a do admin); nenhum token no log; `.dev-mailbox/` ignorada pelo git.
- **Achado durante o teste manual:** a regex da região AWS tinha perdido o `\d` numa edição, e nenhum teste cobria a região; corrigida e coberta por teste.

### Complemento da T2.6: senha vazada (Have I Been Pwned)

- **Motivo:** premissa aprovada no plano ("senha com no mínimo 12 caracteres e checagem no Have I Been Pwned") que tinha ficado de fora do E2; encontrada ao revisar as premissas antes das telas de autenticação.
- **Arquivos:** `apps/api/src/auth/{auth.factory,user-provisioning}.ts`, `apps/api/src/common/config/env.schema.ts` (+ teste), `.env.example`, `apps/api/test/auth-password-breach.test.ts`, `apps/api/test/support/create-app.ts`
- **Como ficou:** plugin `haveIBeenPwned` do Better Auth na redefinição de senha (que é também o aceite de convite) e na troca de senha. Só os 5 primeiros caracteres do SHA-1 saem da API, com padding; senha encontrada é recusada com "Esta senha aparece em vazamentos conhecidos. Escolha outra."; se o serviço não responder, a senha **não** é aceita (falha fechada). `PASSWORD_BREACH_CHECK_ENABLED` só é desligado nos testes; a API não sobe em produção sem ele. O provisionamento interno (seed e testes) usa o hasher padrão da biblioteca.
- **Testes:** 278 na API (+4). Serviço simulado só para o domínio do HIBP: senha vazada recusada no convite e na troca, senha limpa aceita, só o prefixo do hash sai, e serviço fora do ar faz a troca falhar sem gravar a senha.
- **Pendente para o E8:** a API precisa de saída HTTPS para `api.pwnedpasswords.com` (liberar no egress da VPC).

## Revisão linha a linha do E2 (portão)

- **Como foi feita:** leitura de todo o código de produção do E2 (autenticação, guards, escopo por cliente, auditoria, e-mail, seed, schema e migrations), conferindo cada comportamento do Better Auth no código-fonte da versão instalada (1.7.14). Em paralelo, uma segunda leitura independente, que recebeu só o código e o objetivo, sem as conclusões da primeira. Também entraram os dois apontamentos do revisor automático do PR.
- **Achados corrigidos:**
  - **Cliente desativado não derrubava sessões abertas** (revisor automático): o status do cliente só era conferido no login. Agora vale a cada requisição. Para `admin_verax`, um cliente selecionado que é desativado deixa de valer na sessão.
  - **Escrita negada por permissão, CSRF ou MFA não ia para a auditoria** (revisor automático): no Nest, guard que recusa encerra a requisição antes do interceptor. O novo `DenialAudit` grava essas recusas. Recusa sem sessão fica só no log, para ninguém de fora encher a tabela de auditoria, que não aceita exclusão.
  - **Rotas de sessão do Better Auth ignoravam as regras da API:** `get-session`, `list-sessions`, `change-password` e códigos de recuperação só checam se a sessão existe. Com isso, usuário desativado, sessão com mais de 12 h e sessão sem MFA continuavam alcançando essas rotas. As regras (`resolveSession`) agora valem nelas também. Sessão sem MFA alcança só o cadastro do MFA.
  - **`rememberMe: false` furava o limite de inatividade:** o Better Auth criava a sessão com 24 h e sem renovação. O campo é recusado no login, e nenhuma sessão vale com mais de 30 min de validade à frente.
  - **Troca de senha podia renovar a sessão para sempre:** com `revokeOtherSessions`, o Better Auth cria uma sessão nova e zera a idade. O campo é recusado. Na troca, as outras sessões caem sempre e a atual continua, com a mesma idade.
  - **Bloqueio por conta podia ser furado com requisições simultâneas:** a checagem e a contagem eram separadas. Agora cada tentativa é reservada numa única instrução SQL antes de conferir a senha, e o contador só zera com a sessão completa (senha e código do MFA). Por isso quem tem a senha também não abre desafios de MFA sem limite: são no máximo 5 desafios de até 5 códigos por 15 min.
  - **Código TOTP reaproveitável por até 90 s** (o Better Auth aceita ±1 passo e não guarda o último usado): o código aceito num login fica registrado por 2 min (`UsedTotpCode`, migration nova), e um segundo login com ele é recusado, inclusive em requisições simultâneas.
  - **Login de conta desativada (ou de cliente inativo) com a senha certa respondia diferente da senha errada:** agora a resposta é idêntica, comparada no teste.
  - **Escopo por cliente liberava por padrão:** models sem `tenantId` (sessões, contas, tokens) e o `tenant` passavam sem filtro, e `$transaction` e `$extends` devolviam um client sem escopo. Agora vale uma lista de permitidos: models com `tenantId`; o `tenant` restrito à própria linha e sem criação; o resto lança `TenantScopeViolation`.
  - **Trilha de auditoria vazava entre clientes:** a escrita de um `admin_verax` caía na trilha do cliente selecionado, mesmo sem tocar dados dele. Uma troca de A para B, por exemplo, ficava visível ao admin de A, com o ID de B. Agora o registro entra na trilha do cliente cujos dados foram tocados (`scoped()` marca isso). A troca entra na trilha do cliente escolhido, sem citar o anterior. Operação global da Verax fica fora de qualquer trilha de cliente.
  - **Convite sem validade real:** pela rota pública, um convidado recebia link novo a qualquer momento. Agora só o `InvitationService` (convite e reenvio pelo administrador) manda link de convite; a rota pública atende só usuários ativos.
  - **Segredo do TOTP relido depois do cadastro:** `get-totp-uri` saiu da lista de rotas. O QR sai só na resposta do `enable`, e o front não usa a rota.
  - **`TRUST_PROXY_HOPS` sem trava de produção:** com 0 atrás do ALB, todos dividiriam o mesmo limite de tentativas. A API não sobe em produção com 0. O E8 já usa 1.
  - **Meta-teste de rotas:** passa a fixar a lista de rotas liberadas sem MFA (`MeController.me`, `CsrfController.token`).
- **Testes que não provavam o que diziam, corrigidos:**
  - "o token não vai no corpo": o Better Auth devolve o token, sim. O teste agora prova a propriedade que importa: o token sozinho, sem a assinatura do cookie, não abre sessão.
  - "bloqueio da conta no MFA": o teste caía no limite por desafio. Agora usa um desafio novo depois de 5 erros e confere `ACCOUNT_TEMPORARILY_LOCKED`.
- **Testes:** 316 na API (+38 desde a T2.6), todos passando. **Testes de mutação:** cada correção foi desfeita, uma por vez, e pelo menos um teste falhou em todas as 25. A única que sobreviveu na primeira rodada foi a checagem de requisição anônima no `DenialAudit`, que nenhum caminho alcança hoje. Ela ganhou teste unitário próprio e passou a ser pega.
- **Riscos que ficam:**
  - Bloqueio por conta: quem sabe o e-mail de alguém consegue bloqueá-lo por 15 min com 6 tentativas. É o custo da premissa aprovada (bloqueio por conta), e o limite por IP reduz o abuso.
  - O Better Auth checa o bloqueio do MFA e só depois conta a falha. A reserva de tentativas no login limita o efeito, mas não o elimina dentro de um mesmo lote.
- **Para o E3 (T3.2):** desativar um usuário deve também apagar as sessões dele. O guard já recusa a sessão na requisição seguinte; apagar na hora tira a sessão também das listagens.

## T4.1 Base do Terraform ⚠️ altera `.github/`

- **Arquivos:** `infra/terraform/{bootstrap,modules/private-bucket,modules/kms,modules/network,envs/staging,envs/production}/*`, `.terraform.lock.hcl` de cada raiz, `infra/terraform/.tflint.hcl`, `infra/terraform/README.md`, `.github/workflows/iac.yml`, `.github/dependabot.yml` (ecossistema terraform), `.gitignore` (`*.tfvars`, `backend.hcl`)
- **Dependências:** provider `hashicorp/aws` 6.71.0 (versão exata, lock com hashes de linux_amd64, windows_amd64, darwin_arm64 e darwin_amd64). Ferramentas de CI com checksum fixado: Terraform 1.17.1, TFLint 0.65.0 (+ ruleset aws 0.50.0, assinatura conferida pelo próprio tflint), checkov 3.4.0 por digest.
- **Como funciona:**
  - **Bootstrap:** bucket do state e chave KMS própria (rotação anual, janela de exclusão de 30 dias). Roda uma vez, com state local, e depois migra o próprio state para o bucket (procedimento no README).
  - **State remoto:** backend S3 com `use_lockfile` (lock nativo, sem DynamoDB) e SSE-KMS. Bucket, chave e região ficam no `backend.hcl` local, fora do git, porque contêm o ID da conta.
  - **`private-bucket`:** padrão de todo bucket da conta. Bloqueio de acesso público, `BucketOwnerEnforced` (sem ACL), versionamento, SSE-KMS com bucket key, política que nega acesso sem TLS e com TLS < 1.2, ciclo de vida (expiração opcional, versões antigas, multipart abandonado em 7 dias) e log de acesso opcional.
  - **`kms`:** chave `data` (buckets, discos, segredos) e chave `logs`, cuja política só libera o CloudWatch Logs da própria conta e região, com condição no contexto de criptografia.
  - **`network`:** VPC em 2 zonas fixadas por variável; subnets públicas (/24, sem IP público automático) só para NAT e ALB; subnets privadas (/20) para o resto; 1 NAT em staging e 2 em produção; flow logs de todo o tráfego no CloudWatch, cifrados com a chave `logs` e com 365 dias de retenção; security group padrão sem nenhuma regra; endpoints privados (SSM, Secrets Manager, Logs, STS, ECR, KMS e gateway do S3), para esse tráfego não sair pela internet.
  - **Ambientes:** staging `10.40.0.0/16` e produção `10.50.0.0/16`, ambos em `sa-east-1`, com tags padrão (`Project`, `Environment`, `ManagedBy`).
  - **`iac.yml`:** `fmt -check`, `init -backend=false -lockfile=readonly` e `validate` em cada raiz, `tflint --recursive` e checkov. Nenhum job tem credencial da AWS e não existe plan/apply. Roda em todo PR, sem filtro de caminho, para poder ser check obrigatório.
- **Testes:** `terraform validate` válido nas 3 raízes (0 erros e 0 avisos) · `tflint` sem achados · checkov 119 aprovados, 0 falhas, 17 exceções (todas com motivo no código: política padrão de chave KMS, replicação entre regiões e notificação de eventos de bucket fora do MVP) · actionlint (com shellcheck) e zizmor sem achados. **Testes de mutação** (numa cópia): subnet com IP público automático e chave sem rotação → checkov falha com CKV_AWS_130 e CKV_AWS_7; versão do provider diferente da travada → `init` falha; hashes do lock adulterados → `init` falha ao instalar; variável não usada → tflint sai com código 2.
- **Definição de pronto:** critérios de aceite ✔ (state em S3 com lock e KMS, VPC em 2 zonas, flow logs, tags padrão) · validação ✔ · lint ✔ · dependências ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Teste manual:** n/a sem conta AWS. Roteiro da primeira aplicação no README.
- **Desvios:** o cfn-lint entra na T4.3, junto com o primeiro template CloudFormation. A imagem `ghcr.io/aws-cloudformation/cfn-lint` deixou de aceitar download anônimo (403) e não existe no ECR Public nem no Docker Hub; ele será instalado por pip com `--require-hashes`.
- **Riscos:** o custo fixo vem dos NAT gateways (1 em staging, 2 em produção) e dos 9 endpoints de interface por ambiente. Se o custo de staging pesar, os endpoints podem ser só de produção, com o tráfego de staging saindo pelo NAT.

## T4.2 EC2 do Wazuh com Docker ⚠️ altera `.github/`

- **Arquivos:** `infra/wazuh/{docker-compose.yml,README.md}`, `infra/wazuh/config/{manager/ossec.conf,indexer/opensearch.yml,indexer/internal_users.yml.tmpl,dashboard/opensearch_dashboards.yml}`, `infra/wazuh/scripts/{bootstrap-host,deploy,init-certs,init-security,smoke-test,ci-test}.sh`, `infra/terraform/modules/wazuh/{main.tf,apply.sh.tftpl}`, `infra/terraform/envs/production/main.tf`, `.github/workflows/iac.yml` (job do Wazuh), `.github/dependabot.yml` (compose de `infra/wazuh`)
- **Dependências:** imagens `wazuh/wazuh-manager`, `wazuh-indexer` e `wazuh-dashboard` 4.14.9 (última estável; a 4.14.10 e a 5.0 ainda são release candidate), fixadas por digest. No EC2, plugin docker compose v5.6.1 baixado com SHA-256 conferido. Nenhum pacote npm nem provider novo (as senhas usam o recurso efêmero `aws_secretsmanager_random_password` do provider AWS).
- **Como funciona:**
  - **Instância:** `m7i.xlarge` (4 vCPU, 16 GB) com Amazon Linux 2023 numa subnet privada, sem IP público e sem regra de entrada no security group (saída só HTTPS). Acesso só pelo SSM Session Manager; o dashboard, por port forwarding. IMDSv2 obrigatório com hop limit 1 (nenhum contêiner alcança as credenciais da instância). Proteção contra encerramento, monitoramento detalhado e patches semanais pelo Patch Manager.
  - **Discos:** sistema e dados em gp3 cifrados com a chave KMS de dados. O disco de dados (200 GB) é separado, tem `prevent_destroy` e snapshot final, e guarda o `data-root` do Docker: trocar a instância não perde alertas.
  - **Senhas:** três senhas (admin e kibanaserver do indexer, wazuh-wui da API) geradas pela AWS num recurso efêmero e gravadas no Secrets Manager por `secret_string_wo`: não passam pelo state. A rotação é versionada (`password_version`). O bootstrap lê o segredo direto para o ambiente do processo, sem arquivo e sem argumento.
  - **Bundle:** o Terraform envia `infra/wazuh` para um bucket privado (módulo `private-bucket`) com um `SHA256SUMS`; o user_data e o documento SSM de reaplicação baixam, conferem os checksums e rodam o bootstrap. A instância só lê esse prefixo.
  - **Compose endurecida** (comparada ao single-node oficial): certificados emitidos por script próprio com openssl, sem rede, porque o gerador oficial baixa e executa um script sem checksum; a chave da CA é apagada e cada contêiner monta só o próprio par de chaves; usuários de demonstração do indexer removidos e o outro usuário padrão da API desativado; nenhuma porta do manager publicada; indexer e dashboard só em `127.0.0.1`; `no-new-privileges`; verificação completa de certificado no filebeat e no dashboard; chave fixa de cluster removida do `ossec.conf`; limites de disco do indexer ligados.
  - **Deploy idempotente:** jobs de init com `run --rm` (não sobra contêiner parado com senha no ambiente), `securityadmin` aplica os usuários a cada deploy (é como a rotação chega ao indexer) e o smoke test roda no fim.
- **Testes:**
  - `scripts/ci-test.sh` (local e no CI): instalação nova com senhas aleatórias e rotação das três senhas, cada uma com 22 verificações (senha nova aceita; 7 senhas padrão recusadas; só `admin` e `kibanaserver` existem; HTTP sem TLS e TLS 1.1 recusados; API recusa `wazuh`/`wazuh-wui` padrão; dashboard só por HTTPS; manager sem porta; dashboard e indexer só em 127.0.0.1). Depois da rotação: as 3 senhas antigas recebem 401, o filebeat autentica no indexer com a cadeia verificada (TLS 1.2), o dashboard usa a senha atual da API, e cada volume de certificado só tem as próprias chaves (dono e modo `0400` conferidos), sem chave de CA em lugar nenhum. Passou localmente (4 min 50 s).
  - shellcheck (estilo) sem achados; `docker compose config` válido e recusa subir sem senha; `terraform validate` ok; tflint sem achados; checkov 205 aprovados, 0 falhas.
  - **CI:** novo job "Wazuh (scripts, compose e teste de ponta a ponta)" no `iac.yml`. shellcheck e compose sempre; o teste de ponta a ponta quando o PR mexe em `infra/wazuh` (e sempre no push na main).
- **Definição de pronto:** critérios de aceite ✔ (single-node em subnet privada sem IP público, acesso só por SSM, discos cifrados, TLS gerado e sempre ligado, todas as senhas padrão trocadas e no Secrets Manager) · testes ✔ · lint ✔ · dependências ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Teste manual:** stack local subida, rotacionada e inspecionada (`filebeat test output`, volumes de certificado, `wazuh.yml` do dashboard). Na AWS, o roteiro está no README do bundle.
- **Desvios:** gerador oficial de certificados substituído (motivo acima); `ossec.conf` sem syscheck, rootcheck e SCA do próprio contêiner, que só gerariam ruído.
- **Riscos:** imagens vêm do Docker Hub pela internet (NAT); um espelho no ECR fica para depois do MVP. Riscos residuais da stack (validação do certificado da API pelo plugin do dashboard, manager com o usuário admin do indexer, contêineres sem sistema de arquivos só leitura) estão no README do bundle.

## T4.3 Template do conector do cliente ⚠️ altera `.github/`

- **Arquivos:** `infra/cloudformation/{verax-control-connector.yaml,README.md,requirements-lint.txt}`, `infra/cloudformation/tests/test_connector.py`, `.github/workflows/iac.yml` (job de CloudFormation e checkov também em CloudFormation), `.github/dependabot.yml` (pip)
- **Dependências:** cfn-lint 1.59.0 só no CI, instalado com `--require-hashes --no-deps` a partir do fechamento completo (9 pacotes) com o hash de todos os arquivos de cada versão. `jsonpatch` 1.39 e `jsonpointer` 3.7 tinham 6 h de publicadas; ficaram na 1.38 e na 3.6 (quarentena de 24 h). Nenhuma dependência do produto.
- **Como funciona:**
  - **Papel `VeraxControlReadOnly`:** confia só na conta da Verax, e dentro dela só em papéis com o prefixo `verax-control-production-` (`aws:PrincipalArn`), e exige o `ExternalId` da conta (parâmetro `NoEcho`, mínimo de 32 caracteres). Sessão de no máximo 1 hora. Permissões: `SecurityAudit`, `ViewOnlyAccess`, a leitura extra do Prowler 5.47.0 sem as quatro ações da tabela de desvios, e leitura dos buckets de log, com `kms:Decrypt` só via S3.
  - **CloudTrail (opcional):** trilha multi-região com eventos globais, validação de integridade e SSE-KMS. Também aceita uma trilha existente, informando o bucket e a chave dela.
  - **GuardDuty (opcional):** `AWS::GuardDuty::PublishingDestination` para S3 com a chave do conector, usando o detector existente ou criando um. A bucket policy recusa objeto que não venha cifrado com essa chave.
  - **WAF (opcional):** bucket `aws-waf-logs-verax-control-*` que aceita entregas de qualquer região da conta (web ACLs do CloudFront ficam em us-east-1) e, se informada, liga o log de uma web ACL regional.
  - **Todos os buckets:** bloqueio de acesso público, sem ACL, SSE-KMS com a chave do conector (rotação anual), versionamento, só TLS, retenção configurável (padrão 365 dias), log de acesso (item do CIS e checagem do Prowler) e `DeletionPolicy: Retain`. Toda permissão dada a serviço da AWS (CloudTrail, GuardDuty, entrega de logs, log de acesso) fica restrita à própria conta por `aws:SourceAccount` ou `aws:SourceArn`.
  - **README** em pt-BR para o administrador do cliente: o que é criado, o que a Verax lê e não lê, pré-requisitos, console e CLI (com o `ExternalId` em arquivo de parâmetros, fora do histórico do terminal), WAF do CloudFront, GuardDuty em outras regiões, custos e remoção.
- **Testes:** cfn-lint sem achados; checkov em CloudFormation com 49 aprovados, 0 falhas e 1 exceção com motivo (o bucket de logs de acesso não registra o próprio acesso); Trivy e Semgrep limpos. `tests/test_connector.py` traz 13 testes que leem o template e conferem confiança, `ExternalId`, verbos só de leitura, ações excluídas, `kms:Decrypt` só via S3, propriedades de todo bucket, negação de HTTP, escopo das permissões de serviço, rotação da chave, trilha multi-região e cifrada, exportação do GuardDuty presa à chave e prefixo do bucket do WAF. **Testes de mutação:** 9 de 9 pegos (sem `ExternalId`; papel com `s3:PutObject`; `logs:FilterLogEvents` de volta; bucket com ACL pública; chave sem `SourceAccount` no WAF; trilha de uma região só; trilha com outro nome; qualquer papel da Verax; bucket apagado com o stack).
- **Definição de pronto:** critérios de aceite ✔ (papel só leitura com `ExternalId` que confia só na Verax, CloudTrail multi-região em S3, exportação do GuardDuty para S3, leitura dos buckets de log, README) · testes ✔ · lint ✔ · dependências ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Teste manual:** n/a sem conta AWS. O primeiro stack real é a T9.2, depois da T9.1.
- **Riscos:** trilhas de organização que gravam em outra conta precisam de liberação na conta de logs, fora deste template (está no README). O template não liga o log de web ACLs do CloudFront nem a exportação do GuardDuty em outras regiões: o README traz os passos.

## T4.4 a T4.6 CloudTrail, GuardDuty e WAF no Wazuh (configuração; conexão real bloqueada pela T9.1)

- **Arquivos:** `infra/wazuh/scripts/render-manager-config.py`, `infra/wazuh/tests/{test_render_manager_config.py,fixtures/aws-sources.example.json}`, `infra/wazuh/{docker-compose.yml,README.md}`, `infra/wazuh/scripts/{deploy,bootstrap-host,ci-test}.sh`, `infra/terraform/modules/wazuh/{main.tf,apply.sh.tftpl}`, `infra/cloudformation/{verax-control-connector.yaml,README.md,tests/test_connector.py}` (omissão de cabeçalhos no log do WAF), `.github/workflows/iac.yml`
- **Dependências:** nenhuma nova (o gerador usa o Python do próprio Wazuh e os testes, só a biblioteca padrão).
- **Conferido no código do wodle 4.14.9 antes de escrever:**
  - para buckets, o `ExternalId` só entra pelo profile da AWS (`role_arn` + `external_id` + `credential_source`); o `--external_id` da linha de comando vale só para o Security Lake;
  - o GuardDuty é lido no formato nativo da exportação para S3 (`AWSLogs/.../GuardDuty/`, `.jsonl.gz`);
  - só no CloudTrail o wodle grava a conta no alerta (`aws.aws_account_id`, tirada da pasta `AWSLogs/<conta>` lida). No WAF e no GuardDuty, o `sts:GetCallerIdentity` com o papel assumido só controla o que já foi lido; a conta do alerta vem do próprio evento (`accountId` e `arn` no GuardDuty, ARN do `webaclId` no WAF), que o cliente controla. Por isso a T5.2 cruza essa conta com o bucket de origem (`aws.log_info.s3bucket`) cadastrado (correção feita durante a T5.2, ao reler o código);
  - o leitor do WAF **mantém** os cabeçalhos `authorization`, `cookie` e `proxy-authorization`.
- **Como funciona:**
  - **Lista de contas** num segredo do Secrets Manager (`<nome>/wazuh-aws-sources`), mantida pela API a partir do cadastro (E3/E5). O Terraform só grava `[]` na criação, por argumento write-only, e nunca sobrescreve a lista. Segredo, e não SSM Parameter Store, porque um SecureString comporta 4 a 8 KB (umas 20 contas) e o segredo, 64 KB (limite de 100 contas no gerador).
  - **Gerador** (`manager-config`, imagem do manager, sem rede, a cada deploy): valida a lista inteira (conta com 12 dígitos, `ExternalId` de 32 a 128 caracteres seguros, região, data no formato do Wazuh, nomes de bucket, prefixo `aws-waf-logs-`, sem campo desconhecido nem conta repetida) e gera o `ossec.conf` com o módulo `aws-s3` (um bucket por fonte, com o profile da conta; a pasta da conta é fixada no CloudTrail) e o `/root/.aws/config` (um profile por conta, papel derivado do ID, sessão de 1 hora, STS regional). Valor inválido derruba o deploy sem escrever nada, e o `ExternalId` nunca aparece em mensagem de erro.
  - **Transporte:** do segredo para um arquivo em tmpfs (`/run`, modo 0600, apagado ao sair) e dele para o gerador pela entrada padrão. A lista não passa por variável de ambiente (limite do `execve` e gravação na configuração do contêiner), argumento nem log. Os profiles ficam num volume próprio (`/root/.aws`, root 0700/0600), separado do volume que o init da imagem copia para `/var/ossec`.
  - **Recriação:** o hash do `ossec.conf` base, do gerador e da lista vai num rótulo do manager; se algo mudou, a compose recria o contêiner.
  - **Credencial da instância só para o manager:** hop limit 2 (para o manager, em contêiner, chegar ao IMDS), `http_protocol_ipv6` desligado e o serviço `verax-imds-guard`, que libera o IMDS só para o IP fixo do manager (`172.30.250.10`, fora da faixa dinâmica da rede da compose). No fim de todo deploy, o bootstrap confere que indexer e dashboard **não** alcançam o IMDS e que o manager alcança, e falha se não for assim.
  - **IAM da instância:** `sts:AssumeRole` só em `arn:aws:iam::*:role/VeraxControlReadOnly` (a confiança do papel exige o `ExternalId`) e leitura do segredo da lista. O nome do papel da instância (`verax-control-production-wazuh`) bate com o prefixo que o conector aceita.
  - **WAF:** o template do conector passa a omitir `authorization`, `cookie` e `proxy-authorization` no log da web ACL regional, e o README traz o mesmo para as web ACLs do CloudFront. Assim, tokens e cookies dos usuários do cliente não chegam ao indexer da Verax.
- **Testes:**
  - `test_render_manager_config.py` com 6 testes e 14 casos de entrada inválida, entre eles injeção de linha no profile pelo `ExternalId`, XML no nome do bucket, campo extra tentando escolher o papel e região com comando de shell.
  - `ci-test.sh`, agora com duas contas fictícias na fase de rotação. O parser real do Wazuh aceita o `ossec.conf` gerado, o módulo AWS inicia e analisa os 4 buckets, cada um com o profile da sua conta (sem AWS, a credencial falha, o que prova que o caminho usado é o do profile). Também conferido: manager no IP fixo, `ExternalId` fora do `ossec.conf` e do ambiente do contêiner, profiles só para o root e `wazuh-modulesd` como root. Passou localmente.
  - Conector: 14 testes (novo: omissão dos cabeçalhos de credencial no log do WAF). Terraform `validate` ok, tflint limpo; checkov com 206 aprovados em Terraform e 49 em CloudFormation, 0 falhas; Trivy limpo. Semgrep limpo, com um falso positivo marcado na linha (`chmod 0700` de diretório).
- **Definição de pronto:** código e configuração ✔ · testes ✔ · lint ✔ · regras de segurança ✔. **Pendente da conta real (T9.1 e T9.2):** alertas no indexer com o ID da conta de origem (T4.4), findings do GuardDuty visíveis (T4.5) e requisições bloqueadas do WAF visíveis (T4.6). Nada foi conectado nem aplicado.
- **Riscos:** com hop limit 2, a proteção do IMDS depende do filtro no host (conferido a cada deploy). A API (E5) precisa de permissão de escrita no segredo da lista e de disparar o documento de reaplicação depois de cada cadastro.

## T4.7 Prowler agendado ⚠️ altera `.github/`

- **Arquivos:** `infra/prowler/{Dockerfile,entrypoint.py,README.md,tests/test_entrypoint.py}`, `infra/terraform/modules/prowler/main.tf`, `infra/terraform/envs/production/main.tf`, `.github/workflows/iac.yml` (job do Prowler), `.github/dependabot.yml` (imagem base)
- **Dependências:** imagem `prowlercloud/prowler:5.47.0` (última estável, de 29/10/2026), fixada por digest. Nenhuma dependência nova no produto: o entrypoint usa o boto3 que já vem na imagem, e os testes, só a biblioteca padrão.
- **Como funciona:**
  - **Tarefa ECS Fargate** (2 vCPU e 4 GB) disparada todo dia às 03:00 de Brasília pelo EventBridge Scheduler, em subnet privada e sem IP público. Roda com usuário sem privilégio (uid 1000), raiz só leitura e `/tmp` como único volume gravável, com logs no CloudWatch cifrados.
  - **Entrypoint:** lê a lista de contas num segredo (`<nome>/prowler-targets`, mantido pela API, gravado vazio pelo Terraform por write-only) e valida tudo antes de começar (`tenantId` UUID, conta com 12 dígitos, `ExternalId`, regiões, sem campo desconhecido nem conta repetida). Para cada conta, assume `VeraxControlReadOnly` com o `ExternalId` (sessão de 1 hora) e roda o Prowler com a credencial temporária **só no ambiente do processo filho**, que herda apenas `PATH`, `HOME`, `LANG`, `TMPDIR` e `TZ`. O OCSF vai para `<tenantId>/<conta>/<data>/` com a credencial da tarefa e a chave KMS padrão do bucket. Uma conta com erro não impede as outras; o código de saída alimenta o alarme da T8.6.
  - **Infra:** ECR com tags imutáveis, varredura na publicação, KMS e retenção de 10 imagens; bucket privado (`private-bucket`, 90 dias); cluster com Container Insights. São três papéis: execução (só imagem e log); tarefa (só `sts:AssumeRole` em `*/VeraxControlReadOnly`, leitura da lista, `s3:PutObject` no bucket e KMS via S3 e Secrets Manager; o nome bate com o prefixo que o conector aceita); agendador (só `ecs:RunTask` desta família neste cluster, `iam:PassRole` dos dois papéis para o ECS e `kms:Decrypt` do agendamento, que é cifrado com a chave de dados). As permissões de confiança dos papéis exigem `aws:SourceAccount`.
  - **Publicação:** tarefa e agendamento só existem quando o deploy (E8) informa o digest da imagem no ECR (`prowler_image_digest`).
- **Testes:**
  - `test_entrypoint.py`: 11 testes e 9 casos de lista inválida (entre eles `tenantId` com `../`, campo tentando escolher o papel e região com comando de shell). Conferem o papel e o `ExternalId` do assume role, o caminho no S3, que a credencial do cliente fica só no ambiente do Prowler (sem argumento e sem herdar a credencial da tarefa), regiões, isolamento de falhas, `ExternalId` fora do log e lista ilegível.
  - Imagem construída e testada localmente: testes com o Python da imagem; o Prowler inicia com a raiz só leitura (668 checagens); o entrypoint recusa com código 2 sem configuração e sem credencial.
  - Terraform: `validate` ok, tflint limpo; checkov com 320 aprovados e 0 falhas, também com a imagem publicada (tarefa e agendamento existentes); Trivy e Semgrep limpos.
  - **CI:** novo job "Prowler (entrypoint e imagem)". Os testes rodam sempre; build e execução com raiz só leitura quando o PR mexe em `infra/prowler` (e sempre no push na main).
- **Definição de pronto:** critérios de aceite ✔ (tarefa agendada no ECS Fargate com EventBridge Scheduler, que assume o papel de leitura e roda o Prowler por conta; resultado em JSON-OCSF num bucket da Verax, separado por cliente e data) · testes ✔ · lint ✔ · dependências ✔ · regras de segurança ✔ · **nada aplicado nem publicado na AWS** (portão)
- **Desvios:** a lista de alvos fica no Secrets Manager, e não no SSM Parameter Store previsto no plano, pelo mesmo motivo da T4.4: um SecureString comporta só 4 a 8 KB.
- **Riscos:** a saída HTTPS para qualquer IP (exceção AWS-0104 documentada no código) é necessária porque o Prowler consulta as APIs públicas da AWS em todas as regiões do cliente. Contas grandes podem passar de 1 hora de análise: a sessão do papel do cliente dura no máximo 1 hora (`MaxSessionDuration` do conector); se isso aparecer, a análise passa a ser dividida por região.

## T4.8 Acesso só leitura ao indexer ⚠️ altera `.github/`

- **Arquivos:** `infra/wazuh/config/indexer/{roles_mapping.yml,roles-verax.yml,internal_users.yml.tmpl}`, `infra/wazuh/scripts/{init-security,deploy,smoke-test,ci-test,bootstrap-host}.sh`, `infra/wazuh/{docker-compose.yml,README.md}`, `infra/terraform/modules/wazuh/{main.tf,apply.sh.tftpl}`, `infra/terraform/modules/network/main.tf` (zona DNS privada), `infra/terraform/envs/production/main.tf`, `.github/workflows/iac.yml`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Usuário `verax_api_read`:** papel próprio com `read` só em `wazuh-alerts-*`, sem permissão de cluster. A senha fica num segredo separado (`<nome>/wazuh-api-read`, gerada por recurso efêmero e gravada por write-only), e o papel da API lê só esse segredo, nunca as senhas de administração. A rotação segue a mesma `password_version` das demais.
  - **Achado e correção:** o `roles_mapping.yml` padrão da imagem mapeia o papel `own_index` para todos os usuários (`*`), o que daria a qualquer usuário (até o de leitura) escrita num índice com o próprio nome. Agora o mapeamento é mínimo e explícito: `all_access` (admin), `kibana_server`, `manage_wazuh_index` (kibanaserver) e `verax_api_read`.
  - **Configuração de segurança reproduzível:** o `security-init` parte sempre dos arquivos originais da imagem (o volume deixou de cobrir o caminho dela), acrescenta o papel da Verax, aplica o mapeamento do bundle, gera os usuários com hash e entrega tudo ao uid do indexer (0600). O deploy reaplica a configuração inteira pelo `securityadmin`, então mudanças de papel e de mapeamento também chegam a instalações existentes.
  - **Rede:** zona DNS privada do ambiente (módulo `network`) com o registro `wazuh-indexer.<zona>`. A porta 9200 só é publicada fora de `127.0.0.1` quando há security group autorizado (`indexer_client_security_groups`), e a regra de entrada aceita só esses grupos.
  - **TLS:** o certificado do indexer é emitido também para o nome DNS privado, e o certificado público da CA é publicado no parâmetro `/verax-control/<nome>/wazuh/indexer-ca` a cada deploy. A API valida cadeia e nome.
- **Testes** (`ci-test.sh`, nas duas fases): o `verax_api_read` busca nos alertas (200) e recebe 403 ao escrever nos alertas, ao criar índice com o próprio nome, ao ler `wazuh-states-*` e `.opendistro_security`, em `_cat/indices` e na API de segurança. Só os usuários e mapeamentos esperados existem, e a senha antiga do `verax_api_read` é recusada depois da rotação. Acesso como a API: pelo nome do certificado e com a CA do Wazuh, 200; por outro nome, o TLS recusa. Passou localmente. Terraform válido nos dois ambientes; tflint, checkov (323 aprovados, 0 falhas) e Trivy limpos.
- **Definição de pronto:** critérios de aceite ✔ (usuário só com leitura nos índices de alertas, senha no Secrets Manager, acesso só da rede da API, validação TLS com a CA do Wazuh) · testes ✔ · lint ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Pendente para o E8:** o security group da API entra em `indexer_client_security_groups`; o papel da API recebe leitura do segredo `wazuh-api-read` e do parâmetro da CA.

## T4.9 Retenção e backup

- **Arquivos:** `infra/wazuh/config/indexer/{opensearch.yml,ism-retention.json,sm-daily.json}`, `infra/wazuh/scripts/{lib-indexer,configure-indexer,restore-snapshot,init-security,deploy,bootstrap-host,ci-test}.sh`, `infra/wazuh/{docker-compose.yml,README.md}`, `infra/terraform/modules/wazuh/{main.tf,apply.sh.tftpl}`
- **Dependências:** nenhuma nova (Index Management e Snapshot Management já vêm no indexer).
- **Como funciona:**
  - **Retenção (pendência 6):** a política ISM `verax-retencao` apaga `wazuh-alerts-*`, `wazuh-monitoring-*` e `wazuh-statistics-*` com 90 dias (`alert_retention_days`). Vale para os índices novos, pelo `ism_template`, e é ligada aos existentes. Quando a política muda, os índices passam para a versão nova (`change_policy`).
  - **Snapshot diário:** a política de Snapshot Management `verax-diario` faz o snapshot de `wazuh-*` às 02:00 de Brasília, sem estado global, no repositório em disco `verax-snapshots` (volume próprio, só do uid do indexer), e mantém 14 dias (mínimo de 3).
  - **S3:** a imagem oficial não traz o plugin `repository-s3`, então o host espelha o repositório no bucket de backup às 03:00, pelo timer systemd `verax-snapshot-sync`. O bucket é privado (`private-bucket`), cifrado com KMS e versionado: o que sai do repositório fica 30 dias como versão antiga. A instância só tem acesso ao prefixo `indexer-snapshots/`.
  - **Configuração idempotente** a cada deploy (`configure-indexer.sh`), autenticada pelo certificado admin do indexer (sem senha). As atualizações usam controle de concorrência (`if_seq_no`/`if_primary_term`).
  - **Restauração** (`restore-snapshot.sh`): de um snapshot ou do mais recente, opcionalmente trazendo o repositório do S3 (`--from-s3`) e restaurando com o prefixo `restaurado-` (`--rename`, fora da política de retenção). Sem renomear, recusa índice aberto de mesmo nome: não apaga nem fecha nada. O roteiro está no README do bundle.
- **Testes** (`ci-test.sh`): política de 90 dias; snapshot diário no repositório certo; repositório só do uid 1000 (0700); índice novo de alertas seguindo a retenção; **teste de restauração** (snapshot de um índice com 3 mensagens, índice apagado, restauração com a mesma contagem, restauração renomeada a partir do último snapshot e recusa quando o índice de mesmo nome está aberto). Fluxo também exercitado à mão, incluindo a reaplicação (caminho de atualização). Terraform válido; tflint, checkov (350 aprovados, 0 falhas) e Trivy limpos; shellcheck limpo.
- **Definição de pronto:** critérios de aceite ✔ (política que apaga alertas após o prazo, snapshot diário do indexer em S3, teste de restauração documentado e automatizado) · testes ✔ · lint ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Desvios:** o snapshot é feito em disco e copiado para o S3 pelo host, em vez de um repositório S3 nativo, para manter a imagem oficial do indexer sem plugin adicional.
- **Riscos:** a cópia para o S3 acontece uma hora depois do snapshot: um snapshot que demore mais que isso só vai para o S3 no dia seguinte (o repositório local guarda 14 dias). A observabilidade da T8.6 deve alarmar falha do timer.

## T8.1 Banco em produção

- **Arquivos:** `infra/terraform/modules/database/main.tf`, `infra/terraform/envs/{staging,production}/main.tf`
- **Dependências:** nenhuma nova. PostgreSQL 18 no RDS (última minor: 18.6), a mesma major do ambiente local e do CI.
- **Como funciona:**
  - RDS PostgreSQL 18 em subnets privadas, `publicly_accessible = false`, security group **sem regra de saída** e entrada na 5432 só dos security groups autorizados (API, worker e migrations, ligados na T8.2).
  - Disco gp3 cifrado com a chave de dados, crescimento automático até 200 GB, Performance Insights cifrado e monitoramento avançado.
  - Senha mestra gerada e guardada pelo próprio RDS no Secrets Manager, cifrada com a chave de dados: não passa pelo state nem pelo código. A aplicação não usa essa conta: os papéis de banco dela nascem no bootstrap (T8.2).
  - Grupo de parâmetros com TLS obrigatório (`rds.force_ssl`, mínimo TLS 1.2), SCRAM-SHA-256 e log de conexões. **Sem log de consultas**, porque ele gravaria os valores dos parâmetros (dados pessoais ou tokens); as consultas lentas ficam no Performance Insights, normalizadas e sem valores.
  - Backups automáticos com restauração para qualquer ponto no tempo (14 dias em produção, 7 no staging), snapshot final, backups preservados ao apagar e logs exportados para grupos criados antes do banco, com KMS e 365 dias de retenção. Atualização automática de minor, nunca de major.
  - **Produção:** Multi-AZ e proteção contra exclusão, explícitos no ambiente. **Staging:** `db.t4g.micro`, uma zona, sem proteção contra exclusão (só dados fictícios, pendência 7).
- **Testes:** `terraform validate` nos dois ambientes; tflint (inclui a validação das classes de instância); checkov sem falhas, com duas exceções justificadas no código (Multi-AZ e proteção contra exclusão são variáveis: ligadas em produção, desligadas no staging); Trivy limpo.
- **Definição de pronto:** critérios de aceite ✔ (RDS em subnet privada, criptografado, com backups automáticos; sem acesso público; credencial no Secrets Manager) · lint ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Correção (revisor automático do PR #7):** no PostgreSQL 18, `log_connections` virou lista, e o RDS recusa o antigo `"1"` na família `postgres18` (o apply falharia ao criar o grupo de parâmetros). Agora o valor é `receipt,authentication,authorization`, que as notas do RDS para o PostgreSQL 18 dão como equivalente ao antigo `1`. `terraform validate` nos dois ambientes.

## T8.3 Front no S3 + CloudFront

- **Arquivos:** `infra/terraform/modules/frontend/main.tf`, `infra/terraform/modules/private-bucket/main.tf` (declarações extras na bucket policy e saída `regional_domain_name`), `infra/terraform/envs/{staging,production}/main.tf` (provider de us-east-1, domínios como variáveis), `infra/terraform/README.md`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Bucket privado** (`private-bucket`) com chave KMS própria. A bucket policy e a política da chave liberam leitura e decifração **só para esta distribuição** do CloudFront (`AWS:SourceArn`), por Origin Access Control com assinatura sigv4. O bucket não tem nenhum acesso público.
  - **Cabeçalhos de segurança** numa response headers policy, iguais aos do `vite preview` (`apps/web/src/build-guards.ts`): CSP estrita com `connect-src` só para o domínio da API, HSTS de 2 anos com subdomínios e preload, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy` e COOP.
  - **Domínio com TLS:** certificado ACM (us-east-1) no `panel_domain`, só SNI e mínimo TLS 1.2 (`TLSv1.2_2021`), HTTP/2 e HTTP/3, redirecionamento para HTTPS. Com zona no Route53, validação e registros A/AAAA automáticos; sem ela, roteiro manual no README (pendência 4).
  - **SPA:** função do CloudFront que manda as rotas do React Router (sem extensão) para o `index.html`, sem transformar 403/404 do bucket em página.
  - **WAF** (escopo CloudFront): reputação de IP, regras comuns e entradas maliciosas conhecidas (inclui Log4Shell) da AWS, mais limite de 2.000 requisições por IP a cada 5 minutos. O log do WAF omite `authorization` e `cookie`.
  - **Logs** do CloudFront (entrega versão 2) e do WAF no CloudWatch em us-east-1, com chave KMS própria (a chave de logs do ambiente está em sa-east-1) e 365 dias de retenção.
- **Testes:** `terraform validate` nos dois ambientes; tflint limpo; checkov sem falhas (486 aprovados), com exceções justificadas no código (log v2 que o checkov não reconhece, origem única sem failover, sem restrição geográfica e a ligação ao WAF que o grafo do checkov não atravessa entre providers); Trivy limpo.
- **Definição de pronto:** critérios de aceite ✔ (bucket privado servido só pelo CloudFront; CSP, HSTS, `X-Frame-Options` e `Referrer-Policy`; domínio do painel com TLS) · lint ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Pendente:** teste de paridade entre a CSP do CloudFront e a do `build-guards.ts`, quando E6 e E8 estiverem juntos na `main`. O upload do build (com `Cache-Control` sem cache para o `index.html`) e a invalidação ficam no pipeline (T8.5).

## T8.2 API no ECS — parte 1: imagem, papéis de banco e pnpm corrigido ⚠️ altera `.github/`

- **Arquivos:** `apps/api/Dockerfile`, `.dockerignore`, `apps/api/src/cli/db-bootstrap.ts`, `apps/api/test/db-bootstrap.test.ts`, `scripts/test-api-image.sh`, `apps/api/package.json` (`prisma` passa a dependência de produção), `package.json` (pnpm 11.28.10), `pnpm-lock.yaml`, `.github/workflows/ci.yml` (job da imagem), `.github/dependabot.yml` (imagem base da API)
- **Dependências:** nenhuma nova. O `prisma` (mesma versão) vira dependência de produção: a tarefa de migrations roda em produção, e ele já entrava como peer do `@prisma/client`. **pnpm de 11.1.2 para 11.28.10** (última 11.x, 62 h de publicada): a 11.1.2 tem quatro vulnerabilidades altas de instalação (GHSA-vx52-2968-3vc6, GHSA-qrv3-253h-g69c, CVE-2026-82392 e CVE-2026-82393: escrita de arquivo arbitrária e path traversal), achadas pelo Trivy na imagem de build. O lockfile só mudou na linha do `prisma`.
- **Como funciona:**
  - **Imagem** em múltiplos estágios, com contexto controlado por um `.dockerignore` em lista de permissão (`.env`, chaves e `node_modules` locais nunca entram). A instalação respeita a quarentena e a política de confiança do workspace. Base `node:24-alpine` e bundle de CAs do RDS fixados por SHA-256. Alvo `api`: só dependências de produção, usuário `node`, arquivos do root, sem `npm` nem `corepack`, health check. Alvo `migrate`: a mesma imagem mais o schema e o Schema Engine baixado no build, então a migration não depende de internet.
  - **Papéis de banco** (`db-bootstrap`, tarefa avulsa): com a conta mestra do RDS, cria e mantém `verax_migrator` (dono do schema, só para as migrations) e `verax_app` (só SELECT, INSERT, UPDATE e DELETE; sem criar ou alterar objetos, sem ler `_prisma_migrations`, sem UPDATE, DELETE ou TRUNCATE na `AuditLog`). Também revoga `CONNECT` e o acesso ao schema de `PUBLIC`. Senhas vindas das URLs que o Terraform grava; nomes de papel validados (`verax_[a-z0-9_]`) e escapados pelo driver; tudo numa transação; idempotente. O deploy roda o bootstrap antes e depois das migrations. Fecha a pendência do E1 (aplicação sem privilégio de dono).
- **Testes:**
  - `db-bootstrap.test.ts`: 7 testes contra o Postgres de teste, com papéis reais e únicos por execução. A aplicação lê e grava; não cria, altera nem apaga tabelas; não altera nem apaga a auditoria; não lê a tabela de migrations. O papel de migrations cria tabelas, que a aplicação passa a usar. A rotação de senha funciona e a antiga deixa de valer; nome de papel com SQL é recusado. A suíte da API passa inteira (146).
  - `scripts/test-api-image.sh` (local e no CI, job novo "Imagem da API"): numa rede Docker **sem internet**, Postgres 18 com TLS e CA descartável. Sequência do deploy: bootstrap, migrations pelo papel das migrations, bootstrap de novo; as tabelas pertencem ao papel das migrations, e a aplicação não cria tabelas nem apaga a auditoria. A API em produção roda com raiz só leitura, sem capabilities, sem root e com `sslmode=verify-full`: `/health` e `/health/ready` respondem 200; com outra CA, ela não fica pronta. Em produção, a configuração recusa subir sem `verify-full`.
  - Trivy nas duas imagens: nenhuma vulnerabilidade alta ou crítica com correção disponível. Semgrep, ESLint, Prettier, actionlint e zizmor limpos.
- **Pendente nesta task:** a infra do ECS (ALB com TLS, WAF, serviço, tarefas de bootstrap e migrations, segredos) na parte 2.

## T8.2 API no ECS — parte 2: infraestrutura · T8.4 Segredos e permissões

- **Arquivos:** `infra/terraform/modules/api/main.tf`, `infra/terraform/envs/{staging,production}/main.tf`, `infra/terraform/README.md`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Entrada:** ALB público **só HTTPS** (política TLS 1.3/1.2 restrita, `drop_invalid_header_fields`, mitigação de desync no modo mais rígido, proteção contra exclusão), certificado ACM do `api_domain` e nenhuma porta 80, porque o painel sempre chama por HTTPS. Log de acesso num bucket privado, versionado e só TLS; o ALB só entrega em SSE-S3, então este bucket é a exceção documentada ao KMS.
  - **WAF regional** associado ao ALB: reputação de IP, regras comuns (o limite de 8 kB de corpo só conta, porque a API valida 100 kB), entradas maliciosas conhecidas (inclui Log4Shell), SQL injection, **limite de 100 requisições por IP a cada 5 minutos em `/v1/auth/`** (além do limite e do bloqueio por conta da própria API) e limite geral de 1.000. O log omite `authorization` e `cookie`.
  - **Serviço Fargate** em subnet privada, entrada só do ALB, ECS Exec desligado, rollback automático de deploy e health check no contêiner e no target group (`/health`). O contêiner roda com uid 1000, raiz só leitura, `/tmp` como único volume gravável e todas as capabilities removidas. As variáveis de produção satisfazem o schema de configuração do E2: origens `https`, rate limit e verificação de senha vazada ligados, SES e `TRUST_PROXY_HOPS=1`.
  - **Tarefas do deploy:** `db-bootstrap` (imagem da API, conta mestra) e `migrate` (imagem de migrations, papel das migrations), num security group sem internet, só com o banco e os endpoints privados da AWS. O deploy roda bootstrap, migrations e bootstrap de novo (T8.5).
  - **Segredos** (T8.4): `db-url-app`, `db-url-migrator` e `api-auth` (chaves de sessão e de CSRF de 64 caracteres) gerados por recurso efêmero e gravados por write-only, sem passar pelo state; rotação por `secret_version`. Cada um é injetado em tempo de execução só na tarefa que precisa: **um papel de execução por tarefa**, e cada um lê só os próprios segredos (o bootstrap é o único que lê a senha mestra do RDS).
  - **Papéis** (T8.4): a API tem papel próprio (`<nome>-api`), que só envia e-mail pela identidade SES do domínio e assume `*/VeraxControlReadOnly`. Bootstrap e migrations não têm papel de tarefa (não chamam a AWS). Quem assume os papéis dos clientes: a API, o Prowler (T4.7) e o manager do Wazuh (T4.4), todos com nome dentro do prefixo aceito pelo conector. O worker de sincronização (E5) ganha papel próprio quando existir.
  - **Rede cruzada:** o banco aceita conexão só da API e das tarefas do deploy; em produção, o indexer do Wazuh aceita só a API (o que libera a publicação da porta 9200 fora do `127.0.0.1`, T4.8).
  - **E-mail:** identidade SES do domínio do remetente com DKIM de 2048 bits, registros no Route53 ou na saída `ses_dkim_records`.
  - Serviço e tarefas só existem quando o deploy informa os digests das imagens publicadas no ECR (repositórios com tags imutáveis, varredura na publicação e KMS).
- **Testes:** `terraform validate` nos dois ambientes; tflint limpo; checkov com 649 aprovados e 0 falhas, também com as imagens publicadas; Trivy limpo. As exceções estão justificadas no código: ALB público, entrada HTTPS da internet, saída HTTPS da API, SSE-S3 no log do ALB e as ligações que o checkov não acompanha (SG das tarefas no run-task, WAF associado).
- **Definição de pronto (T8.2):** ECS Fargate atrás de load balancer com TLS ✔ · WAF com regras gerenciadas ✔ · migrations no deploy ✔ (tarefas prontas; a orquestração é a T8.5) · health check ✔ · **nada aplicado na AWS** (portão)
- **Definição de pronto (T8.4):** papel próprio por serviço com permissão mínima ✔ (o worker entra com o E5) · só a API e os jobs assumem os papéis dos clientes ✔ · segredos lidos do Secrets Manager em tempo de execução ✔

## T8.5 Pipeline de deploy ⚠️ altera `.github/`

- **Arquivos:** `.github/workflows/{deploy,release}.yml`, `scripts/release.sh`, `infra/terraform/modules/deploy-role/main.tf`, `infra/terraform/bootstrap/main.tf` (provedor OIDC), `infra/terraform/envs/{staging,production}/main.tf`, `infra/terraform/modules/{api,frontend}/main.tf` (saídas; serviço ignora a revisão em uso), `infra/terraform/README.md` ("Ligar o deploy"), `.github/zizmor.yml`, `.github/workflows/security.yml` (versão do zizmor fixada)
- **Dependências:** actions fixadas por SHA e conferidas na release oficial e no GitHub Advisory Database: `aws-actions/configure-aws-credentials` v6.3.0, `actions/attest-build-provenance` v4.2.2, `actions/upload-artifact` v7.0.2 e `actions/download-artifact` v8.0.2 (o alerta conhecido vale só abaixo de 4.1.3). syft 1.55.0 por binário com checksum. O login no ECR é feito pelo AWS CLI do runner, sem action de terceiro.
- **Como funciona:**
  - **Sem chave fixa:** provedor OIDC do GitHub no bootstrap. Cada ambiente tem um papel de deploy que só o environment do GitHub de mesmo nome, neste repositório, assume (`sub` = `repo:…:environment:<ambiente>`), com sessão de 1 hora.
  - **Permissão mínima do deploy:** enviar imagens aos dois repositórios do ambiente; registrar revisões; rodar só as tarefas de bootstrap e migrations neste cluster; atualizar só o serviço da API; passar só os papéis das tarefas para o ECS; ler só os logs das tarefas do deploy; ler a configuração e gravar o registro das imagens publicadas; publicar no bucket do painel (KMS via S3); invalidar só esta distribuição. **Não altera IAM, rede, banco nem segredos**: infraestrutura é Terraform, aplicado por quem administra a conta. Por isso o pipeline não roda o Terraform.
  - **Fluxo** (`deploy.yml`, só com `AWS_DEPLOY_ENABLED=true`): CI, Segurança e IaC de novo como gates; build único das imagens; Trivy (alta com correção bloqueia); SBOM SPDX (artefato por 90 dias); staging; produção depois da aprovação manual do environment. Cada ambiente (`release.yml` + `release.sh`) publica as imagens com tag imutável; registra revisões **clonando a mais recente e trocando só a imagem** (o endurecimento continua o do Terraform); roda bootstrap, migrations e bootstrap, mostrando o log se falhar; atualiza o serviço e confere que não houve rollback; registra os digests; publica o painel (`assets/` com cache imutável, `index.html` sem cache) e invalida o CloudFront; faz o smoke test (`/health` e cabeçalhos de segurança do painel); gera a **attestation de origem** das duas imagens publicadas.
  - **Primeira publicação:** o deploy publica as imagens e para com a instrução de aplicar o Terraform com os digests (as tarefas nascem lá). Ao reaplicar o Terraform depois, usam-se os digests da última versão, registrados no SSM.
- **Testes:** actionlint (com shellcheck) e zizmor 1.31.1 sem achados (a sugestão nova de sintaxe `$/` conflita com o actionlint e fica ignorada só no `deploy.yml`, com motivo); shellcheck do `release.sh`; o filtro que clona a revisão foi testado com uma definição real (descarta os campos que a AWS não aceita de volta, mantém o endurecimento e troca só a imagem). Terraform válido nos três roots; checkov (679 aprovados, 0 falhas) e Trivy limpos. O fluxo na AWS só roda quando o deploy for ligado.
- **Definição de pronto:** deploy com OIDC, sem chave fixa ✔ · aprovação manual para produção ✔ (environment) · SBOM e attestation de origem ✔ · **nada aplicado nem publicado na AWS** (portão)
- **Achado no caminho:** a `zizmor-action` baixava sempre a versão mais recente do zizmor (a action estava fixada, a ferramenta não). Agora a versão é fixa.

## T8.7 Varredura DAST ⚠️ altera `.github/`

- **Arquivos:** `scripts/zap-baseline.sh`, `scripts/test-api-image.sh` (`RUN_ZAP=1`), `.github/workflows/ci.yml` (job da imagem), `.github/workflows/release.yml` (staging)
- **Dependências:** imagem `zaproxy/zap-stable` (ZAP 2.17.0) fixada por digest.
- **Como funciona:** baseline passivo do OWASP ZAP com **bloqueio por risco alto**, lido do relatório JSON (o baseline sozinho não tem esse critério). Médios e baixos aparecem no relatório, guardado como artefato. Roda contra a stack local em todo CI, na rede isolada do teste da imagem, e contra o painel e a API publicados no staging, antes de liberar a produção.
- **Testes:** rodado localmente contra a API em produção (TLS verificado com o banco): 0 alto, 1 médio, 0 baixo.
- **Pendente:** o achado médio 10055 ("CSP: diretiva sem fallback") aparece nas respostas 404 de `/`, `/robots.txt` e `/sitemap.xml`, apesar de a CSP da API definir `frame-ancestors` e `form-action`. A investigar com o código do E2 na `main`, porque o E2 também mexe na configuração HTTP.

## T8.6 Monitoramento e alarmes

- **Arquivos:** `infra/terraform/modules/monitoring/main.tf`, `infra/terraform/modules/{api,database,prowler,wazuh}/main.tf` (saídas; permissão de métrica do Wazuh), `infra/wazuh/scripts/bootstrap-host.sh` (agente do CloudWatch), `infra/terraform/envs/{staging,production}/main.tf`
- **Dependências:** nenhuma nova (agente do CloudWatch do repositório do Amazon Linux 2023).
- **Como funciona:**
  - **Logs centralizados com redaction:** todos os logs (API, tarefas, Wazuh, Prowler, WAF, CloudFront, banco, flow logs) vão para o CloudWatch, cifrados com KMS e com retenção. A aplicação remove segredos antes de registrar (redaction do logger, T1.1); WAF e conector omitem os cabeçalhos de credencial.
  - **Alarmes** num tópico SNS cifrado com chave própria (a política aceita só CloudWatch e EventBridge da conta), com assinatura por e-mail configurável (`alarm_email` no `terraform.tfvars` local, fora do git):
    - API: 5xx da aplicação e do load balancer, alvos reprovando no health check e tarefas abaixo do desejado;
    - banco: CPU acima de 80% e menos de 5 GB livres;
    - Wazuh: **disco de dados acima de 80%** (o indexer fica só leitura a 95%), pela métrica do agente do CloudWatch instalado pelo bootstrap (permissão só no namespace `VeraxControl/Wazuh`), e falha de status da instância;
    - tarefas avulsas que terminam com erro (Prowler, bootstrap e migrations), por evento do ECS;
    - **sincronização parada** e **conta sem evento há horas**: alarmes prontos sobre o contrato de métricas que o worker do E5 vai publicar (namespace `VeraxControl/Sync`, `SyncRuns` e `SilentAccounts`), desligados até o worker existir (`sync_alarms_enabled`).
- **Testes:** `terraform validate` nos dois ambientes; tflint e shellcheck limpos; checkov (711 aprovados em Terraform, 0 falhas) e Trivy limpos.
- **Definição de pronto:** logs centralizados no CloudWatch com redaction ✔ · alarmes de 5xx da API ✔ e de disco do Wazuh ✔ · alarmes de sync parado e conta sem evento ✔ (prontos; ligam com o worker do E5) · **nada aplicado na AWS** (portão)

## Correção nas T4.4 a T4.6: correlações da AWS separadas por conta

- **Achado** (ao preparar a T5.2): um Wazuh atende todos os clientes, e três regras de frequência da AWS no Wazuh 4.14.9 contam eventos de qualquer conta. Confirmado no `wazuh-logtest`: três logins com falha no console numa conta e três noutra disparam a 80255 ("Possible break in attempt"), atribuída à conta do último evento, que sozinha tinha três. Do mesmo jeito, quatro bloqueios do WAF de um IP numa Web ACL e quatro noutra disparam a 80443. Era alerta falso para um cliente, causado por eventos de outro.
- **Arquivos:** `infra/wazuh/config/manager/rules/verax_aws_rules.xml`, `infra/wazuh/scripts/{test-rules,ci-test,deploy}.sh`, `infra/wazuh/scripts/render-manager-config.py`, `infra/wazuh/tests/test_render_manager_config.py`, `infra/wazuh/{docker-compose.yml,README.md}`, `.github/workflows/iac.yml`
- **Dependências:** nenhuma nova.
- **Como funciona:** regras locais com `overwrite="yes"` mantêm as originais e acrescentam `same_field`: `aws.aws_account_id` na 80252 (objetos apagados) e na 80255 (logins com falha), e `aws.webaclId` na 80443 (bloqueios do WAF, cujo ARN traz a conta). O gerador instala o arquivo em `etc/rules/` junto com o `ossec.conf`, em modo 0644, porque o init da imagem copia como root sem preservar o dono e o analysisd lê como `wazuh`. O hash que recria o manager passa a incluir as regras.
- **Verificado no ruleset:**
  - a 80251/80252 está inativa no 4.14.9, porque o `DeleteObjects` não está na lista `aws-eventnames` que a 80202 exige; a sobrescrita vale quando entrar;
  - as correlações genéricas de autenticação (40111 e 40112, por `same_source_ip`) não pegam eventos da AWS, porque o decoder JSON não preenche `srcip`;
  - 80369, 80371 (logs de acesso do S3) e 99021, 99027 (Security Lake) são de fontes que a Verax não coleta.
- **Testes:**
  - `test-rules.sh` (novo, no job do Wazuh do `iac.yml`) sobe um manager avulso e usa o `wazuh-logtest`. Confere que 3 + 3 logins e 4 + 4 bloqueios em contas diferentes não correlacionam, que completar o limite numa conta só dispara com a conta certa e que a 40111 não pega eventos da AWS. Também tem uma guarda de versão: falha se os arquivos da AWS do Wazuh tiverem uma correlação que não está na lista avaliada (para uma atualização do Wazuh pelo Dependabot não reabrir o problema calada).
  - Mutação: sem o arquivo, 6 verificações falham.
  - `ci-test.sh` confere que o manager instalado tem o mesmo arquivo do repositório, que o analysisd carregou as regras e que roda como `wazuh`. Os testes do gerador cobrem a cópia (inclusive sem contas) e o modo 0644.
- **Defesa na API (T5.2):** além disso, a API atribui o alerta pelo bucket de origem cadastrado e não guarda `previous_output` nem `full_log`.

## Correção na T4.1: papel dos flow logs da VPC

- **Achado** (revisor automático do PR #6, conferido na documentação da AWS em "IAM role for publishing flow logs to CloudWatch Logs"): a política mínima do papel inclui `logs:DescribeLogGroups`, que faltava. Sem ela a entrega dos flow logs pode falhar mesmo com o Terraform aplicando sem erro.
- **Arquivo:** `infra/terraform/modules/network/main.tf`
- **Como funciona:**
  - `logs:DescribeLogGroups` entra num bloco separado com recurso `*`, porque a ação não aceita restrição por recurso. Criar, escrever e listar streams continua restrito ao log group dos flow logs.
  - A relação de confiança passa a exigir `aws:SourceAccount` igual à própria conta e `aws:SourceArn` de um flow log desta conta e região. É a proteção contra "confused deputy" que a mesma página recomenda.
- **Testes:** `fmt -check` e `terraform validate` válidos em staging e produção · checkov no módulo: 51 aprovados, 0 falhas (a ação sem recurso é reconhecida como não restringível) · tflint no CI.

## T3.1 Cadastro de clientes

- **Arquivos:** `packages/shared/src/tenants.ts` (+ teste), `apps/api/src/tenants/{tenants.controller,tenants.service,tenants.module}.ts`, `apps/api/src/app.module.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261102174939_tenant_registration/`, `apps/api/src/cli/seed.ts`, `apps/api/test/tenants.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Campos:** nome, CNPJ, plano (texto livre, até 60 caracteres, premissa aprovada), contato de escalonamento (nome, e-mail e telefone opcional) e status.
  - **CNPJ:** valida o formato alfanumérico que a Receita emite desde julho de 2026, que inclui o numérico antigo: 12 caracteres de A a Z ou 0 a 9, mais dois dígitos verificadores pelo módulo 11, com cada caractere valendo o código ASCII menos 48. Aceita com ou sem máscara, guarda só os 14 caracteres em maiúsculas, e é único (409 se repetido).
  - **Rotas** (só `admin_verax`, permissões `tenants:read` e `tenants:write`): `GET /v1/tenants` (resumo `id`, `name`, `status`, no contrato que o seletor do painel já valida, com filtro por status), `GET /v1/tenants/:id` (cadastro completo), `POST`, `PATCH` (parcial, com reativação por `status`) e `DELETE`, que é exclusão lógica.
  - **Desativar** derruba na hora as sessões dos usuários do cliente e limpa a seleção de `admin_verax` que estavam nele.
  - **Auditoria:** criação, alteração, desativação e reativação entram na trilha do próprio cliente, com estado anterior e novo.
  - No banco, CNPJ, plano e contato ficam opcionais só por causa dos clientes criados antes do cadastro completo; a API exige todos. O seed passou a criar os clientes de demonstração com cadastro completo e CNPJs fictícios válidos.
- **Testes:** 17 de integração. Cobrem os três papéis de cliente recebendo 403 em todas as rotas sem alterar nada; criação com CNPJ normalizado e auditoria na trilha do novo cliente; CNPJ repetido com 409; recusa de CNPJ inválido, `status` ou campo desconhecido no corpo, contato ausente e plano longo; listagem no contrato estrito do seletor; filtro por status; 404 e 400; alteração parcial auditada; alteração vazia recusada; desativação com sessões derrubadas, seleção limpa e reativação auditada; troca para CNPJ já usado. No pacote compartilhado, 17 testes do CNPJ e do schema. Mutação: sem derrubar as sessões, 1 falha; com permissão errada na listagem, 3 falham.
- **Definição de pronto:** critérios de aceite ✔ (campos, só `admin_verax` cria, edita e desativa, exclusão lógica, testes de permissão) · lint e tipos ✔ · dependências n/a · regras de segurança ✔
- **Correção (revisor automático do PR #10):** o telefone aceitava 21 caracteres, e a coluna tem 20, o que daria erro 500 em vez de 400. O schema agora limita a 20; teste novo.

## T3.2 Usuários do cliente

- **Arquivos:** `packages/shared/src/users.ts`, `apps/api/src/users/{users.controller,users.service,users.module}.ts`, `apps/api/src/app.module.ts`, `apps/api/test/users.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - Tudo pelo escopo da sessão: `admin_cliente` gerencia o próprio cliente; `admin_verax`, o cliente selecionado (sem seleção, 409 `TENANT_REQUIRED`). `analista_cliente` e `leitura` não têm acesso (`users:*` é só de administradores).
  - **Rotas:** `GET /v1/users` (com filtro por status) e `GET /v1/users/:id`; `POST /v1/users` convida pelo `InvitationService` da T2.6, com o cliente vindo da sessão; `PATCH /v1/users/:id` troca o papel e (re)ativa; `DELETE` desativa (exclusão lógica); `POST /:id/invitation` reenvia o convite; `POST /:id/mfa-reset` redefine o MFA.
  - Só papéis de cliente são atribuíveis (`admin_verax` é recusado no schema). **Ninguém altera o próprio papel, status ou MFA** (403). Convidado não vira ativo por aqui: só ao definir a senha pelo link.
  - Desativar, e também redefinir o MFA, derruba as sessões do usuário na hora (pendência da revisão do E2).
  - **Redefinir o MFA** (a ação do administrador para quem perdeu o autenticador, que estava em aberto) apaga o TOTP e os códigos de recuperação. No próximo login, com a senha, o usuário só alcança o cadastro de um autenticador novo.
  - Auditoria de convite, reenvio, troca de papel, desativação e redefinição de MFA, na trilha do cliente.
  - E-mail já cadastrado responde 409. O e-mail é único na plataforma, então um administrador de cliente consegue saber que um endereço já tem conta (sem saber em qual cliente). É o custo do e-mail único; a alternativa seria aceitar o convite em silêncio e não entregá-lo.
- **Testes:** 20 de integração. Cobrem a suíte negativa A→B completa; os papéis sem acesso; `admin_verax` com e sem cliente selecionado; a listagem só do próprio cliente e no contrato do pacote compartilhado; convite com cliente da sessão, link enviado e auditoria; recusa de papel `admin_verax`, `tenantId` e `status` no corpo; e-mail repetido; reenvio só para convidado; troca de papel auditada; nenhuma alteração do próprio acesso; desativação com sessões derrubadas e reativação; convidado não ativado à força; e a redefinição de MFA com sessões derrubadas e novo login exigindo o cadastro. Mutação: sem a trava do próprio acesso, 4 falham; sem derrubar as sessões, 1; sem apagar o TOTP, 1.
- **Definição de pronto:** critérios de aceite ✔ (listar, convidar, alterar papel e desativar; `admin_cliente` só no próprio cliente; ninguém altera o próprio papel; teste negativo entre clientes) · lint e tipos ✔ · regras de segurança ✔
- **Risco:** o convite cria o usuário pelo Better Auth, fora da transação da requisição. Se a gravação da auditoria falhar depois, o convidado continua criado e a tentativa fica registrada como falha.

## T3.3 Contas cloud

- **Arquivos:** `packages/shared/src/cloud-accounts.ts` (+ teste), `apps/api/src/cloud-accounts/{cloud-accounts.controller,cloud-accounts.service,cloud-accounts.module}.ts`, `apps/api/src/app.module.ts`, `apps/api/src/common/prisma/tenant-scope.ts` (`cloudAccount` na lista protegida), `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261102180302_cloud_accounts/`, `apps/api/test/cloud-accounts.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Campos:** provedor (`aws`), ID da conta (12 dígitos), regiões, status e os buckets de log por fonte (CloudTrail, GuardDuty e WAF), que a T5.2 usa para vincular cada alerta ao cliente.
  - **Papel de leitura:** o ARN é derivado do ID (`arn:aws:iam::<conta>:role/VeraxControlReadOnly`), porque o template do conector (T4.3) cria sempre esse papel e o inventário (T5.9) assume isso. O cadastro não escolhe papel; é o desvio em relação ao campo "ARN do papel" do plano.
  - **ExternalId:** 256 bits do CSPRNG em base64url, gerado na criação. Nunca é aceito do request (o schema é estrito e recusa `externalId`, chaves de acesso, `roleArn` e `tenantId`). Só quem configura o conector (`cloud_accounts:write`) o vê nas respostas, e ele não vai para a auditoria.
  - **Unicidade:** um ID de conta não pertence a dois clientes (índice único, 409). Um bucket de log também é de um cliente só; contas do mesmo cliente podem dividir um bucket. A checagem de bucket roda sob um lock transacional por bucket (`pg_advisory_xact_lock`), então dois cadastros simultâneos não passam juntos, e a resposta não diz de quem é o bucket.
  - **Validação:** regiões no formato da AWS (inclusive GovCloud e ISO), sem repetição, conferidas por partes, sem regex aninhada; nomes de bucket pelas regras do S3; o bucket do WAF precisa do prefixo `aws-waf-logs-` (exigência da AWS).
  - **Rotas:** `GET` (todos os papéis), `POST`, `PATCH` (regiões, buckets e status; `null` apaga um bucket; o ID da conta não muda) e `DELETE` (exclusão lógica), pelo escopo da sessão e com auditoria.
- **Testes:** 21 de integração. Cobrem a suíte negativa A→B; ExternalId gerado, papel derivado e auditoria sem o ExternalId; recusa de ExternalId, chave de acesso, papel escolhido, cliente, ID curto, região inválida ou repetida e bucket inválido; ID de conta em dois clientes; bucket dividido no mesmo cliente e recusado em outro; dois clientes registrando o mesmo bucket ao mesmo tempo (só um consegue); `leitura` vendo a conta sem o ExternalId e sem poder alterar; alteração com `null`; ID imutável; desativação auditada. No pacote compartilhado, 17 testes de região, papel e bucket. Mutação: sem a trava de bucket, 2 falham; mostrando o ExternalId a todos, 1 falha.
- **Definição de pronto:** critérios de aceite ✔ (campos, ExternalId gerado pelo sistema e nunca aceito do request, nenhuma chave de acesso armazenada, ID de conta único entre clientes) · lint e tipos ✔ · regras de segurança ✔
- **Para o E5:** a lista de alvos do Prowler no SSM (T4.7) passa a ser mantida a partir destas contas, por um job, na integração da T5.8.
- **Correção (revisor automático do PR #10):** a trava de bucket conferia só a mesma fonte, então o mesmo bucket podia ser CloudTrail de um cliente e GuardDuty de outro. Como o nome de bucket é único no S3, a checagem e o lock passam a valer para o nome em qualquer fonte. Teste novo; mutação: conferindo uma coluna só, ele falha.

## T3.4 Lista de proteção

- **Arquivos:** `packages/shared/src/protected-resources.ts`, `apps/api/src/protected-resources/{protected-resources.controller,protected-resources.service,protected-resources.module}.ts`, `apps/api/src/app.module.ts`, `apps/api/src/common/prisma/tenant-scope.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261102181028_protection_and_exceptions/` (junto com a T3.5), `apps/api/test/protected-resources.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Itens:** tipo, identificador, motivo e quem incluiu. O autor vem sempre da sessão.
  - **Tipos:** conta AWS, usuário e papel de IAM (nome ou ARN do tipo certo), chave de acesso, instância EC2, bucket S3, security group e IP ou faixa CIDR. Cada identificador é conferido no formato da AWS, para a comparação com os achados (T5.6, +15 na nota de risco) ser exata.
  - Um item não se repete no mesmo cliente (409). Só o motivo muda; outro identificador é outro item.
  - **Rotas:** `GET`, `GET :id`, `POST`, `PATCH` e `DELETE`, pelo escopo da sessão. Todos leem; administradores alteram. Toda alteração é auditada, e a remoção guarda o item inteiro como estado anterior.
- **Testes:** 21 de integração. Cobrem a suíte negativa A→B; inclusão com o autor da sessão, auditada; item repetido; recusa de formato errado por tipo, de autor no corpo e de caractere de controle no motivo; aceite de cada tipo no formato da AWS; alteração e remoção auditadas; identificador imutável; analista sem permissão de escrita. Mutação: sem a conferência do formato, 4 falham.
- **Definição de pronto:** critérios de aceite ✔ (tipo, identificador, motivo e quem incluiu; escopo por cliente; todas as alterações auditadas) · lint e tipos ✔ · Semgrep sem achados nos arquivos novos

## T3.5 Exceções de alerta

- **Arquivos:** `packages/shared/src/alert-exceptions.ts`, `apps/api/src/alert-exceptions/{alert-exceptions.controller,alert-exceptions.service,alert-exceptions.module}.ts`, `apps/api/src/app.module.ts`, `apps/api/src/common/prisma/tenant-scope.ts`, `apps/api/prisma/schema.prisma`, migration da T3.4, `apps/api/test/alert-exceptions.test.ts`
- **Dependências:** nenhuma nova.
- **Como funciona:**
  - **Campos:** regra do Wazuh (até 6 dígitos), condição (usuário, IP ou faixa CIDR, ou recurso, com o valor), motivo e validade opcional. O autor vem da sessão.
  - **Validade:** precisa estar no futuro e, no máximo, a um ano. Sem ela, a exceção vale até ser removida.
  - **Uso pelo sync (T5.3):** `matchedCount` e `lastMatchedAt` são atualizados pelo sync quando a exceção marca um achado como esperado. Os dois nunca vêm do request.
  - Vencida, a exceção para de valer, mas continua listada como inativa, com filtro `active`. Uma mesma combinação de regra, campo e valor não se repete no cliente.
  - **Rotas:** `GET`, `GET :id`, `POST`, `PATCH` (motivo e validade; regra, campo e valor definem a exceção) e `DELETE`. Todos leem; operadores (administradores e analistas) alteram. Tudo auditado.
- **Testes:** 14 de integração. Cobrem a suíte negativa A→B; criação pelo analista com o autor da sessão, auditada; exceção repetida; recusa de regra não numérica, IP inválido, validade no passado ou acima de um ano, contagem e autor no corpo; exceção vencida listada como inativa e filtro; alteração e remoção auditadas; leitura sem permissão de escrita. Mutação: com "ativa" sempre verdadeiro, 1 falha.
- **Definição de pronto:** critérios de aceite ✔ (campos, escopo por cliente, todas as alterações auditadas; uso pelo sync na integração da T5.3) · lint e tipos ✔ · Semgrep sem achados nos arquivos novos
- **Desvio:** as tabelas da T3.4 e da T3.5 entraram numa migration só, e as duas tasks foram para o mesmo commit.

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

## T6.1 Setup do front

- **Arquivos:** `apps/web/vite.config.ts`, `apps/web/src/build-guards.ts` (+ teste), `apps/web/src/lib/{env,api-client,api,query-client,errors}.ts` (+ testes), `apps/web/src/routes/router.tsx`, `apps/web/src/pages/{login,forbidden,not-found}-page.tsx`, `apps/web/src/{App,main}.tsx`, `apps/web/src/index.css`, `apps/web/tsconfig*.json`, `apps/web/package.json`, `scripts/scan-bundle.mjs`
- **Dependências:** react-router 8.5.1, @tanstack/react-query 5.105.0, radix-ui 1.8.1, class-variance-authority 0.7.1, clsx 2.1.1, tailwind-merge 3.7.0, lucide-react 1.66.0, zod 4.6.7; dev: tailwindcss e @tailwindcss/vite 4.3.3, msw 3.0.3, @testing-library/user-event 14.6.8 (todas aprovadas)
- **Como ficou:**
  - Tailwind 4 pelo plugin do Vite, React Router no modo data, TanStack Query (sem nova tentativa em erro 4xx).
  - Cliente HTTP: sempre `credentials: 'include'`; em toda escrita (exceto as rotas de autenticação, que têm checagem de origem própria) busca o token CSRF da sessão uma vez, manda em `X-CSRF-Token` e renova uma vez se a API recusar. Toda resposta com corpo é validada por schema zod antes de chegar à tela. 401 leva ao login (limpando o cache), 403 `MFA_REQUIRED` leva ao cadastro do MFA, e os demais erros chegam como mensagem em português (sem detalhe técnico) com o `requestId` para o suporte.
  - **Única variável de ambiente:** `VITE_API_URL`. O build falha se existir qualquer outra `VITE_*` (que iria para o JavaScript público), sem mostrar o valor.
  - **Varredura do bundle:** todo build do painel (inclusive no CI) procura no `dist/` IDs de chave AWS, chave privada, URL com senha, tokens do GitHub/Slack e nomes de variáveis secretas; acha, falha.
  - CSP estrita sem `unsafe-inline`/`unsafe-eval` (`script-src` e `style-src` só `self`, `connect-src` só a API, `frame-ancestors none`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (os links de convite também não vazam por `Referer`), `Permissions-Policy` e COOP. A mesma política no `vite preview` (testes e2e) e no CloudFront (E8). Sem sourcemap público.
  - Rotas iniciais: login (a tela completa entra na T6.5), sem permissão e página não encontrada.
- **Testes:** 22 no front. Cliente HTTP (cookie, validação da resposta, CSRF buscado uma vez e renovado uma vez, rotas de auth sem CSRF, 401, `MFA_REQUIRED`, erros com status/código/requestId/problemas, 204), mensagens de erro, trava de `VITE_*`, CSP e rotas.
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔
- **Teste manual:** `vite build` com `VITE_SECRET=x` falha citando só o nome; o build normal passa na varredura; um bundle falso com URL com senha e chave AWS falha a varredura; `vite preview` serve a CSP e os demais headers.

## T6.2 Tema e tokens visuais

- **Arquivos:** `apps/web/src/index.css`, `apps/web/public/theme-init.js`, `apps/web/index.html`, `apps/web/src/design/{theme,severity}.ts` (+ teste), `apps/web/src/components/{theme-toggle,ui/button,ui/button-variants,ui/card}.tsx`, `apps/web/src/lib/cn.ts`, `apps/web/src/pages/catalog/catalog-page.tsx`, `apps/web/src/routes/router.tsx`, `apps/web/src/test/setup.ts`, `eslint.config.js`
- **Dependências:** nenhuma nova
- **Cores de severidade** (validadas com o script da skill de visualização, não no olho):

  | Severidade | Claro     | Escuro    | Ícone           |
  | ---------- | --------- | --------- | --------------- |
  | Crítico    | `#b42318` | `#d32f2f` | octógono        |
  | Alto       | `#e8743b` | `#fb9b4f` | triângulo       |
  | Médio      | `#f7c948` | `#ffe07a` | círculo com `!` |
  | Baixo      | `#2a78d6` | `#3987e5` | círculo com `i` |
  | Ok         | `#0e9f8e` | `#0e9f8e` | círculo com ✓   |
  - A paleta de status de referência falhou no par **alto × médio** (ΔE 13,6, abaixo do piso de 15 até para visão normal) e no par **ok × vermelho/laranja para daltonismo** (ΔE 4,2–5,7). A escolhida separa crítico, alto e médio também por claro/escuro (mais grave, mais escuro) e desloca o "ok" para verde-azulado: em todos os pares e nos dois modos, separação para daltonismo ≥ 10,6 e para visão normal ≥ 16,3; no escuro, contraste ≥ 3:1.
  - Fica abaixo de 3:1 contra o fundo claro: alto e médio. Por isso severidade **nunca aparece só como cor**: sempre com ícone de forma própria e rótulo, e o texto usa a tinta neutra (nunca a cor da severidade). A checagem de "faixa de luminosidade" do script é para paletas categóricas; em severidade, a variação de claro/escuro é intencional.
  - A ação principal usa tinta neutra, não azul, para não competir com "baixo".

- **Tema:** tokens por papel (fundo, superfície, tintas, borda, grade, foco), modos claro e escuro escolhidos à mão; padrão segue o sistema, com escolha manual guardada no navegador. O tema é aplicado antes da primeira pintura por um script externo (a CSP não aceita script inline). Foco visível em todo elemento interativo e respeito a `prefers-reduced-motion`.
- **Catálogo** (`/catalogo`): severidade, tokens de base, escala tipográfica (fonte do sistema), espaçamento e botões. Só existe no build de desenvolvimento: a rota é removida do build de produção (conferido no `dist/`).
- **Componentes base** no padrão shadcn/ui (`Button` com variações, `Card`), escritos no repositório sobre `radix-ui`.
- **Testes:** 27 no front. Ícone e rótulo distintos por severidade, ordenação, tema seguindo o sistema e escolha manual persistida, conteúdo do catálogo.
- **Definição de pronto:** critérios de aceite ✔ (cores semânticas, modos claro e escuro, tipografia e espaçamento padronizados, catálogo) · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔
- **Teste manual:** build de produção sem o catálogo (sem a rota e sem o texto no JavaScript final); inspeção visual dos dois modos fica com o Playwright na T6.3.

## T6.3 Componentes de segurança

- **Arquivos:** `apps/web/src/components/security/{semaphore,severity-badge,score-meter,decision-card,timeline}.tsx`, `apps/web/src/components/{data-table,states}.tsx`, `apps/web/src/design/score.ts`, `apps/web/src/lib/format.ts`, `apps/web/src/pages/catalog/{components-showcase,catalog-section}.tsx`, testes `apps/web/src/components/components.test.tsx` e `apps/web/e2e/catalog.spec.ts`, `apps/web/playwright.config.ts`, `apps/web/e2e/tsconfig.json`
- **Dependências:** @playwright/test 1.64.1 e @axe-core/playwright 4.14.0 (dev, aprovadas)
- **Componentes:**
  - **Semáforo:** a posição da luz acesa (em cima, no meio, embaixo), o ícone e o rótulo (Crítico, Atenção, Normal) dizem o estado; nome acessível com o motivo.
  - **Selo de severidade:** ícone de forma própria + rótulo, tinta neutra.
  - **Medidor de nota 0–100:** pelo guia de visualização, "um valor contra um limite" é um **medidor em barra**, não um gauge circular (desvio do nome "ScoreGauge" do plano). O preenchimento carrega a severidade (atenção abaixo de 70, crítico abaixo de 40, limites configuráveis) e o trilho é um tom mais claro da mesma cor; número grande com rótulo e ícone; `role="meter"` com o estado por extenso.
  - **Card de decisão:** severidade, título, descrição, contexto, ação principal e secundária; desabilitado enquanto a ação roda.
  - **Tabela:** paginação e filtros feitos na API (a tabela só mostra a página recebida e avisa as mudanças), faixa "11–20 de 35", navegação desabilitada nas pontas, legenda acessível, números tabulares, estados vazio/carregando/erro embutidos.
  - **Linha do tempo:** data/hora em pt-BR, título, descrição, origem, e a severidade também em texto para leitor de tela.
  - **Estados:** vazio (com motivo e ação), carregando (esqueleto anunciado), erro (mensagem sem detalhe técnico, código para o suporte e "tentar de novo").
  - Todos no catálogo, com dados fictícios.
- **Testes:** 46 no front e 2 de navegador. O **axe** (WCAG 2.2 AA) roda o catálogo inteiro nos dois temas com zero violações, e uma captura de cada tema foi inspecionada a olho (sem sobreposição de rótulos, luz acesa do semáforo destacada nos dois modos, trilho do medidor visível).
- **Achados corrigidos durante os testes:**
  - O `id` das seções do catálogo tinha espaços, e o `aria-labelledby` quebrava (seção sem nome acessível); agora usa `useId()`.
  - O token de texto discreto (#898781) dava 3,49:1 no tema claro (o axe acusou 8 casos); passou para #6e6c66 (≥ 4,98:1 em todas as superfícies claras) e, no escuro, para #9a9890 (≥ 5,52:1).
- **Definição de pronto:** critérios de aceite ✔ · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔
- **Pendente:** o job de testes de navegador no CI entra junto com os fluxos de ponta a ponta da T6.5.

## T6.4 Estrutura e navegação

- **Arquivos:** `packages/shared/src/session.ts` (contrato de `/v1/me` e do resumo de cliente), `apps/web/src/features/session/session.ts`, `apps/web/src/layout/{app-layout,navigation,tenant-switcher}.tsx`, `apps/web/src/routes/{router,guards}.tsx`, `apps/web/src/pages/placeholder-page.tsx`, `apps/web/src/mocks/{fixtures,handlers,enable}.ts`, `apps/web/src/main.tsx`, `apps/web/vite.config.ts`, `apps/web/playwright.config.ts`, testes `apps/web/src/layout/layout.test.tsx`, `apps/web/e2e/layout.mock.spec.ts` e o teste de contrato em `apps/api/test/permissions.test.ts`, `README.md`
- **Dependências:** nenhuma nova (msw já aprovado)
- **Como ficou:**
  - Layout com menu lateral (Operação: Torre, Incidentes, Achados, Postura, Ativos; Administração: Clientes, Usuários, Auditoria) e cabeçalho com usuário, papel, tema e "Sair".
  - Cada item do menu e cada rota declaram a permissão que a API exige para os dados; sem ela, o item some e a rota leva a "Sem permissão". É só experiência de uso: a API decide sempre.
  - Sem sessão, qualquer rota interna leva ao login; sessão sem MFA vai para o cadastro do MFA (tela na T6.5).
  - **Seletor de cliente só para `admin_verax`:** lista só clientes ativos, troca pela API (`POST /v1/session/tenant`, com token CSRF), vale só para a sessão e descarta todo o cache (os dados passam a ser de outro cliente).
  - **Contrato compartilhado:** `meSchema` e `tenantSummarySchema` em `packages/shared`. Um teste novo na API confere que o `/v1/me` real segue o contrato nos 4 papéis.
  - **Modo `dev:mock`:** o painel roda sem a API, com o Mock Service Worker servindo os mesmos endpoints com dados fictícios validados pelos schemas do `shared` (nenhum cliente real). O papel do usuário fictício sai de `localStorage['verax.mock.role']`. O plugin e o worker só existem nesse modo: o build de produção não tem nada do MSW (conferido no `dist/`).
- **Testes:** 57 no front e 4 de navegador. Unidade (sobre `msw/node`): login sem sessão, MFA pendente, rota sem permissão, menu exato por papel, cabeçalho, seletor só para `admin_verax`, troca de cliente com CSRF e lista só de ativos, "Sair". Navegador (modo mock): menu e troca de cliente do `admin_verax`, menu e bloqueio do `leitura`, axe sem violações no layout. Captura de tela inspecionada.
- **Definição de pronto:** critérios de aceite ✔ (layout com menu e cabeçalho com cliente e usuário, seletor só para `admin_verax`, rotas por papel só como UX, dados fictícios tipados do `shared`) · testes ✔ · lint e tipos ✔ · dependências n/a · regras de segurança ✔
- **Observação:** a lista de clientes do seletor usa `GET /v1/tenants`, que nasce na T3.1 (no modo mock, já existe com o contrato combinado).

## T6.5 Telas de autenticação

- **Arquivos:** `apps/web/src/pages/{login,mfa-verify,mfa-enroll,forgot-password,set-password}-page.tsx`, `apps/web/src/features/auth/{auth-api,auth-shell}.ts(x)`, `apps/web/src/components/ui/field.tsx`, `apps/web/src/lib/api-client.ts`, `apps/web/src/routes/router.tsx`, `apps/web/src/mocks/auth-handlers.ts`, testes `apps/web/src/pages/auth-pages.test.tsx`, e2e `apps/web/e2e/fullstack/*` com `apps/web/playwright.fullstack.config.ts`, `apps/api/src/cli/e2e-fixtures.ts`, `.github/workflows/ci.yml` (job "Testes de navegador"), `.github/rulesets/main.json`, `.gitignore`
- **Dependências:** react-qr-code 2.2.0 (aprovada; QR gerado no navegador). O plano previa otplib para os códigos TOTP do e2e; usei o gerador RFC 6238 que já existia nos testes da API, sem dependência nova.
- **Telas:**
  - **Login:** e-mail e senha; com MFA, vai para o código; sem MFA cadastrado, vai para o cadastro. Senha errada, e-mail inexistente e usuário desativado recebem a mesma mensagem ("E-mail ou senha incorretos."); conta bloqueada recebe "Muitas tentativas…", sem confirmar que a conta existe. O destino depois do login aceita só caminho interno (sem redirecionamento aberto).
  - **Código:** 6 dígitos do aplicativo ou um código de recuperação.
  - **Cadastro do MFA:** senha, QR gerado no navegador (o segredo nunca passa por serviço externo), chave para digitação manual, 10 códigos de recuperação com copiar e baixar, confirmação "guardei os códigos" e o primeiro código.
  - **Esqueci a senha:** mesma mensagem para qualquer e-mail (inclusive quando a API recusa por outro motivo que não limite ou falha).
  - **Redefinição e convite:** o token sai do fragmento da URL, é apagado da barra de endereço na hora, nunca vai para servidor; checa tamanho mínimo e confirmação antes de enviar; mensagens para link inválido/expirado e senha vazada.
- **Cliente HTTP:** 401 nas rotas de autenticação (senha ou código errados) não é tratado como sessão expirada.
- **Testes:**
  - 77 no front (19 novos das telas, sobre os mesmos handlers do modo mock).
  - **E2E de ponta a ponta (novo):** o painel compilado, servido com a CSP de produção, contra a API compilada e o PostgreSQL de teste. Os dados vêm de um script da API que se recusa a rodar fora de um banco `_test`. Cobre: primeiro acesso com cadastro de MFA obrigatório, logout que invalida a sessão, login com senha + código, axe sem violações no login, mesma mensagem para e-mail desconhecido e senha errada, bloqueio após 5 erros, redefinição pelo link do e-mail (token fora da barra de endereço, senha antiga recusada, senha nova aceita) e papel `leitura` bloqueado na tela e na API. Nenhuma violação de CSP no console.
  - **CI:** novo job "Testes de navegador" (Playwright + Chromium) roda o catálogo, o modo mock e o e2e de ponta a ponta com PostgreSQL. Ele entra como check obrigatório no `.github/rulesets/main.json`; o ruleset vivo só será atualizado depois do merge deste épico, senão o PR do E2 ficaria esperando um check que ele não tem.
- **Definição de pronto:** critérios de aceite ✔ (login, cadastro e verificação de MFA, códigos de recuperação, redefinição e aceite de convite, mensagens que não revelam se o e-mail existe) · testes ✔ · lint e tipos ✔ · dependências aprovadas ✔ · regras de segurança ✔
- **Observação de ambiente:** no Windows, com a suíte da API em paralelo e logo depois de várias rodadas do Playwright, um processo do Vitest caiu uma vez com encerramento forçado nativo (0xC0000409). Não é falha de teste: o mesmo arquivo passa isolado 6 em 6 vezes, a suíte inteira passa 3 em 3, e no CI (Linux) nunca ocorreu. A limitação a 4 workers continua.

## Nova arquitetura de implantação: diagnóstico somente leitura (passo 1)

- **Decisão (02/11/2026):** a plataforma central na AWS do E8 sai, por custo. Entra um **nó por implantação**: uma VM com Wazuh, API, banco, Prowler e túnel do Cloudflare. Ele pode rodar na conta do cliente ou numa conta da Verax e lê os dados sempre pela API, com papel de leitura e ExternalId. O painel vai para o Firebase Hosting na GCP. Detalhes, garantias e ordem de execução em `docs/ARQUITETURA.md`.
- **Achado:** o coletor de CloudWatch Logs do Wazuh 4.14.9 tem a opção `remove_log_streams`, que chama `delete_log_stream` depois de ler (conferido no código da imagem). Na nova arquitetura ela fica desligada de forma explícita, e o papel de leitura não tem ação de exclusão. O WAF aceita um só destino de log por Web ACL (documentação da AWS): ligar o log pelo conector substituiria o destino do cliente, então essa opção sai do conector.
- **Arquivos:** `infra/diagnostico/{diagnostico_aws.py,README.md,tests/test_diagnostico.py}`, `docs/ARQUITETURA.md`, `.github/workflows/iac.yml`
- **Como funciona:**
  - Script Python para o AWS CloudShell da conta monitorada, sem instalar nada. Lista as trilhas do CloudTrail, GuardDuty, Security Hub, Inspector, Access Analyzer, as Web ACLs do WAF e o destino de log de cada uma, os VPC Flow Logs, os grupos do CloudWatch Logs (retenção, volume e subscription filters) e os limites de leitura da conta, e diz se a conta está numa organização.
  - **Só leitura por construção:** `ReadOnlyClient` recusa qualquer operação que não comece com `get_`, `list_`, `describe_` ou `batch_get_` (inclusive paginadores do boto3, que escapariam do controle). No máximo 4 chamadas por segundo, e nenhum conteúdo de log é lido.
  - O resumo aponta o que não pode ser alterado: Web ACL que já envia log, GuardDuty que já exporta e grupos já no limite de subscription filters.
- **Testes:** 8, sem boto3 (clientes falsos): todas as chamadas de um diagnóstico completo são de leitura; escrita e paginador recusados sem chegar ao cliente da AWS; intervalo mínimo; paginação; falha de permissão vira registro; avisos e resumo. Os nomes de parâmetros de entrada foram conferidos contra os esqueletos do AWS CLI. No CI, no job do CloudFormation.

## Diagnóstico replicável para qualquer cliente

- **Motivo:** o diagnóstico precisa ser enviado e lido para qualquer cliente sem depender de quem o criou.
- **Arquivos:** `infra/diagnostico/{diagnostico_aws.py,GUIA-CLIENTE.md,README.md,tests/test_diagnostico.py}`, `.github/workflows/diagnostico-release.yml`, `docs/runbooks/onboarding-cliente.md`, `docs/ARQUITETURA.md` (logs do Cloudflare)
- **Como funciona:**
  - **Relatório legível:** o script gera também `diagnostico-verax-<conta>.md`, com visão geral, fontes sugeridas, pontos de atenção (o que não pode ser alterado), limites de leitura e próximos passos.
  - **Fontes sugeridas:** o JSON ganha `fontes_sugeridas`, que a configuração do nó vai usar. A classificação é `sim`, `avaliar` ou `não`:
    - `sim`: CloudTrail, WAF, findings exportados do GuardDuty e Inspector;
    - `avaliar`: VPC Flow Logs, banco, DNS, Security Hub e logs de aplicação;
    - `não`: métricas de desempenho.
  - Cada fonte traz o volume estimado por dia (armazenado dividido pela retenção).
  - Leituras novas: o destino de exportação do GuardDuty e os logs de consulta DNS do Route 53.
  - **Versão e distribuição:** a constante `VERSION` aparece no relatório e em `--versao`. A tag `diagnostico-vX.Y.Z` dispara o workflow, que roda os testes, confere que a tag bate com a versão e publica a release. A release leva o script, o guia do cliente (com a versão já nos comandos), o `SHA256SUMS` e o atestado de procedência. O cliente confere o checksum no próprio CloudShell.
  - **Roteiro interno** de onboarding: enviar o guia, receber e guardar os arquivos fora do git, ler o relatório, reunião de definição (fontes, região, quem hospeda, escalonamento e baseline de rede) e as próximas etapas.
- **Testes:** 17 (8 novos):
  - classificação das fontes;
  - cada grupo aparece uma vez;
  - volume pela retenção;
  - relatório em Markdown;
  - célula que não quebra a tabela;
  - avisos sem duplicata.

  Também conferi a compatibilidade das f-strings com o Python 3.9 do CloudShell e passei o actionlint no workflow.

## Publicação do painel no Firebase Hosting ⚠️ altera `.github/`

- **Decisões (02/11/2026):**
  - projeto novo na GCP, `verax-control-prod`, na organização da Verax, isolado do Verax OS;
  - destinos:
    - `control.veraxsistemas.com.br`: demonstração comercial;
    - `verax.control.veraxsistemas.com.br`: SOC da própria Verax, com fontes da GCP e do Cloudflare;
    - `<cliente>.control.veraxsistemas.com.br`: um por cliente.
  - subdomínio com o nome do cliente: o responsável aceitou que a relação fique pública nos certificados.
- **Arquivos:** `apps/web/src/hosting.ts` (+ teste), `apps/web/src/components/demo-banner.tsx` (+ teste), `apps/web/src/App.tsx`, `apps/web/vite.config.ts`, `apps/web/package.json` (`build:demo`), `scripts/firebase-hosting-deploy.mjs`, `.github/workflows/painel.yml`, `docs/runbooks/painel.md`, `docs/ARQUITETURA.md`, `.gitignore`
- **Dependências:** nenhuma npm nova. Action `google-github-actions/auth` v3.0.0, fixada pelo commit `7c6bc770` (sem alertas de segurança publicados).
- **Como funciona:**
  - **Publicação sem `firebase-tools`:** pela API REST do Firebase Hosting (versão, hashes, envio só do que mudou, finalização e release).
  - **Configuração do site:** os cabeçalhos (CSP, HSTS, anti-iframe, Permissions-Policy, COOP) e o cache vêm de `firebaseHostingConfig`, que usa os mesmos `securityHeaders` do preview dos testes e2e. O build grava `dist-hosting.json`, fora do `dist`.
  - **Demonstração:** é o build no modo `mock`. O MSW simula a API no navegador, com a "API" na própria origem do site, então a CSP só permite essa origem. Uma faixa avisa, em toda tela, que os dados são fictícios. Os builds normais não levam o MSW (conferido).
  - **Login na GCP:** sem chave. A conta `painel-deployer` só aceita o subject imutável do GitHub (`repo:williandotdev@92734416/verax-control@1441377752:environment:painel`, com os IDs numéricos do dono e do repositório) e só tem `firebasehosting.admin` no projeto novo.
  - **Lista de sites:** fica em variável do environment, fora do código. Sem ela, o job não roda.
- **Testes:** 6 do web (configuração do Hosting e faixa da demo). Builds de demo e normal conferidos (CSP e presença do MSW). actionlint limpo.
- **Publicado (02/11/2026):** `verax-control-demo.web.app` e `verax-control-verax.web.app`, com os cabeçalhos conferidos de fora.
- **Correção depois da primeira publicação:** a raiz e as rotas da aplicação saíam com o cache padrão do Firebase (1 hora), porque a regra `no-cache` só casava com `/index.html`. Agora tudo é `no-cache` e só `/assets/` tem cache longo. O workflow confere as duas regras no site publicado.
- **Ruleset:** o vivo passou a exigir os 18 checks do `.github/rulesets/main.json`. Antes, exigia só 11: faltavam "Testes de navegador", "Imagem da API" e os 5 jobs de infraestrutura. Todos rodam em qualquer PR, sem filtro de caminho, então nenhum PR fica esperando um check que não roda.
- **Pendente:** os domínios próprios. Os registros de DNS (CNAME e TXT `_acme-challenge` de cada domínio, com o proxy desligado) ainda precisam ser criados no Cloudflare.

## Nova arquitetura, passo 2: conector só com o papel de leitura

- **Decisão (02/11/2026, `docs/ARQUITETURA.md`):** o conector só cria o papel de leitura. Nenhuma trilha, destino de log, bucket ou assinatura é criado ou alterado na conta do cliente: o Verax Control lê de onde o log já está.
- **Arquivos:** `infra/cloudformation/{verax-control-connector.yaml,README.md}`, `infra/cloudformation/tests/test_connector.py`, `docs/runbooks/onboarding-cliente.md`, `docs/ARQUITETURA.md`
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Um recurso só:** o papel `VeraxControlReadOnly`. Saíram a trilha do CloudTrail, a exportação do GuardDuty, o bucket e o log do WAF, o bucket de log de acesso e a chave KMS (de 706 para cerca de 300 linhas).
  - **Quem assume:** só o papel do nó (`NodeRoleName`, padrão `verax-control-node`, por `ArnEquals` no `aws:PrincipalArn`), na conta onde o nó roda (`NodeAccountId`), com o `ExternalId`. O principal é a conta, e não o ARN do papel, para o conector poder ser criado antes do nó. O nó pode rodar na conta do cliente ou na da Verax sem mudar nada.
  - **O que lê:**
    - configuração, como antes (`SecurityAudit`, `ViewOnlyAccess` e a leitura extra do Prowler, sem as quatro ações excluídas);
    - findings do GuardDuty, do Security Hub, do Inspector2 e do Access Analyzer;
    - o conteúdo de logs, só dos grupos (`LogGroupArns`), buckets (`LogBucketArns`) e chaves (`LogKmsKeyArns`) informados pelo cliente, com `kms:Decrypt` só via S3. Com as listas vazias, o papel não lê nenhum conteúdo de log.
  - **Permissões conferidas no código do Wazuh 4.14.9:** o coletor do CloudWatch Logs só chama `DescribeLogStreams` e `GetLogEvents` (e `DeleteLogStream`, se `remove_log_streams` estiver ligado, o que nunca fazemos). O do Inspector usa o `inspector2:ListFindings`. Pela documentação da AWS, `DescribeLogStreams` autoriza no ARN do grupo e `GetLogEvents` nos streams (`<arn>:*`). O template deriva a segunda lista da primeira (`Fn::Join`/`Fn::Split`), e o cliente informa cada grupo uma vez só.
  - **Negação explícita**, que vale mesmo se a AWS ampliar as políticas gerenciadas:
    - apagar, alterar, assinar ou exportar no CloudWatch Logs, inclusive `Unmask`;
    - apagar, gravar ou replicar no S3;
    - parar ou alterar trilhas;
    - mudar o log do WAF;
    - arquivar findings ou desligar GuardDuty, Security Hub, Inspector e Access Analyzer;
    - desativar ou apagar chaves KMS;
    - escrita no IAM, `PassRole` e assumir outros papéis.
- **Testes:** 14, todos lendo o template:
  - só o papel é criado;
  - confiança exata com `ExternalId`;
  - padrões dos parâmetros (só ARNs exatos, sem curinga);
  - verbos só de leitura;
  - conteúdo de log só das fontes informadas;
  - avaliação das expressões `Join`/`Split` com 1 e 2 valores;
  - chamadas do Wazuh liberadas;
  - 37 ações destrutivas negadas;
  - nenhuma ação liberada cortada pela negação.

  cfn-lint sem achados e checkov sem falhas. **Testes de mutação:** 16 de 16 pegos (sem `ExternalId`; papel do nó com curinga; `s3:PutObject` liberado; `logs:FilterLogEvents` de volta; `GetLogEvents` ou `GetObject` em qualquer recurso; `Decrypt` fora do S3; sem negar `logs:Delete*`, `wafv2:Put*`, `cloudtrail:Stop*` ou `sts:AssumeRole`; negação que corta a leitura; curinga aceito no grupo de log; papel do nó com qualquer nome; recurso extra; sessão longa).

- **Definição de pronto:** testes ✔ · lint ✔ · dependências ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Riscos:**
  - os módulos Terraform do E4/E8 (`infra/terraform/modules/{api,wazuh,prowler}`) assumiam o papel a partir de papéis `verax-control-production-*` e deixam de ser aceitos. Eles saem no passo 6.
  - o gerador de configuração do Wazuh (`infra/wazuh/scripts/render-manager-config.py`) ainda só conhece buckets. O CloudWatch Logs e o Inspector entram no passo 4, com o Docker Compose do nó.

## Nova arquitetura, passo 3: pilha do nó

- **Arquivos:** `infra/cloudformation/{verax-control-node.yaml,GUIA-NO.md}`, `infra/cloudformation/tests/test_node.py`, `docs/ARQUITETURA.md`, `docs/runbooks/onboarding-cliente.md`
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Só recursos novos**, com a etiqueta `verax-control-node`: VPC `10.250.0.0/24` própria com uma sub-rede e saída para a internet, flow logs (todo o tráfego) no bucket do nó.
  - **Rede:** grupo de segurança sem nenhuma regra de entrada. A saída vai só para 443/TCP e para 7844 TCP e UDP: o túnel do Cloudflare exige os dois protocolos (QUIC e HTTP/2), conforme a documentação dele. O IP público só serve para a saída; o NAT somaria cerca de US$ 33 por mês, e a exceção do checkov tem esse motivo.
  - **VM:** Amazon Linux 2023 pelo parâmetro público da AWS, sem chave SSH e sem user data. IMDSv2 obrigatório, com hop limit 2 para o manager do Wazuh, que roda em contêiner; o host bloqueia o IMDS para os outros contêineres, como no bundle do E4. Proteção contra encerramento e disco raiz cifrado.
  - **Disco de dados:** separado e cifrado, com `DeletionPolicy: Snapshot` e snapshots diários (DLM, 7 dias).
  - **Bucket do nó:** privado, versionado, só TLS e retido. Versões anteriores ficam 30 dias e os flow logs, 90.
  - **Papel da VM** (`verax-control-node[-<nome>]`, aceito pelo padrão do conector):
    - libera assumir só o `VeraxControlReadOnly`, o bucket do nó (3 pastas), os parâmetros do nó e métricas no próprio namespace;
    - nega explicitamente IAM, Organizations, CloudFormation, Lambda, escrita no EC2, alteração de logs e findings, desativação de chaves, `SendCommand`/`StartSession`/`PutParameter`, outros papéis e outros buckets;
    - nega a leitura de parâmetros do SSM fora do nó: a `AmazonSSMManagedInstanceCore` libera ler todos, o que, na conta do cliente, exporia os parâmetros dele.
  - **Instalação e atualização:** documento do State Manager com os parâmetros validados pelo SSM e de novo no bash (`[[ =~ ]]`, onde o `$` não aceita a quebra de linha no fim). Ele baixa a release `node-v<versão>` só por HTTPS, confere o SHA-256 antes de extrair qualquer coisa e só depois roda o `install-node.sh` do pacote. A associação só existe com versão e SHA-256: uma regra do template exige os dois juntos. Trocar a versão numa atualização do stack instala a nova.
  - **Alertas:** recuperação automática em falha do host, reinício em falha da VM, disco de dados acima de 80% (métrica do agente que o pacote instala) e orçamento mensal filtrado pela etiqueta do nó, com e-mail.
- **Testes:** 19 no template, com 33 no total junto aos do conector. Eles cobrem:
  - só recursos novos, todos com a etiqueta;
  - nenhuma entrada e a saída exata;
  - flow logs;
  - IMDSv2, sem SSH e sem user data;
  - discos cifrados e preservados, e snapshots no disco certo;
  - bucket privado, versionado, retido e só TLS;
  - confiança só do EC2 da conta e nome do papel compatível com o conector;
  - permissões exatas do papel;
  - negações (24 ações conferidas);
  - nenhuma ação da `AmazonSSMManagedInstanceCore` cortada pela negação;
  - ordem download → SHA-256 → extração → execução;
  - padrões dos parâmetros e revalidação no shell.

  A revalidação também rodou de verdade no bash, com 9 tentativas barradas (quebra de linha no fim de cada parâmetro, `$(id)`, espaço e outro papel). cfn-lint sem achados e checkov sem falhas, com 3 exceções com motivo. **Testes de mutação:** 18 de 18 pegos (porta de entrada; saída para tudo; IMDSv1; chave SSH; disco de dados apagado ou sem cifra; sem conferir o SHA-256 ou extraindo antes; parâmetro direto no shell; sem negar IAM ou `ec2:Terminate*`; assumir qualquer papel; ler parâmetros do cliente; negar o que o SSM precisa; bucket sem TLS ou apagado com o stack; instalar sem checksum; papel com outro nome).

- **Definição de pronto:** testes ✔ · lint ✔ · dependências ✔ · regras de segurança ✔ · **nada aplicado na AWS** (portão)
- **Pendente:** o pacote do nó (`install-node.sh`, Docker Compose, agente do CloudWatch e release `node-v*`) é o passo 4.
- **Correções da revisão do PR (Codex), com testes novos:**
  - a confiança dos papéis da VM e dos snapshots ficou sem `aws:SourceAccount`. O EC2 não envia essa chave ao assumir o papel do perfil de instância, e a condição deixaria a VM sem credencial, logo sem Session Manager e sem instalação. Só quem tem `iam:PassRole` na conta entrega esses papéis aos serviços;
  - a AMI ficou fixa (`AmiId`, tipo `AWS::EC2::Image::Id`), e a AMI e o tipo saíram do modelo de lançamento e foram para a instância. Antes, o parâmetro do SSM era relido a cada atualização do stack e trocava a VM sempre que saía uma imagem nova. A troca falharia, porque o disco de dados ainda estaria preso à VM antiga. Agora trocar o tipo só para e religa a VM, e o sistema é atualizado no lugar pelo pacote do nó;
  - os snapshots usam uma etiqueta-alvo só, exclusiva do disco de dados de cada nó. O DLM escolhe volumes com qualquer uma das etiquetas-alvo, e as duas anteriores pegavam também o disco raiz e os discos de outros nós;
  - exceções do Trivy com motivo: saída 443/7844, tópico SNS sem chave própria, bucket com SSE-S3 e o falso positivo do disco raiz, cifrado no modelo de lançamento. Conferido com o Trivy 0.76.1 do CI: a versão anterior falha com os 6 achados e esta passa.

## T7.6 Torre (e o menu no celular)

- **Arquivos:** `packages/shared/src/{tower.ts,findings.ts}` (+ teste), `apps/api/src/{tower/tower-rules.ts,alerts/finding-draft.ts}`, `apps/web/src/pages/{tower-page.tsx,tower-reason.ts}` (+ teste), `apps/web/src/lib/format.ts` (+ teste), `apps/web/src/mocks/{fixtures.ts,handlers.ts}`, `apps/web/src/routes/router.tsx`, `apps/web/src/layout/app-layout.tsx` (+ teste)
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Contrato compartilhado** de `GET /v1/tower` (`towerSummarySchema`):
    - semáforo, motivos, decisões pendentes, incidentes abertos por severidade, postura (nota, data e limite) e cobertura;
    - a API passa a importar dele os tipos do semáforo e as severidades dos achados, para os dois lados não divergirem;
    - os status dos achados da T5.5 (novo, em análise, legítimo, resolvido) também entram no pacote compartilhado.
  - **Tela**, que responde em segundos "está tudo bem?" e "o que preciso decidir?":
    - o semáforo vem com a frase do porquê e os números (por exemplo, "1 incidente crítico aberto, 2 incidentes altos abertos e nota de postura 64, abaixo de 70.");
    - cada decisão pendente tem um botão que leva à lista já filtrada;
    - os incidentes abertos aparecem por severidade, com link;
    - a nota de postura usa o limite que a API informa;
    - a cobertura mostra as contas conectadas, o último evento e as contas silenciosas.

    A Torre se atualiza a cada minuto. O admin_verax sem cliente escolhido é orientado a escolher um, e a Torre nem é buscada. Erro ou resposta fora do contrato mostram a mensagem com "Tentar de novo".

  - **Demonstração:**
    - o cliente fictício Alfa tem o que mostrar numa apresentação: incidente crítico, decisões, postura baixa e uma conta silenciosa;
    - o Beta está tranquilo, para comparar;
    - o admin_verax da demonstração já começa com o Alfa selecionado.
  - **Celular:** a moldura do app (E6) não se adaptava: o menu lateral espremia o conteúdo. Abaixo da largura de tablet, o menu vira uma gaveta, aberta pelo botão "Menu". Ela fecha ao navegar, ao tocar fora ou com Esc. O estado deriva do caminho em que foi aberta, sem efeito.
- **Testes:**
  - 13 no contrato;
  - 9 na tela e na frase do semáforo: conteúdo completo, navegação filtrada, cliente verde com alertas sem dono, nenhuma decisão, sem cliente, erro da API e resposta fora do contrato;
  - 5 de formatação (tempo relativo, lista e plural);
  - 1 da gaveta.

  Os testes da API que usam as severidades continuam verdes. Conferido visualmente no modo de demonstração, em tema claro, tema escuro e celular (390 px).

- **Definição de pronto:** critérios de aceite ✔ (semáforo com frase, decisões, incidentes por severidade, nota de postura e cobertura) · testes ✔ · lint ✔ · dependências ✔
- **Pendente:** o endpoint real `GET /v1/tower`, com a persistência do E5. A demonstração usa o mesmo contrato.

## T7.7 Achados

- **Arquivos:** `packages/shared/src/findings.ts` (+ teste), `apps/web/src/pages/findings-page.tsx` (+ teste), `apps/web/src/features/findings/*`, `apps/web/src/components/ui/{sheet,select-field}.tsx`, `apps/web/src/components/ui/field.tsx` (área de texto), `apps/web/src/mocks/{findings-fixtures,findings-handlers}.ts`
- **Dependências:** nenhuma; o painel lateral usa o Dialog do `radix-ui`, que já estava aprovado e instalado.
- **Como funciona:**
  - **Contrato compartilhado** dos endpoints das T5.4 e T5.5:
    - lista com filtros por severidade, status, conta e período;
    - detalhe com regra do Wazuh, técnicas MITRE, comentários e evento bruto (null depois dos 90 dias de retenção);
    - mudança de status com comentário opcional e comentário avulso. O comentário aceita quebra de linha; os outros caracteres de controle são recusados.
  - **Tela:**
    - os filtros ficam na URL (`/achados?status=new&severidade=critical`): o atalho da Torre abre a lista já filtrada, o endereço pode ser compartilhado, e valor desconhecido na URL é ignorado;
    - trocar um filtro volta para a primeira página;
    - o detalhe abre num painel lateral acessível (foco preso, Esc fecha), também pela URL (`?achado=<id>`). Ele mostra os campos, MITRE, o vínculo com o incidente, o evento bruto formatado e os comentários.
  - **Triagem** (`findings:triage`):
    - mudar o status com comentário, aplicado na tela assim que a API responde;
    - ao marcar "legítimo", a tela oferece criar a exceção (T3.5) por usuário, IP ou recurso, com motivo obrigatório. A lista e a Torre são atualizadas.

    O papel de leitura vê tudo, sem as ações.

  - **Demonstração:** 21 achados fictícios no cliente Alfa e 3 no Beta, coerentes com a Torre: exatamente 5 altos ou críticos novos fora de incidente, e grupos que formam os incidentes da próxima tela (chave comprometida, força bruta SSH, ataque ao WAF e bucket público). Os IPs são das faixas de documentação. O mock guarda as mudanças em memória, então a demonstração é interativa.
- **Testes:** 9 no contrato e 8 na tela:
  - filtros da URL;
  - troca de filtro com volta à primeira página e limpeza;
  - painel com o evento bruto, fechando com Esc;
  - status com comentário e exceção;
  - comentário avulso;
  - papel de leitura sem ações;
  - admin sem cliente;
  - filtro inválido ignorado.

  Conferido visualmente na lista e no painel, no desktop e no celular.

- **Definição de pronto:** critérios de aceite ✔ (tabela com filtros, detalhe lateral com evento bruto, mudar status, comentar e marcar legítimo criando exceção) · testes ✔ · lint ✔ · dependências ✔
- **Pendente:** os endpoints reais, com a persistência do E5.

## T7.8 e T7.9 Incidentes (lista e detalhe)

- **Arquivos:** `packages/shared/src/incidents.ts` (+ teste), `packages/shared/src/protected-resources.ts` (tipo `Author`), `apps/web/src/pages/{incidents-page,incident-page}.tsx` (+ teste), `apps/web/src/features/incidents/*`, `apps/web/src/components/security/timeline.tsx` (link por evento), `apps/web/src/mocks/{incidents-handlers,handlers,fixtures,findings-fixtures}.ts`, `apps/web/src/routes/router.tsx` (rota de detalhe)
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Contrato compartilhado** da T5.7:
    - lista com filtros por status, severidade e "só os sem responsável";
    - cada incidente traz nota, severidade, chaves de agrupamento (`tipo:valor`, como o núcleo da T5.6 grava), contas, recursos, MITRE e responsável;
    - o detalhe traz a linha do tempo dos achados;
    - a atualização muda status e responsável;
    - a lista de responsáveis possíveis vem do endpoint `/v1/incidents/assignees`.
  - **Lista (T7.8):**
    - ordenada pela nota, com severidade, ativos, tempo aberto, responsável e status;
    - filtros na URL: o atalho da Torre (`?responsavel=nenhum`) e os links por severidade já abrem filtrados.
  - **Detalhe (T7.9, pendência 8):**
    - o título e o resumo em português saem de modelo, sem LLM: quem (chave, usuário e IP, pelo elo mais forte), o que fez na ordem dos achados (dicionário das ações AWS mais comuns e dos tipos do GuardDuty; o que não estiver nele usa o título do achado), quando, onde e quão grave;
    - "primeiro passo" recomendado pelo elo do agrupamento;
    - linha do tempo com link para cada achado, ativos envolvidos e MITRE;
    - status e responsável (`incidents:write`), aplicados na tela assim que a API responde.

    O papel de leitura vê o tratamento sem poder mudar. Incidente inexistente ou de outro cliente mostra o erro, sem dados.

  - **Demonstração:**
    - seis incidentes no cliente Alfa e dois no Beta, montados dos mesmos achados da tela de Achados;
    - a Torre agora calcula do estado do mock os incidentes abertos por severidade, os sem responsável, os achados sem triagem e a cor do semáforo (regra da T5.10). Triar um achado, resolver um incidente ou atribuir um responsável aparece em todas as telas;
    - pela regra da T5.6, achado baixo não abre incidente, então a Torre fictícia passou a ter zero incidentes baixos abertos.
- **Revisão do PR dos Achados (Codex), aplicada lá:**
  - a contagem de achados sem triagem da Torre vem do estado do mock;
  - o link "Ver incidente" levava a uma rota que ainda não existia; o link aponta de novo para o detalhe neste PR, junto com a rota.
- **Testes:**
  - 7 no contrato;
  - 3 na lista: ordem pela nota, atalho da Torre, e filtros por severidade e status;
  - 4 no detalhe: resumo, linha do tempo com links, ativos e MITRE; troca de status e responsável refletida na Torre; papel de leitura; incidente inexistente;
  - 2 na narrativa.

  Conferido visualmente na lista e no detalhe, no desktop e no celular.

- **Definição de pronto:** critérios de aceite ✔ (lista ordenada por nota com severidade, ativos e tempo aberto, filtros por status; resumo em português, linha do tempo, ativos, MITRE, status e responsável) · testes ✔ · lint ✔ · dependências ✔

## T7.10 Postura cloud

- **Arquivos:** `packages/shared/src/posture.ts` (+ teste), `apps/web/src/pages/posture-page.tsx` (+ teste), `apps/web/src/features/posture/*`, `apps/web/src/components/security/score-trend.tsx`, `apps/web/src/mocks/{posture,handlers}.ts`, `apps/web/src/pages/auth-pages.test.tsx` (prazo de um teste)
- **Dependências:** nenhuma. O Recharts está na lista aprovada, mas não foi preciso: o gráfico de uma série por conta é um SVG próprio.
- **Como funciona:**
  - **Contrato compartilhado** da T5.8:
    - nota do cliente e de cada conta, com aprovadas, reprovadas por gravidade e até 90 dias de histórico;
    - checagens reprovadas com risco, correção e referências, só HTTPS (`javascript:` e `http:` recusados);
    - filtros por conta e gravidade.
  - **Tela (T7.10):**
    - um cartão por conta, com a nota, a evolução no tempo, as reprovadas por gravidade e o atalho "Ver o que corrigir nesta conta";
    - a tabela "O que corrigir, do mais grave ao menos grave";
    - o painel "Como corrigir" mostra por que importa, o passo de correção (os comandos `aws` em fonte monoespaçada) e as referências, que abrem em outra aba com `noopener noreferrer`.

    Os estados de sem varredura, sem cliente e erro estão cobertos.

  - **Gráfico de evolução**, conforme o guia de visualização:
    - uma série, sem legenda: o título do cartão a nomeia;
    - linha de 2 px, grade discreta e o limite de atenção tracejado, com o rótulo numa margem própria, para não encostar na linha;
    - dica com a data e a nota ao passar o mouse, ou pelas setas com o gráfico em foco;
    - os mesmos números numa tabela para leitor de tela.
  - **Demonstração:** checagens reais do Prowler (os IDs), com título, risco e correção em português. A conta de produção da Alfa tem nota 61 e a de homologação, 72, com 30 dias de evolução; a Beta tem 91.
  - **Teste instável:** o teste de login que preenche o formulário duas vezes passava perto dos 5 s padrão com a suíte inteira em paralelo na máquina local. Ganhou 15 s de prazo, com o motivo no código.
- **Testes:** 6 no contrato e 7 na tela:
  - nota e evolução por conta;
  - ordem por gravidade;
  - atalho da conta;
  - filtro por gravidade;
  - painel com a referência em outra aba;
  - gráfico pelo teclado e a tabela de dados;
  - sem varredura e sem cliente.

  Conferido visualmente no tema claro, no escuro e no celular.

- **Definição de pronto:** critérios de aceite ✔ (nota por conta com evolução; achados de configuração priorizados por gravidade, com o passo de correção) · testes ✔ · lint ✔ · dependências ✔

## T7.11 Ativos e identidades

- **Arquivos:** `packages/shared/src/inventory.ts` (+ teste), `apps/web/src/pages/assets-page.tsx` (+ teste), `apps/web/src/features/inventory/*`, `apps/web/src/mocks/{inventory,handlers}.ts`
- **Dependências:** nenhuma; as abas usam o Tabs do `radix-ui`, já instalado.
- **Como funciona:**
  - **Contrato compartilhado** da T5.9:
    - os motivos de risco são os mesmos das regras do núcleo (`risk-rules.ts`);
    - um schema por tipo de ativo: usuários IAM, chaves de acesso, instâncias EC2, buckets S3 e security groups;
    - a visão geral traz a conta root de cada conta e, por tipo, o total e quantos têm risco;
    - filtros por conta e "só os com risco".
  - **Tela (T7.11):**
    - um alerta para a conta root com risco ("root sem MFA: corrija antes de tudo");
    - uma aba por tipo, com o total e quantos têm risco. As abas são acessíveis e funcionam com as setas do teclado; a aba escolhida fica na URL;
    - cada tabela vem do maior risco ao menor, com os motivos em português;
    - destaque, conforme o critério de aceite, para chave antiga (idade acima de 90 dias), bucket público, porta aberta para a internet (como "TCP 22" ou "Todo o tráfego"), MFA desligado com console e IMDSv1.
  - **Demonstração:** o inventário é coerente com as outras telas:
    - a chave `AKIAIOSFODNN7EXAMPLE` do incidente tem 240 dias;
    - o bucket de relatórios está público;
    - o grupo `sg-0123…` libera a porta 22;
    - o root da produção não tem MFA, como na Postura.
- **Revisão do PR da Postura (Codex), aplicada lá:**
  - uma varredura só com checagens informativas, manuais ou silenciadas não gera nota e era tratada como "sem varredura". Agora a existência da varredura vem da data, e os resultados continuam na tela;
  - o teste do link de referência usava expressão regular sem âncora (alerta do CodeQL).
- **Testes:**
  - 4 no contrato;
  - 6 na tela: alerta do root com as abas e a ordem pelo risco; chave antiga; bucket público com o filtro; portas abertas; abas pelo teclado; sem cliente;
  - 4 na descrição das regras.

  Conferido visualmente no desktop e no celular.

- **Definição de pronto:** critérios de aceite ✔ (abas para usuários IAM, chaves, instâncias, buckets e security groups; destaque para chave antiga, bucket público e porta aberta) · testes ✔ · lint ✔ · dependências ✔

## T7.1 a T7.5 Cadastros (clientes, usuários, contas cloud, lista de proteção e exceções)

- **Arquivos:** `apps/web/src/pages/admin/*` (+ teste), `apps/web/src/features/admin/*`, `apps/web/src/mocks/{admin,handlers,findings-handlers}.ts`, `apps/web/src/layout/navigation.ts` (+ teste), `apps/web/src/routes/router.tsx`, `packages/shared/src/cloud-accounts.ts` (+ teste)
- **Dependências:** nenhuma. O `react-hook-form` está na lista aprovada, mas os formulários seguem o padrão das telas de autenticação (estado simples e validação pelos schemas compartilhados).
- **Como funciona:** as cinco telas usam os endpoints que a API já tem (E3), então também funcionam fora da demonstração.
  - **Clientes (T7.1, só admin_verax):** listar, cadastrar, editar e desativar ou reativar. A lista vem do resumo e o painel carrega o cadastro completo, como na API.
  - **Usuários (T7.2):**
    - convidar (link de uso único por e-mail), trocar o papel, desativar ou reativar o acesso e reenviar o convite pendente;
    - ninguém altera o próprio acesso;
    - a lista mostra se o MFA já foi cadastrado.
  - **Contas cloud (T7.3):**
    - o cadastro gera o ExternalId, mostrado com botão de copiar e com os links do template e do passo a passo do conector (repositório público);
    - a lista mostra a conexão ("Conectada", "Falha ao assumir o papel", "Aguardando o conector") e o último evento;
    - esses dois campos entraram como opcionais no contrato, porque o banco ainda não os tem: chegam com a persistência do E5. Sem eles, a tela mostra "aguardando o conector";
    - o ExternalId só aparece para quem configura o conector.
  - **Lista de proteção (T7.4):** incluir com motivo obrigatório (o identificador é conferido pelo formato do tipo), editar o motivo e remover com confirmação em dois passos, sem janela do navegador.
  - **Exceções (T7.5):**
    - criar (regra, campo, valor, motivo e validade de até um ano), editar motivo e validade, e remover;
    - a lista mostra quantos achados cada uma já marcou, o último, e a validade, com a vencida em destaque.
  - **Formulários:** a validação usa os mesmos schemas da API, com as mensagens em português. O erro de cada campo fica ligado a ele por `aria-describedby`, e os erros da API são anunciados.
  - **Menu:** Contas cloud, Lista de proteção e Exceções entraram em Administração. Pela matriz de permissões, a leitura é liberada para todos; a escrita, conforme o papel.
  - **Demonstração:** um só estado de cadastros, compartilhado com as outras telas:
    - a exceção criada ao marcar um achado como legítimo aparece em Exceções;
    - as contas viram o filtro dos achados;
    - a troca de cliente da sessão consulta o mesmo cadastro.
- **Testes:** 10 nas telas:
  - cadastro de cliente com validação;
  - edição e desativação;
  - convite com validação;
  - papel, acesso e reenvio do convite;
  - conta com ExternalId e conector;
  - conta repetida recusada;
  - lista de proteção com identificador inválido, inclusão e remoção;
  - exceções com contagem, criação, validação de IP e edição;
  - exceção vinda de um achado;
  - papel de leitura sem os botões.

  Também 1 no contrato e as expectativas do menu por papel. Os testes de formulário têm 15 s de prazo, porque são preenchidos letra por letra e a suíte inteira roda em paralelo. Conferido visualmente.

- **Definição de pronto:** critérios de aceite ✔ (T7.1 a T7.5) · testes ✔ · lint ✔ · dependências ✔

## Correção: deploy da demonstração barrado pela varredura de segredos

- **Problema:** desde a tela de Achados (#19), o deploy do painel falhava. Os dados fictícios usavam os IDs de chave de exemplo da documentação da AWS (`AKIA…EXAMPLE`). A varredura do bundle (`scripts/scan-bundle.mjs`) barra esse padrão, e o painel no ar continuava na versão da Torre. O CI dos PRs não pegou: compilava só o build de produção, que não leva os dados do mock.
- **Correção:**
  - as chaves fictícias passam a usar o prefixo `DEMO`, que não é formato da AWS;
  - a varredura continua igual;
  - o job de build do CI agora também compila a demonstração (`build:demo`), com a mesma varredura, para que o erro apareça no PR.
- **Testes:** os testes de Ativos, Achados e Incidentes conferem os novos IDs. O `build:demo` local passa na varredura.

## T7.12 Revisão de UX

- **Arquivos:** `apps/web/e2e/pages.mock.spec.ts`, `apps/web/e2e/layout.mock.spec.ts`, `apps/web/e2e/fullstack/auth.fullstack.spec.ts`, `apps/web/src/components/ui/sheet.tsx`, `apps/web/src/components/demo-banner.tsx` (+ teste), `apps/web/src/pages/login-page.tsx`, `apps/web/src/layout/navigation.ts` (+ teste)
- **Dependências:** nenhuma (axe e Playwright já estavam no projeto).
- **Como funciona:**
  - **Acessibilidade conferida no navegador:** o axe roda em todas as 12 telas e nos painéis de detalhe (achado e checagem), com as regras WCAG 2.2 AA, inclusive contraste. Nenhuma violação.
  - **Celular:** nenhuma tela rola na horizontal a 360 px; as tabelas rolam dentro do próprio quadro.
    - O CI (fontes do Linux, mais largas) pegou o detalhe do incidente passando 8 px. A causa era um tipo de achado do GuardDuty, um token longo sem espaço, que alargava a grade.
    - A linha do tempo e o título agora quebram esses tokens quando não cabem, e as colunas da grade aceitam encolher.
    - Em 360 px, a Postura passava 13 px: a tabela do gráfico, só para leitor de tela, tinha o `sr-only` no próprio `<table>`. Tabela ignora a largura de 1 px e crescia com o texto. O `sr-only` foi para um `div` em volta.
    - O teste agora aponta o elemento que passa da tela, e não só os pixels.
  - **Teclado:**
    - o painel de detalhe abre com Enter, prende o foco e fecha com Esc;
    - o foco volta para quem abriu. Isso estava quebrado: o painel abre pela URL, sem gatilho do Radix, e o foco ia para o corpo da página, de modo que quem navega por teclado perdia o lugar na lista. Agora o próprio painel guarda o elemento em foco ao abrir e o devolve ao fechar.
  - **Estados:** todas as telas e painéis têm carregando, vazio e erro (com "Tentar de novo" e o código para o suporte).
  - **Auditoria fora do menu:** a trilha é gravada desde a T1.3, mas a API não tem o endpoint de listagem. Uma tela "Em construção" no menu atrapalha a apresentação. Volta junto com o endpoint.
  - **Demonstração:** a tela de login mostra o acesso de exemplo, para quem sair durante uma apresentação conseguir voltar. As credenciais só funcionam no mock; o teste confere que são as mesmas que o mock aceita.
- **Testes:**
  - 15 novos no navegador: 12 telas, painéis, teclado e celular;
  - 3 unitários do acesso de demonstração.

  Os testes de permissão que usavam a rota da auditoria agora usam a tela de clientes.

- **Definição de pronto:** critérios de aceite ✔ (estados vazio, carregando e erro; textos em português; uso no celular; contraste e teclado) · testes ✔ · lint ✔ · dependências ✔
- **Pendente:** a tela de auditoria (endpoint de listagem na API e tela).

## Contas cloud da GCP e do Cloudflare

- **Pedido:** o cadastro de contas só aceitava AWS. O SOC da própria Verax monitora a GCP, e o Cloudflare entra para quem usa o WAF e o DNS dele.
- **Arquivos:**
  - `packages/shared/src/cloud-accounts.ts` (+ teste), mais as referências de conta em `findings.ts`, `incidents.ts`, `posture.ts`, `tower.ts` e `inventory.ts`;
  - `apps/api/prisma/schema.prisma` e a migration `20261103060000_cloud_providers`;
  - `apps/api/src/cloud-accounts/cloud-accounts.service.ts` e `apps/api/test/cloud-accounts.test.ts`;
  - `apps/web/src/pages/admin/cloud-accounts-page.tsx`, `apps/web/src/features/admin/labels.ts`, `apps/web/src/mocks/{admin,fixtures}.ts` e `apps/web/src/pages/admin/admin-pages.test.tsx`;
  - `docs/ARQUITETURA.md`.
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Provedores:** o cadastro é uma união por provedor, e cada um tem o próprio formato de ID e os próprios campos:
    - **AWS:** 12 dígitos, regiões, buckets e ExternalId;
    - **GCP:** ID do projeto (6 a 30 caracteres, começa com letra) e a assinatura do Pub/Sub, opcional no cadastro. A assinatura é guardada pelo nome completo (`projects/<projeto>/subscriptions/<id>`), porque o ID só é único dentro do projeto dono. A tela aceita só o ID e completa com o projeto da conta;
    - **Cloudflare:** 32 caracteres hexadecimais e as zonas (domínios).

    Os três formatos não se sobrepõem, e achados, incidentes, postura e Torre aceitam qualquer um deles como referência de conta.

  - **Sem credencial em nenhum provedor:** o schema estrito recusa token do Cloudflare, chave JSON da GCP e qualquer campo de outro provedor. O token e a identidade ficam no nó.
  - **Alteração:** cada campo só vale para o provedor da conta. Mandar regiões para um projeto da GCP, por exemplo, dá 400 com o nome do campo, em vez de ser ignorado em silêncio.
  - **Isolamento:**
    - o ID é único por provedor;
    - como já valia para os buckets, a assinatura do Pub/Sub e a zona do Cloudflare não podem ser de dois clientes (lock transacional por origem, em ordem fixa). Vários projetos do mesmo cliente podem dividir uma assinatura, como num coletor agregado.
  - **Banco:**
    - o provedor virou enum por conversão da coluna, sem perder valor;
    - um `CHECK` exige ExternalId em toda conta AWS, mesmo fora da API.
  - **Tela:**
    - o formulário mostra os campos do provedor escolhido;
    - a tabela mostra o que cada conta monitora (regiões, assinatura ou zonas);
    - o detalhe explica a configuração de cada provedor e permite informar depois a assinatura (GCP) ou as zonas (Cloudflare);
    - a demonstração ganhou um projeto da GCP e uma conta do Cloudflare fictícios.
- **Testes:**
  - 32 no contrato: formatos, campos de outro provedor, credenciais recusadas, domínios, referência de conta e campos fora do provedor;
  - 15 na API: cadastro de GCP e Cloudflare, credenciais recusadas, projeto, assinatura e zona disputados por dois clientes, o mesmo ID de assinatura em projetos diferentes (apontado pelo revisor automático), alteração com campo de outro provedor e o `CHECK` do banco;
  - 2 na tela: projeto da GCP com validação e passos, e zonas do Cloudflare editadas no detalhe.
- **Pendente:**
  - a leitura de fato (o Wazuh lendo a assinatura do Pub/Sub e o coletor do Cloudflare), com o nó na GCP;
  - o vínculo do alerta ao cliente para essas fontes (T5.2 para GCP e Cloudflare).

## E5 (integração): achados gravados e endpoints de triagem (T5.4 e T5.5)

- **Arquivos:**
  - `apps/api/prisma/schema.prisma` e a migration `20261103080000_findings`;
  - `apps/api/src/findings/{findings.service,findings.controller,findings.module,raw-events}.ts`;
  - `apps/api/src/app.module.ts` e `apps/api/src/common/prisma/tenant-scope.ts`;
  - `apps/api/test/findings.test.ts` e `apps/api/test/support/create-app.ts` (troca de provider por dublê).
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Models:**
    - `Finding` guarda os campos que o painel mostra, a severidade e o status. É único por `(source, sourceEventId)`, para o sync reler a janela de sobreposição sem duplicar;
    - `FindingComment` guarda os comentários.

    Os dois têm `tenantId` e entram no escopo por cliente; o meta-teste do DMMF confere.

  - **Garantias no banco:**
    - a chave estrangeira do comentário inclui o cliente, então um comentário nunca aponta para achado de outro cliente;
    - um gatilho recusa UPDATE, DELETE e TRUNCATE nos comentários, como na auditoria: eles são o registro de quem decidiu o quê.
  - **Endpoints** (o contrato que o painel e o modo de demonstração já usam):
    - `GET /v1/findings`: filtros de severidade, status, conta e período, com os mais recentes primeiro e a contagem de comentários;
    - `GET /v1/findings/:id`: regra, técnicas MITRE, comentários e o evento bruto;
    - `PATCH /v1/findings/:id/status`: o comentário opcional entra na mesma transação e na mesma auditoria (`finding.status`, com status anterior e novo);
    - `POST /v1/findings/:id/comments`: auditado como `finding.comment`.

    Leitura com `findings:read`; mudança de status e comentário com `findings:triage`. Achado não é criado pela API, só pelo sync.

  - **Evento bruto:** vem do indexer por uma interface (`RawEventReader`). Neste passo, ela devolve vazio; o próximo passo liga o indexer. Se o indexer falhar, o detalhe sai sem o evento, e o erro vai para o log.
- **Testes:** 22 na API:
  - isolamento A/B na lista e no detalhe, e na mudança de status e no comentário, sem nada mudar;
  - ordem, formato, filtros e filtros inválidos (inclusive injeção na conta);
  - detalhe com e sem evento bruto, inclusive com o indexer fora do ar;
  - status com comentário e auditoria, comentário avulso, corpos inválidos sem mudar nada e permissão de leitura;
  - garantias do banco: alerta duplicado, comentário para achado de outro cliente, comentário editado ou apagado.

  Suíte da API completa: 562.

- **Pendente (próximo passo do E5):**
  - o sync que grava os achados a partir do indexer (worker com lock, cursor, exceções e `lastEventAt`), com o leitor de evento bruto ligado ao indexer;
  - o vínculo com incidentes (`incidentId`);
  - achados de exemplo no seed local.

## E5 (integração): sync de alertas para achados (T5.3), com exceções e fila sem dono

- **Arquivos:**
  - `apps/api/src/alerts/{alert-sync,exception-match}.ts`, `apps/api/src/worker.ts` e `apps/api/package.json` (`start:worker`);
  - `apps/api/src/findings/{indexer-raw-events,findings.module}.ts`, `apps/api/src/main.ts` e `apps/api/src/app.module.ts`;
  - `apps/api/src/common/config/{env.schema,load-config}.ts` e `apps/api/src/common/prisma/prisma.service.ts`;
  - `apps/api/src/cloud-accounts/cloud-accounts.service.ts` (`lastEventAt`);
  - `apps/api/prisma/schema.prisma` e as migrations `20261103090000_alert_sync` e `20261103100000_sync_continuation`;
  - testes: `apps/api/test/{alert-sync,cloud-accounts}.test.ts`, `apps/api/test/alerts/exception-match.test.ts`, `apps/api/test/findings/indexer-raw-events.test.ts` e `apps/api/src/common/config/load-config.test.ts`.
- **Dependências:** nenhuma. A faixa de IP das exceções usa o `BlockList` do próprio Node.
- **Como funciona:**
  - **Worker:** é o mesmo código da API num processo à parte (`node dist/worker.js`), sem porta aberta. Roda em laço, a cada `SYNC_INTERVAL_SECONDS` (60 por padrão, de 15 a 3600). SIGTERM espera a execução em curso. A configuração dele só pede banco e log, além do indexer (`loadIndexerConfig`); em produção, exige TLS conferido até o banco, como a API.
  - **Uma execução:**
    1. pega a concessão em `SyncState`, um worker por vez. Ela vence sozinha, então um worker que morre no meio não trava o próximo;
    2. monta o cadastro de contas AWS ativas, com os buckets, e as exceções em vigor;
    3. lê o indexer a partir do último alerta processado, menos a sobreposição, página a página pelo cursor. Há um limite de páginas por execução: um atraso grande é lido em várias execuções;
    4. decide o dono de cada alerta (T5.2). Com dono, grava o achado sem duplicar (`skipDuplicates` na chave única), pelo escopo do cliente. Sem dono ou inválido, o alerta vai para a `UnownedAlert` com o motivo, sem o evento bruto;
    5. grava o `lastEventAt` de cada conta e até onde leu. Numa falha, grava só o tipo do erro, sem a mensagem, que poderia carregar dado do indexer, e não avança a leitura.
  - **Exceções (T3.5):** mesma regra do Wazuh, dentro da validade, e usuário ou recurso iguais, ou IP dentro da faixa, em IPv4 ou IPv6. O achado já nasce "legítimo", com o `exceptionId`, e a exceção soma `matchedCount` e `lastMatchedAt`. A exceção de um cliente nunca vale para outro.
  - **Reler não desfaz a triagem:** um achado já gravado não é sobrescrito; o status dado por alguém fica.
  - **Continuação (apontado pelo revisor automático):** quando uma execução bate o limite de páginas, ela grava o cursor (horário e id), e a próxima segue dele. Sem isso, uma sobreposição com mais alertas do que o limite fazia toda execução reler os mesmos alertas, e a leitura não avançava. Com a leitura em dia, volta a reler a sobreposição.
  - **Último evento depois de falha (apontado pelo revisor automático):** o `lastEventAt` considera também os achados que voltam como duplicados. Assim, a nova tentativa depois de uma falha no meio grava o que a execução interrompida não gravou.
  - **Evento bruto do detalhe:** com `INDEXER_URL` configurado, a API busca o alerta no indexer pelo id e devolve o evento saneado; sem indexer, sai sem.
  - **Contas:** a API passa a devolver o `lastEventAt` gravado pelo sync.
- **Testes:** 39 novos.
  - 13 de integração do sync: dono certo, fila sem dono e alerta inválido, releitura sem duplicar nem desfazer a triagem, evento forjado no bucket de outro cliente, exceção aplicada e vencida, exceção que não atravessa clientes, GuardDuty, paginação com limite e continuação, concessão ocupada e vencida, falha do indexer, conta desativada, continuação com sobreposição maior que o limite e último evento gravado na nova tentativa (os dois últimos falham sem a correção).
  - 15 da regra de exceção, 4 do evento bruto, 4 da configuração do worker (inclusive sem vazar a URL do banco) e 1 do `lastEventAt`.

  Suíte da API: 599.

- **Pendente:**
  - o agrupamento em incidentes dentro do sync (T5.6, próximo passo);
  - as fontes da GCP e do Cloudflare;
  - a tela da fila sem dono para `admin_verax`;
  - o worker no pacote do nó;
  - as variáveis do worker (`SYNC_INTERVAL_SECONDS` e `INDEXER_*`) no `.env.example`, que o agente não lê por regra do projeto.

## Base do nó da Verax na GCP (Terraform), aplicada

- **Pedido:**
  - o SOC da própria Verax roda na GCP. O código e o guia ficam em `infra/gcp/`;
  - o usuário autorizou o agente a aplicar;
  - o custo do primeiro desenho (e2-standard-4 para o Wazuh, cerca de R$ 1.000 por mês) foi recusado, com o pedido de enxugar.
- **Desenho enxuto:**
  - o nó da Verax monitora só a GCP e o Cloudflare, então não precisa do Wazuh: a API vai ler o Pub/Sub direto e aplicar regras próprias;
  - a VM é uma e2-micro com 30 GB de disco padrão em us-east1, no nível gratuito, com 2 GB de memória de troca;
  - custo-alvo de R$ 5 a 15 por mês (Cloud NAT e snapshot);
  - orçamento de R$ 50 por mês com avisos.
- **Arquivos:**
  - `infra/gcp/*.tf`, `startup.sh`, `terraform.tfvars.example`, `.terraform.lock.hcl`, `.tflint.hcl` e `GUIA.md`;
  - `.github/workflows/iac.yml` (fmt, validate e tflint também em `infra/gcp`) e `.github/dependabot.yml`.
- **Dependências:** provider `hashicorp/google` 8.9.0, versão exata, publicado em 27/10. O lock tem os hashes de Linux, Windows e macOS.
- **O que existe** (38 recursos com o prefixo `verax-node`; nada existente mudou):
  - **Rede:** VPC própria, flow logs com amostra de 10% e Cloud NAT. SSH só pelo IAP; o resto é recusado e registrado.
  - **VM:** sem IP público, com Shielded VM, OS Login, chaves de projeto bloqueadas, console serial desligado e proteção contra exclusão.
  - **Disco:** recurso próprio com `prevent_destroy` (fica se a VM for apagada) e snapshot semanal guardado por 4 semanas.
  - **Identidade:** conta de serviço sem chave, com só `logging.logWriter` e `monitoring.metricWriter` no projeto. Lê a assinatura e os próprios segredos por permissão no recurso.
  - **Logs:** um sink em cada projeto monitorado (dois, por decisão do usuário) leva auditoria e bloqueios do Cloud Armor ao tópico do nó. A assinatura nunca expira e guarda as mensagens por 7 dias.
  - **Segredos:** dois cofres ainda vazios, a chave do Resend e o token do túnel do Cloudflare.
  - **Backups:** bucket privado e versionado; o nó cria e lê, mas não apaga.
  - **Orçamento:** R$ 50 por mês.

  Os IDs dos projetos da Verax ficam fora do repositório público.

- **Como foi aplicado:**
  - estado num bucket próprio e versionado, criado com o `gcloud`;
  - autenticação por token temporário do `gcloud`, só durante cada comando;
  - variáveis por `-var`, sem arquivo de variáveis;
  - no primeiro `apply`, a API do Compute ainda não tinha propagado, e a política de snapshot não dependia dela; acrescentei a dependência. O segundo `plan` mostrou só os 2 recursos que faltavam;
  - o `plan` final não mostra nenhuma diferença.
- **Conferido na nuvem:**
  - SSH pelo IAP, com 30 GB de disco e 2 GB de memória de troca;
  - saída para a internet pelo NAT (HTTP 200);
  - script de boot sem erro;
  - um evento de auditoria de um projeto monitorado chegou à assinatura em cerca de um minuto.
- **Verificação local:** `validate`, `tflint` e shellcheck limpos. Trivy só com achados baixos. Checkov sem falhas, com 4 exceções justificadas no código.
- **Pendente:**
  - os valores dos dois segredos;
  - o pacote do nó (API com a leitura do Pub/Sub e as regras de detecção da GCP, banco e túnel);
  - os papéis de leitura para a postura.

## E5 (integração): incidentes, Torre, postura e ativos na API

- **Pedido:** fechar o painel real. As telas já existiam no modo de demonstração; faltava a API responder a elas.
- **Arquivos:**
  - `apps/api/prisma/schema.prisma` e a migration `20261103110000_incidents_posture_inventory`;
  - `apps/api/src/incidents/{incident-grouping,incidents.service,incidents.controller,incidents.module}.ts`;
  - `apps/api/src/tower/tower.{service,controller,module}.ts`;
  - `apps/api/src/posture/posture.{service,controller,module}.ts` e `apps/api/src/inventory/assets.{service,controller,module}.ts`;
  - `apps/api/src/alerts/alert-sync.ts`, `apps/api/src/findings/findings.service.ts`, `apps/api/src/posture/prowler-report.ts`, `apps/api/src/common/prisma/tenant-scope.ts` e `apps/api/src/app.module.ts`;
  - testes: `apps/api/test/{incidents,tower-posture-assets,alert-sync}.test.ts` e `apps/api/test/posture/prowler-report.test.ts`.
- **Dependências:** nenhuma.
- **Como funciona:**
  - **Models novos, com escopo por cliente:** `Incident`, `PostureScan`, `PostureFailure` e `InventorySnapshot`. Os achados ganham `incidentId` e `triagedAt` (a primeira saída de "novo", para o relatório de tempo até a triagem). O incidente ganha `resolvedAt`.
  - **Garantias no banco:**
    - um gatilho impede achado e incidente de clientes diferentes;
    - a reprovação de postura tem chave composta com a varredura e o cliente.
  - **Agrupamento no sync (T5.6):** cada achado novo e não esperado por exceção entra num incidente aberto do mesmo cliente, com chave em comum na janela, ou abre um se for médio ou mais grave. O resumo do incidente (severidade, nota, período, chaves, contas, recursos e MITRE) é recalculado a cada achado. A nota soma 15 quando o achado envolve a lista de proteção, comparada também no formato `tipo:id` do achado.
  - **Incidentes (T5.7):**
    - lista pela nota de risco, com filtros;
    - detalhe com a linha do tempo, os 500 achados mais recentes em ordem cronológica;
    - responsáveis possíveis: usuários ativos do cliente que operam, e a equipe da Verax;
    - status e responsável auditados; responsável de outro cliente é recusado. Resolver grava `resolvedAt`, e reabrir limpa.
  - **Torre (T5.10):**
    - semáforo e motivos;
    - incidentes abertos por severidade;
    - decisões pendentes, em que a fila sem dono dos últimos 7 dias conta só para quem tem `unowned_alerts:read`;
    - postura da última varredura de cada conta;
    - cobertura pelo `lastEventAt` das contas.
  - **Postura (T5.8):**
    - nota de cada conta e evolução com uma nota por dia, em 90 dias;
    - reprovações só da última varredura, da mais grave para a menos grave;
    - a nota do cliente soma os pesos aprovados e totais de todas as contas, em vez de tirar média das notas. Por isso a varredura grava os pesos, e o resumo do Prowler passou a devolvê-los.
  - **Ativos (T5.9):** o retrato mais recente de cada conta AWS ativa, com cada item conferido pelo contrato ao ler (item fora do formato não aparece), o risco primeiro e as contagens.
  - **Quem grava postura e inventário:** os jobs do Prowler e do inventário. Sem varredura ou retrato, as telas mostram a conta sem dados.
- **Testes:** 36 novos.
  - Incidentes (11): isolamento A/B, lista e filtros, detalhe, responsáveis, alteração auditada com `resolvedAt`, responsável de outro cliente, permissão e gatilho do banco.
  - Torre, postura e ativos (9).
  - Agrupamento no sync (5): abrir e entrar, baixo sozinho, exceção, lista de proteção e incidente de outro cliente.
  - Pesos da postura e o restante.

  Suíte da API: 626.

- **Pendente:**
  - o resumo MITRE ATT&CK na Torre e o menu Relatórios (próximo passo, pedido do usuário);
  - as telas de auditoria e da fila sem dono;
  - os jobs que gravam postura e inventário.

## Torre com resumo MITRE ATT&CK e menu Relatórios

- **Pedido:** um resumo do MITRE ATT&CK na Torre e um menu Relatórios com os relatórios tradicionais de SOC, para especialistas, sem mudar o conceito do produto. A Torre continua sendo o ponto de partida; os relatórios ficam para quem quer o detalhe.
- **Arquivos:**
  - `packages/shared/src/reports.ts` (+ teste), `tower.ts`, `permissions.ts` (`reports:read`) e `index.ts`;
  - `apps/api/src/reports/reports.{service,controller,module}.ts`, `apps/api/src/tower/tower.{service,module}.ts`, `apps/api/src/app.module.ts` e `apps/api/test/reports.test.ts`;
  - `apps/web/src/features/reports/{labels,csv,reports-api,mitre-grid,report-table}.ts(x)` (+ teste do CSV);
  - `apps/web/src/pages/reports-page.tsx` (+ teste), `tower-page.tsx` (+ teste), `layout/navigation.ts` e `routes/router.tsx`;
  - `apps/web/src/mocks/reports-handlers.ts`, `handlers.ts` e `fixtures.ts`;
  - e2e: `pages.mock.spec.ts` e `layout.mock.spec.ts`.
- **Dependências:** nenhuma. O CSV é gerado no navegador.
- **Como funciona:**
  - **Cálculo único:** todos os números saem de funções puras em `@verax/shared` (`summaryReport`, `mitreReport`, `rulesReport`, `entitiesReport`, `incidentsReport`, `coverageReport`, `exceptionsReport` e `mitreTactics`). A API lê do banco e o modo de demonstração lê das fixtures, e os dois chamam as mesmas funções.
  - **MITRE ATT&CK:**
    - as 14 táticas (Enterprise) na ordem da cadeia de ataque, com achados, incidentes e as técnicas mais vistas;
    - na Torre, os últimos 30 dias, numa grade em que cada célula traz a tática em português, o id, o número de achados e de incidentes e leva ao relatório;
    - a intensidade usa um tom só e sutil: o número está sempre escrito, e o fundo não tira o contraste.
  - **Relatórios** (`GET /v1/reports/:tipo?period=7d|30d|90d`, permissão `reports:read`; 30 dias por padrão):
    - **Resumo do período:** achados por severidade, status, fonte e dia; incidentes abertos e resolvidos; tempo médio até a triagem e até a resolução;
    - **MITRE ATT&CK;**
    - **Detecções:** as regras que mais dispararam, com severidade, contas e última vez;
    - **Entidades:** usuários, IPs, chaves e recursos mais envolvidos;
    - **Incidentes:** por severidade, com o tempo médio até resolver; por responsável; e a lista;
    - **Cobertura das fontes:** cada conta, o último evento e o que chegou por fonte;
    - **Exceções:** quantos alertas cada exceção silenciou no período e no total.
  - **Período:** conta o que começou nele, e os incidentes em aberto entram no resumo.
  - **Tela:** período e aba ficam na URL. As tabelas rolam por dentro no celular. Cada tabela exporta em CSV com o BOM do UTF-8, para o Excel ler os acentos, e neutraliza fórmulas: texto que começa com `=`, `+`, `-`, `@` ou tabulação ganha um apóstrofo, contra injeção de CSV vinda de um nome de usuário ou recurso do alerta.
- **Testes:**
  - 9 nas funções de relatório e 3 no contrato da Torre;
  - 12 na API: cada tipo no contrato, o período, o isolamento entre clientes, o MITRE da Torre e parâmetros inválidos;
  - 13 no front: CSV (com fórmulas neutralizadas), página de relatórios, card MITRE da Torre e menu;
  - e2e: acessibilidade em 3 telas novas e o teste de celular. O teste de celular pegou a tabela alargando a página na grade, corrigido com `min-w-0`.

  Suítes: shared 128, web 175, API 641, e2e da demonstração 22.

  Depois da revisão (Codex e revisão independente com verificação adversarial): cada relatório é calculado achado por achado (`FindingsFold`), e a API lê o período inteiro em lotes por chave, sem teto. A Torre lê só as colunas do MITRE. O cliente entra na chave do cache dos relatórios e a página remonta ao trocar de cliente. Números de outro período ficam marcados e não exportam. O CSV usa `;` e mantém contas AWS como texto.

## Telas de Auditoria e da fila de alertas sem dono

- **Pedido:** fechar o front: a trilha de auditoria (gravada desde a T1.3) e a fila sem dono (T5.2) ganham tela.
- **Arquivos:**
  - `packages/shared/src/{audit,unowned-alerts}.ts` (+ testes) e `index.ts`;
  - `apps/api/src/audit-trail/*` e `apps/api/src/unowned-alerts/*`, `app.module.ts`, `apps/api/test/{audit-trail,unowned-alerts}.test.ts`;
  - `apps/web/src/features/{audit,unowned}/*`, `pages/{audit-page,unowned-alerts-page}.tsx` (+ testes), `layout/navigation.ts`, `routes/router.tsx` e `tower-page.tsx`;
  - `apps/web/src/features/reports/report-table.tsx` (coluna sem CSV fica fora do arquivo);
  - `apps/web/src/mocks/{audit-handlers,unowned-handlers}.ts` e `handlers.ts`;
  - e2e: `pages.mock.spec.ts` e `layout.mock.spec.ts`.
- **Dependências:** nenhuma.
- **Auditoria** (`GET /v1/audit` e `GET /v1/audit/:id`, permissão `audit:read`, só leitura):
  - **Quem vê o quê:**
    - o admin do cliente vê a trilha do próprio cliente;
    - o admin_verax vê a do cliente escolhido ou, sem cliente, a da própria Verax (operações globais e tentativas de login de quem não se identificou).
  - **Equipe da Verax na trilha do cliente:** aparece com o nome e a marca "Verax", sem o IP nem o navegador.
  - **Nomes:** só saem para pessoas do próprio cliente ou da Verax. Um registro que cite pessoa de outro cliente aparece sem nome.
  - **Filtros e detalhe:**
    - filtros por período, área, resultado e pessoa, todos na URL;
    - o detalhe abre num painel lateral, com o estado anterior e o novo, já limpos na gravação;
    - não há rota de escrita.
- **Fila sem dono** (`GET /v1/unowned-alerts` e `GET /v1/unowned-alerts/accounts`, `unowned_alerts:read`, só a equipe da Verax):
  - **Resumo:** as contas que mais aparecem em 30 dias e onde cada uma está cadastrada hoje (a pergunta que a fila quase sempre responde: qual conta falta cadastrar). Exporta em CSV.
  - **Lista:** os alertas, com filtros por motivo, período e conta. Cada motivo vem com o que costuma resolver.
  - A decisão "alertas de conta não cadastrada" da Torre agora leva à fila.
- **Testes:**
  - **API:** 27. Escopo de cada papel, isolamento entre clientes, a Verax sem IP para o cliente, nome de outro cliente que não vaza, filtros, paginação, 404 entre trilhas, 403 por papel, parâmetros inválidos e nenhuma rota de escrita.
  - **Contratos:** 4.
  - **Front:** 13 nas duas telas e o menu por papel.
  - **e2e:** acessibilidade das duas telas e do painel de auditoria, e o teste de celular. A acessibilidade pegou dois problemas, ambos corrigidos: alvo de toque pequeno nos botões de conta e o bloco do estado, que rolava sem receber foco.

## SOC da Verax em operação: coleta da GCP, e-mail pelo Zoho, primeiro admin e pacote do nó

- **Pedido:** deixar o SOC da Verax em operação de fato, com o próprio usuário como primeiro admin e o e-mail que a Verax já usa (Zoho).
- **E-mail:** transporte SMTP (nodemailer 10.3.1, aprovado pelo usuário).
  - TLS sempre: na porta 465 a conexão já começa cifrada; nas outras, o STARTTLS é obrigatório.
  - Certificado conferido e TLS 1.2 no mínimo.
  - Em produção, a configuração aceita `ses` ou `smtp`; o `smtp` exige servidor, usuário e senha.
  - O domínio já tem MX, SPF (`include:zohomail.com`) e DKIM do Zoho.
- **Coleta da auditoria da GCP** (nó sem Wazuh):
  - **Cliente do Pub/Sub:** API REST com o token da identidade da VM (servidor de metadados), sem chave e sem biblioteca do Google.
  - **Regras:** 19 regras próprias (faixa 9901xx), com nível na escala do Wazuh, título em português e MITRE ATT&CK. Cobrem:
    - logs desviados ou apagados;
    - auditoria reduzida;
    - acesso público (`allUsers`);
    - papéis de dono e privilegiados;
    - chave e conta de serviço criadas;
    - firewall aberto para a internet (crítico com SSH, RDP ou todas as portas) e firewall apagado;
    - chave SSH nos metadados;
    - chave KMS destruída;
    - projeto apagado;
    - API desativada;
    - bucket apagado;
    - política da organização alterada;
    - federação de identidade criada ou alterada;
    - VM criada;
    - acesso negado (sem os agentes do Google).
  - **Dono do evento:** cada conta GCP tem a própria assinatura, que diz de qual cliente é o evento; o projeto do `logName` precisa bater com a conta. Evento de outro projeto, sem projeto ou mensagem inválida vai para a fila sem dono.
  - **Gravação:** achado, exceção e incidente na mesma transação, compartilhada com o sync do Wazuh (`finding-store.ts`, extraído sem mudar o comportamento). O lote só é confirmado (ack) depois de gravado, e a releitura não duplica.
  - **Worker:** escolhe as fontes por `SYNC_SOURCES` (`wazuh`, `gcp`).
  - **Contrato:** fonte nova `gcp_audit`, com rótulo na tela e "Regra" em vez de "Regra do Wazuh" onde vale para as duas.
- **Primeiro admin e cliente** (`node-bootstrap`, idempotente):
  - cria o `admin_verax` sem senha e envia o convite (o mesmo link de uso único do painel);
  - cria o cliente do nó e as contas GCP com as assinaturas;
  - tudo na trilha de auditoria como ação do sistema;
  - e-mail de usuário de cliente não vira admin, e conta de outro cliente não muda de dono.
- **Pacote do nó** (`infra/node/`), segundo o teste da imagem no CI:
  - **Compose:** Postgres com TLS e `pg_hba` só `hostssl`, papéis e migrations, API, worker e `cloudflared`. Nenhuma porta publicada; raiz só leitura, sem capabilities e com limite de memória (VM de 1 GB).
  - **`install.sh`:** Docker pelo repositório oficial com a chave conferida; CA do nó (a chave da CA é apagada depois de assinar o certificado do banco); senhas internas geradas uma vez; imagens fixadas pelo digest.
  - **`start.sh`:** monta os arquivos de ambiente em `/run` (memória) com os segredos do Secret Manager.
  - **`backup.sh`:** backup diário para o bucket.
  - **systemd:** serviço e timer.
- **Imagens:** workflow `Imagens do nó` publica no Artifact Registry do nó, sem chave (federação de identidade, environment `imagens`), com atestação de origem.
- **Terraform** (`infra/gcp/`):
  - tópico e assinatura por projeto monitorado;
  - cofre `smtp-password` no lugar do `resend-api-key` (que estava vazio);
  - registro de imagens com limpeza automática, conta de publicação só para este repositório e leitura pela VM.
- **CI:** job novo "Pacote do nó" no `iac.yml` (shellcheck e Compose válida, sem porta publicada e com todos os contêineres da aplicação endurecidos).
- **Testes:**
  - API: SMTP (4), configuração (2), regras e leitura da GCP (41), cliente do Pub/Sub contra um servidor falso (7), sync com o banco (6), bootstrap com o fluxo completo do convite (8);
  - sync do Wazuh, rascunho do achado e incidentes seguem verdes depois da extração.
- **Roteiro:** `docs/runbooks/no-verax.md` (instalação, primeiro acesso, conferência, backup e restauração, problemas comuns).

  Depois da revisão independente (11 achados confirmados, 8 problemas distintos, todos corrigidos):
  - **Chave SSH:** a regra lê os nomes das chaves no delta de metadados do Compute (`protoPayload.metadata`), porque o `request` vem redigido. Também pega OS Login alterado ou apagado.
  - **Assinatura compartilhada por vários projetos do mesmo cliente:** é lida uma vez, e cada evento vai para a conta do projeto dele. Assinatura em clientes diferentes vira origem ambígua.
  - **IAM:** com `serviceData`, só o delta conta (política reenviada sem mudança não é concessão). Sem `serviceData`, o achado tem ID estável por recurso e vínculos.
  - **Operação longa:** o início e o fim viram um achado só (ID da operação).
  - **Token da VM:** só o worker alcança o servidor de metadados (regra no `DOCKER-USER`, IP fixo).
  - **Postgres:** healthcheck por TCP, com tempo de partida.
  - **Imagens conferidas:** o `deploy.sh` confere no GitHub a atestação de cada imagem (workflow, `main` e commit) e instala pelo digest; a VM não confia em tag.
  - **Roteiro:** o primeiro acesso roda dentro da sessão SSH, e a cópia antiga é apagada antes da nova.

  Depois da verificação das correções e do Codex:
  - **Entrada da GCP:** texto grande demais é cortado, não recusado, e as listas não têm limite de quantidade (o Cloud Logging limita a entrada a 256 KB). Assim, um User-Agent enorme ou centenas de chaves de metadados não escondem o evento.
  - **`enable-oslogin` incluído na VM** também conta.
  - **Firewall:** só regra de liberação ativa expõe. Bloqueio (DENY) ou regra desativada, não.
  - **Política sem delta:** o ID estável inclui o dia (UTC), para uma concessão refeita depois de revogada voltar a ser achado.
  - **Operação longa:** o ID é o hash de produtor, ID da operação e regra (sem corte que junte operações diferentes).
  - **Arquivos de ambiente:** valores entre aspas simples (o Compose não interpreta `$`).
  - **`deploy.sh`:**
    - confere a atestação com `gh attestation verify`: assinatura e identidade do workflow, `main`, commit e executor do GitHub;
    - copia com caminho relativo (o pscp do Windows não expande `~`);
    - aceita `node.conf` com CRLF.

## Contas com senha temporária: sem convite por e-mail

- **Pedido:** dispensar o servidor de e-mail. O administrador cria o usuário e recebe uma senha temporária. No primeiro login, a pessoa troca a senha e depois cadastra o MFA.
- **Senha temporária:**
  - 20 caracteres, gerados com `crypto.randomInt`, de um alfabeto de 57 símbolos sem caracteres ambíguos (cerca de 116 bits), em 4 grupos de 5;
  - vale 72 horas;
  - fica só com hash, como qualquer senha. Aparece uma única vez, na resposta de quem criou, e não vai para a auditoria nem para o log.
- **Troca obrigatória** (`mustChangePassword`):
  - **API:** a sessão só alcança a identidade (`/v1/me`), o token CSRF e `change-password`. O resto responde 403 `PASSWORD_CHANGE_REQUIRED`, inclusive o cadastro do MFA e as rotas de sessão da autenticação.
  - **Depois da troca:** a senha temporária deixa de valer e a regra do MFA obrigatório segue como antes.
  - **Vencida:** a sessão vale como inválida (401).
  - **Pelo link de redefinição** (quando houver e-mail): também encerra a temporária.
- **API de usuários:**
  - `POST /v1/users` cria a conta já ativa, com a senha temporária na resposta (`user.create` na auditoria);
  - `POST /v1/users/:id/temporary-password` gera outra para quem esqueceu (`user.temporary_password`): a anterior e as sessões abertas caem, o bloqueio por tentativas zera e o MFA cadastrado continua;
  - recusa para a própria conta (403) e para conta desativada (409);
  - o convite por e-mail e o reenvio saíram. Conta do antigo convite, ainda sem senha, fica ativa ao receber a temporária.
- **Painel:** "Criar usuário" e "Gerar senha temporária" mostram a senha uma vez, com botão de copiar. A tela `/trocar-senha` é aberta antes de qualquer outra quando a troca é obrigatória.
- **Primeiro admin do nó (`node-bootstrap`):**
  - cria o `admin_verax` com senha temporária;
  - se ele ainda não entrou, gera outra a cada execução;
  - se ele já definiu a própria senha, não muda nada.
  - O `start.sh` grava a senha em `/root/verax-senha-temporaria` (só root) e não a mostra na tela.
- **E-mail opcional:** `MAIL_TRANSPORT=none` é aceito em produção. Com `smtp`, a redefinição pelo link volta a funcionar. O `install.sh` só exige os dados da caixa de envio com `smtp`.
- **Testes:**
  - API: senha temporária (11), redefinição pelo link (antigo teste do convite), usuários, bootstrap, configuração e senha vazada;
  - painel: troca obrigatória, criação com a senha mostrada uma vez, geração de senha nova e modo demonstração;
  - e2e contra a API real: o admin cria a conta na tela, a pessoa entra com a temporária, troca a senha, cadastra o MFA, e a temporária deixa de valer.
- **Rota `/convite` removida:** nenhum convite chegou a ser enviado em produção.
- **Correção: painel lateral com a CSP de produção.** O `Dialog.Overlay` do Radix trava a rolagem injetando um `<style>`, que a CSP (`style-src 'self'`) recusa. Era assim em todos os painéis laterais: em produção, a página de trás rolava e o console mostrava a violação. O fundo agora é uma `div` comum, e a trava fica numa regra do `index.css`; o foco preso, o Esc e o `aria-hidden` seguem com o `Dialog.Content`. O e2e confere que não há violação e que a página trava.

  Depois da revisão independente (17 achados, 10 confirmados, todos de gravidade baixa, todos corrigidos):
  - **Senha nova igual à temporária:** a API recusa (`PASSWORD_UNCHANGED`); antes, só a tela barrava, e a troca obrigatória podia manter a senha temporária como definitiva.
  - **Login com a senha temporária vencida:** recusado já no login e na verificação do código, com o motivo (`TEMPORARY_PASSWORD_EXPIRED`, que só chega a quem acertou a senha) e "negado" na auditoria. Antes, o login dava 200, entrava como sucesso e a tela dizia "senha incorreta".
  - **Uma transação só:** a senha temporária, a marca, a queda das sessões e o fim do bloqueio entram juntos, na transação da requisição, com o registro de auditoria no mesmo commit.
  - **Auditoria:** valores booleanos não são mais ocultados pelo sanitizador (um sim ou não não é segredo). A marca `mustChangePassword` aparece antes e depois.
  - **Bootstrap:**
    - se uma execução parar entre criar a conta e gravar a senha, a próxima gera a senha;
    - saída de emergência `BOOTSTRAP_RENEW_ADMIN_PASSWORD=true` para o admin que esqueceu a senha num nó sem e-mail. Só como root na VM; o MFA continua;
    - admin desativado: a saída de emergência recusa;
    - as linhas da senha nunca vão para a tela, mesmo se o bootstrap falhar no meio.
      Depois da verificação das correções (5 confirmados, 1 de gravidade média, todos corrigidos):
  - **Saída de emergência:** sem cliente, o `start.sh` escreve a linha `BOOTSTRAP_TENANT_NAME` vazia, e o bootstrap a recusava. Vazia agora vale como ausente, com teste do que o `start.sh` escreve.
  - **Senha nova igual:** comparada como a biblioteca guarda (NFKC), na API e na tela. A mesma senha em caracteres de largura total vira o mesmo hash e também é recusada.
  - **Recusa auditada:** a recusa `PASSWORD_UNCHANGED` acontece antes do hook que audita a troca, então ela mesma registra a falha.
  - **Conta nasce sem acesso:** o usuário (e o primeiro admin) é criado como `invited` e só fica ativo junto com a senha, na mesma transação. Se ela falhar, sobra uma conta que não entra.
  - **Duas gerações simultâneas:** a linha do usuário é travada primeiro, sem duas contas de senha para a mesma pessoa.
  - **Fora:** a redefinição pelo link (só com e-mail ligado) não confere se a senha nova repete a temporária. O link chega só ao dono da conta, e a biblioteca não expõe a senha nesse ponto.

## Correção: segredo ausente no nó e partida sem o túnel

- **Problema (desde o pacote do nó):** com `set -e`, um `$(...)` usado como argumento de outro comando não interrompe o script quando falha. Os segredos lidos assim (senhas da sessão e do CSRF, senha do e-mail e token do túnel) saíam vazios no arquivo de ambiente, sem erro. Com o cofre do túnel vazio, o `cloudflared` subia com o token vazio e ficava reiniciando, ao contrário do que o roteiro dizia.
- **Correção:**
  - cada segredo é lido numa atribuição própria, e uma falha para a partida;
  - com o cofre do túnel ainda sem valor (`NOT_FOUND`), o nó sobe sem o `cloudflared`, com aviso no journal e no fim do `deploy.sh`. Banco, API e coleta rodam, e o primeiro acesso (bootstrap) já pode ser feito. Com o token gravado, `systemctl restart verax-node` liga o túnel;
  - qualquer outro erro na leitura do cofre (permissão, rede, valor inválido) para a partida e mostra o motivo que o gcloud deu (antes, o erro era descartado). Assim, uma falha passageira numa reinicialização não derruba um túnel que funcionava.
- **Testes:** shellcheck limpo; o comportamento do `set -e` foi conferido no bash (antes: seguia com o valor vazio e saía com 0; agora: sai com 1).

## Identidade visual do site no painel

- **Pedido:** o painel usa a identidade visual do site da Verax e a logo dela.
- **Marca:** a logo do site (palavra VERAX e símbolo X) virou componente SVG em linha (`currentColor`, nos dois temas). A marca do painel é "VERAX | CONTROL", no padrão do "VERAX | SISTEMAS" do site. Aparece na barra lateral, numa faixa no celular e nas telas de entrada. O favicon é o do site.
- **Tokens** a partir das cores do site, escolhidos à mão em cada modo:
  - claro: fundo papel, superfícies brancas, tinta navy e primário `#315add` (texto branco a 5,8:1; o `#426dff` do site daria 4,3:1);
  - escuro: fundo e superfícies navy, primário `#86a7ff` com texto navy;
  - a barra lateral fica no navy do site nos dois modos;
  - fonte Inter (só a pilha, sem baixar fonte);
  - as cores de severidade não mudaram (validação de daltonismo refeita com as superfícies novas).
- **Texto em vermelho:** novo token `--critical-text`, para erros de formulário e valores de risco. A cor da severidade fica em ~3,1-3,6:1 sobre as superfícies do escuro (já era assim antes); o token novo passa de 5,5:1. Ícones e marcas seguem com a cor da severidade.
- **Mapa do MITRE:** as intensidades usam a tinta neutra, porque o azul da marca ficava perto do azul do "baixo".
- **Testes:** o axe passa a rodar em todas as telas nos dois temas (antes, só no claro: foi assim que o contraste do texto vermelho no escuro passou despercebido). Resultado: 45 e2e da demonstração, 7 contra a API real com a CSP de produção e 212 unitários.

## Tour guiado na demonstração

- **Pedido:** um tour guiado na demonstração comercial para conhecer o sistema completo.
- **Abertura e retomada:**
  - abre sozinho no primeiro acesso, na Torre;
  - pode ser retomado pelo botão "Fazer o tour" da faixa da demonstração;
  - o progresso fica no `localStorage`.
- **Passos:** 18 para o admin da Verax e 14 para a analista (os passos de telas que o papel não abre saem). Cada passo destaca o elemento real da tela.
- **Exemplos:** o incidente e o achado mostrados vêm do cliente da sessão, buscados na hora. Com outro cliente selecionado, o exemplo é dele. Sem nenhum, o passo fica na lista.
- **Escopo:** só no modo `mock`. O build de produção não contém o código nem os textos do tour.
- **Dependências e CSP:** nenhuma dependência nova e nenhum `<style>` injetado (CSP de produção).
- **Acessibilidade:** o cartão é um diálogo com título e descrição (a contagem do passo e a explicação); o foco volta ao lugar de origem ao encerrar; Esc e as setas funcionam; respeita a preferência por menos movimento.
- **Textos da interface sem "SOC" nem "Wazuh":** a demonstração é vitrine, e o posicionamento não usa esses termos. Mudaram:
  - o subtítulo de Relatórios;
  - o rótulo da regra no detalhe do achado ("Regra (logs da AWS)");
  - as dicas da fila sem dono e de Exceções;
  - o estado vazio de Achados.
- **Testes:**
  - 244 unitários do painel;
  - 52 e2e da demonstração, com o tour completo nos dois papéis, o axe no cartão nos dois temas, o celular, a reabertura e o exemplo do cliente Beta.

## Correção: `deploy.sh` sem o PuTTY

- **Problema:** no Windows, `gcloud compute ssh` abre o PuTTY numa janela, e o `deploy.sh` ficava parado esperando. Foi o que travou o primeiro deploy do nó.
- **Correção:** o deploy usa um túnel do IAP até a porta 22 e o OpenSSH da máquina, igual em Windows, macOS e Linux.
  - A chave SSH é criada só para a execução, registrada no OS Login por 1 hora e removida no fim, mesmo com erro.
  - A chave do servidor fica num `known_hosts` próprio da VM: a primeira execução registra, as seguintes conferem.
- **Testado:** um deploy real no nó da Verax, com a mesma versão. Atestações conferidas, pacote copiado, serviço reiniciado; no fim, nenhuma chave temporária nem túnel sobrando.

## Fase 2, PR-02: agendador do worker, cursor dos coletores e estado da conexão das contas

- **Pedido:** a base comum dos coletores da fase 2 (plano da fase 2, PR-02 e conflitos C4, C5 e C13).
- **Agendador** (`apps/api/src/worker/scheduler.ts`), no lugar do laço sequencial do `worker.ts`:
  - cada tarefa tem nome, intervalo e orçamento de tempo próprios, e roda no próprio laço;
  - tarefas diferentes rodam ao mesmo tempo; a mesma tarefa nunca roda duas vezes ao mesmo tempo (o intervalo conta do fim de uma execução ao começo da próxima);
  - a parada aborta o sinal (`AbortSignal`) das execuções em curso e espera todas terminarem;
  - o orçamento estourado vai para o log e aborta o sinal da execução; a próxima só começa quando ela terminar;
  - a exceção vai para o log só pelo tipo (nunca a mensagem nem a pilha) e não derruba o laço.
  - Os syncs do Wazuh e da GCP viram as tarefas `wazuh` e `gcp`, com `SYNC_INTERVAL_SECONDS` e orçamento de 5 min (a validade da concessão). Comportamento igual ao de antes: rodam ao iniciar, não interrompem no meio e a concessão no banco continua valendo entre réplicas.
  - **Pool do banco:** 10 conexões por processo, agora fixadas em `PrismaService` (era o padrão implícito do `pg`). O Postgres do nó aceita 40.
- **Cursor** (`model CollectorCursor` e `apps/api/src/collectors/collector-cursor.ts`):
  - um por conta, fluxo e região (`@@unique`), com índice por fluxo e próxima leitura; apagar a conta apaga os cursores (cascade);
  - sem `tenantId`: é dado de sistema, e o escopo do cliente recusa o model;
  - `read` cria o cursor vazio na primeira vez; `due` lista os vencidos de contas ativas; `advance` só anda para a frente, guarda a continuação e zera as falhas; `fail` guarda só o tipo do erro, não mexe na posição e recua (1 min, dobrando, até 1 h; ou a hora pedida pela fonte).
  - Os coletores novos usam o cursor a partir do PR-08.
- **Estado da conexão na `CloudAccount`:** `connection` (`waiting`, `connected`, `error`), `connectionError` (só o tipo do erro, até 64 caracteres) e `lastCollectedAt`.
  - **Migration** `20261103130000_collector_cursor_connection`: contas da GCP que já tinham `lastEventAt` nascem `connected`.
  - **Sync da GCP:** cada assinatura lida sem erro marca as contas dela como `connected`, com a hora da coleta, haja evento ou não; a que falha marca `error` com o tipo do erro, sem mexer na última coleta. Assinatura em dois clientes vira `error` (`ambiguous_source`).
  - **API e contrato:** a conta devolve os três campos (a conexão deixa de ser opcional). Nenhum deles é aceito no cadastro nem na alteração. Trocar a assinatura do Pub/Sub volta a conexão para `waiting`, com o antes e o depois na auditoria.
  - **Torre:** "Contas conectadas" conta as contas `connected`; a cobertura ganha "Última coleta"; conta silenciosa é a que não coleta com sucesso há mais de 24 h. O evento recebido também vale como sinal de vida (só chega por uma leitura que deu certo), que é o único sinal das contas lidas pelo Wazuh.
  - **Painel:** selo "Aguardando / Conectada / Erro" em Contas cloud; o detalhe explica o estado, mostra o tipo do erro e a última coleta. Os passos da GCP e do Cloudflare dizem que a conta conecta na primeira leitura, mesmo sem evento. Os mocks da demonstração têm os campos novos (a homologação da Alfa aparece com erro).
- **Gravação de achados com tarefas ao mesmo tempo:** `FindingStore.persist` toma um lock transacional por cliente. Sem ele, dois achados do mesmo cliente com a mesma chave, gravados juntos por coletores diferentes, abriam dois incidentes (o teste novo falha sem o lock).
- **Testes:**
  - agendador com relógio falso (7): tarefa lenta não atrasa outra, nunca duas execuções da mesma, a parada espera as execuções em curso, exceção não derruba o laço e vai para o log só pelo tipo, orçamento estourado registrado, interrupção pela parada e validação;
  - tipo do erro (3);
  - integração com o banco: cursor (9: unicidade, cascade, leitura, avanço, falha e recuo, vencidos, formato e escopo), sync da GCP (conectada, erro com o tipo e conectada de novo, sem mexer na conta de B; origem ambígua), API de contas (conexão devolvida, não gravável pela API, troca de assinatura e A/B), Torre (cobertura pela última coleta e A/B) e achados concorrentes (2);
  - os testes atuais do Wazuh e da GCP passam sem mudança;
  - painel: selo, detalhe, troca de assinatura e cobertura da Torre.
  - Resultado: API 64 arquivos e 801 testes; painel 248 unitários e 52 e2e da demonstração; lint, tipos e Prettier limpos.

  Depois da revisão independente (6 correções, todas aplicadas). Contexto de produto: a AWS é lida pelo Wazuh e a GCP pelo Pub/Sub, as duas entregues por evento, e uma leitura vazia não prova que os logs chegam (sink apagado, trilha parada); o Cloudflare (PR futuro) é coletado por API, e a leitura bem-sucedida prova que a conta está acessível, mesmo sem evento.
  - **Agendador:** só o erro do próprio cancelamento vai para o log como "tarefa interrompida": o motivo do sinal, ou um `DOMException` `AbortError`/`TimeoutError`, com o sinal abortado. Qualquer outro erro é "tarefa falhou", mesmo depois do estouro do orçamento ou do começo da parada.
  - **O evento conecta a conta:** `LastEvents.save` passa de `waiting` para `connected` as contas ativas que receberam evento, na AWS (Wazuh) e na GCP. Nunca tira a conta do `error`: isso é do sync da fonte. Antes, as contas lidas pelo Wazuh nunca ficavam "Conectada", e a Torre mostrava 0 contas conectadas com eventos chegando.
  - **GCP, leitura vazia não é sinal de vida:** a leitura sem erro grava a coleta e limpa o erro em todas as contas da assinatura, mas só fica `connected` a que já tem `lastEventAt`. A que nunca recebeu evento fica `waiting`, e o primeiro evento a conecta no fim da mesma execução.
  - **Torre:** o sinal de vida depende do provedor. AWS e GCP: só o último evento. Cloudflare e os demais coletados por API: o mais recente entre a última coleta e o último evento. `AccountActivity` ganhou o provedor.
  - **Só erro da fonte vira erro de conexão:** o `pull` e o `acknowledge` do Pub/Sub lançam `SourceReadError`, com o erro original em `cause`, e o `connectionError` é o tipo dele. Erro interno (banco, concessão, gravação do achado) conta em `failedSubscriptions` e em `SyncState.lastError`, sem mexer na conexão da conta.
  - **Migration** (ainda não aplicada em produção): nasce `connected` só a conta ativa com `lastEventAt` da AWS, ou da GCP com assinatura do Pub/Sub. O banco de teste é recriado a cada execução da suíte, então o checksum novo não pesa.
  - **Desativar ou reativar** a conta (exclusão lógica, ou `status` na alteração) volta a conexão para `waiting`, sem erro, com o antes e o depois na auditoria. O mock da demonstração faz o mesmo na alteração.
  - **Painel:** os textos dizem que a conta AWS e a GCP conectam quando o primeiro evento chega, e o Cloudflare na primeira leitura bem-sucedida. O aviso da Torre volta a "sem eventos há mais de 24 horas", que vale para todo provedor. Os mocks da demonstração já estavam coerentes: as contas AWS e GCP "Conectada" têm evento recente.
  - **Testes novos:** agendador (2: erro comum depois do estouro do orçamento e durante a parada); Torre (GCP com coleta recente e evento antigo é silenciosa; Cloudflare com coleta recente e sem evento não é; AWS conectada pelo evento); integração do Wazuh (o evento conecta a conta em `waiting`, a em `error` continua); GCP (leitura vazia mantém `waiting` a conta sem evento e deixa `connected` a com evento, mesmo vindo de erro; falha no acknowledge; erro interno não mexe na conexão); API de contas (desativar e reativar, com auditoria).
  - **Testes ajustados à regra nova:** a leitura vazia da GCP não conecta mais; a cobertura da Torre (unitária e de integração) por provedor; a troca de assinatura agora usa conta com evento, para o sync da GCP concorrente não mudar a conexão no meio; o painel confere os textos novos.
  - Resultado: API 64 arquivos e 809 testes; painel 248 unitários e 52 e2e da demonstração; lint, tipos e Prettier limpos.

## Fase 2, PR-01': nó de cliente com Wazuh na GCP, usuário IAM com chave e cofre

- **Pedido:** registrar na arquitetura as decisões de 04/11/2026 antes do código (plano revisado da fase 2, PR-01').
- **Decisões (04/11/2026):**
  - todo nó de cliente roda na GCP, em São Paulo, com o Wazuh completo (manager e indexer, sem dashboard) numa e2-standard-2. O nó da Verax segue enxuto (`lean`, e2-micro, sem Wazuh);
  - a AWS do cliente é lida com um usuário IAM de leitura, com chave restrita ao IP do NAT do nó. O responsável aceitou o risco, com as mitigações listadas na arquitetura;
  - o Cloudflare é lido pela API dele, com o token no cofre do nó; a GCP do cliente, pelo Pub/Sub;
  - sem venda assistida: a primeira venda vem depois do provisionamento automático (fase 3).
- **Arquivos:** `docs/ARQUITETURA.md`, `docs/runbooks/onboarding-cliente.md`, `README.md`, `docs/STATUS.md`. O `PLANO.md` não foi editado (regra 9).
- **O que mudou em `docs/ARQUITETURA.md`:**
  - princípios 1 a 4: nó na GCP pelo Terraform, um cliente por nó, usuário IAM de leitura no lugar do papel com ExternalId, template que só cria o usuário, o grupo e as políticas;
  - diagrama: VM na GCP, Wazuh sem dashboard, sem Prowler, Cloud NAT com IP reservado e cofre;
  - fontes: só buckets S3 (CloudTrail, export do GuardDuty e WAF opcional); CloudWatch Logs, Security Hub e Inspector fora da v1; retenção de 30 dias no índice do Wazuh;
  - acesso: IAP com OS Login no lugar do SSM; sem dashboard do Wazuh; metadata só para o worker;
  - a regra "Nenhum guarda credencial" passa a "AWS e Cloudflare: credencial de leitura cifrada no cofre do nó";
  - SOC da Verax: perfil `lean`; nós de clientes com o Wazuh;
  - Cloudflare nativo (auditoria v2 e eventos de segurança por GraphQL), com o Logpush fora da v1;
  - custos por perfil, com os números do plano revisado (sem as margens);
  - ordem: os passos da decisão de 02/11 com a situação de cada um, os blocos da fase 2 e a fase 3;
  - seções novas: "Perfis de nó (`lean` e `standard`)", "Cofre de credenciais" e "Por que usuário IAM com chave", com os riscos residuais e a mitigação de cada um.
- **Dependências:** nenhuma.
- **Testes:** só documentação, sem teste automatizado aplicável. Prettier limpo.
- **Definição de pronto:** texto ✔ · Prettier ✔ · nenhuma dependência ✔ · regras de segurança ✔ (nenhum dado real de cliente ou de conta) · **aceite:** o responsável aprova o texto.
- **Pendências para o responsável:**
  - a estimativa do nó `lean` em `infra/gcp/GUIA.md` (R$ 5 a 15 por mês) não conta o IP do Cloud NAT, de cerca de R$ 20 por mês; conferir na fatura;
  - `infra/cloudformation/GUIA-NO.md` ainda aponta para a estimativa de custo da pilha na AWS, que agora é só uma referência no fim da seção de custos;
  - `docs/runbooks/onboarding-cliente.md`: as seções 3 e 4 ganharam só o aviso de desatualizadas. A reescrita entra com o template do usuário de leitura e a chave no painel (PR-V2 e PR-V3);
  - **swap cifrado (decisão nova, a confirmar):** o PR-04' troca o swap em claro do `startup.sh` por swap cifrado com chave aleatória a cada boot, nos dois perfis, e recria o arquivo de swap na troca. Os snapshots do nó da Verax tirados antes da troca (até 28 dias) guardam o swap antigo, que pode ter páginas em claro, até expirarem;
  - **checagem de permissão demais (desvio do plano revisado, PR-V3 passo 5 e PR-V5):** a simulação passa o IP do NAT do nó em `aws:SourceIp` e testa também leitura fora da política (um bucket não cadastrado e o Secrets Manager). Sem o IP no contexto, o Deny de IP (`NotIpAddress`) pode negar tudo e esconder a permissão a mais; sem as leituras, um `ReadOnlyAccess` anexado sem o boundary passaria.

  Depois da revisão independente (6 achados confirmados, todos de gravidade baixa, todos corrigidos):
  - **Roteiro de onboarding e README:** as seções 3 e 4 do `onboarding-cliente.md` (nó na AWS, conector com ExternalId, CloudWatch Logs) ganharam o aviso de que foram substituídas pela revisão de 04/11, com o resumo da arquitetura nova e a ordem de não pedir ao cliente as pilhas antigas. O `README.md` não cita mais o Prowler.
  - **Swap e snapshots:** a frase "os backups e snapshots levam só texto cifrado" não valia: o tmpfs com a chave privada e a chave da AWS e a memória do worker e do manager podem ir para o swap em claro, no disco do snapshot. O desenho passa a ter swap cifrado com chave aleatória a cada boot nos dois perfis, a frase diz por que vale, e o risco entrou na tabela.
  - **Permissão demais:** "nenhuma permissão além da política" prometia mais do que a simulação de algumas ações entrega. O texto diz que é uma amostra (escrita, IAM, KMS e leitura fora da política), com o IP do nó no contexto, e que permissão fora dela não é detectada; a tabela de riscos diz o mesmo.
  - **O que já existe e o que é alvo:** a introdução diz que a revisão de 04/11 é o desenho-alvo da fase 2, e as seções dela levam a marca _(fase 2, a construir)_. O perfil "passa a ser" uma variável do Terraform.
  - **Pub/Sub:** quem lê a assinatura é o worker, o único que alcança o metadata da VM, e não a API (também no SOC da Verax).
  - **Cloudflare:** uma parada do nó só não perde dados se for mais curta que a janela de retenção da zona (`notOlderThan`, de até 31 dias, conforme o plano).

## Fase 2, PR-03: plano do nó e medidor de uso

- **Pedido:** o plano do nó e o medidor de GiB por mês (plano da fase 2, PR-03, com a mudança do plano revisado: a fonte `aws` do medidor vem depois, pelo Wazuh do nó, no PR-V6). Sem tela e sem rota nova: a página "Plano e uso" e o `GET /v1/plan` ficam para o PR-18.
- **Planos** (`packages/shared/src/plans.ts`):
  - Essencial: 3 contas cloud, 5 usuários, 15 GiB por mês e 90 dias de histórico;
  - Profissional: 15, 15, 60 e 365;
  - Enterprise: sem padrão, os quatro limites vêm sempre dos ajustes;
  - Interno (o nó da própria Verax): sem limite nenhum, e não aceita ajuste.
  - Os ajustes trocam só o limite informado (extras como "conta extra" ou "+10 GiB"), cada um numa faixa: contas e usuários de 1 a 1000, GiB de 1 a 100.000 e histórico de 30 a 3650 dias (o piso evita apagar dados por engano no expurgo).
  - Exporta o id, o rótulo, os limites, o schema zod dos ajustes e do plano resolvido, e `resolvePlan`.
- **Ambiente** (parte comum da API e do worker, `env.schema.ts`):
  - `PLAN` obrigatório em produção; fora dela, o padrão é `interno`;
  - `PLAN_MAX_CLOUD_ACCOUNTS`, `PLAN_MAX_USERS`, `PLAN_MONTHLY_GIB` e `PLAN_HISTORY_DAYS`, opcionais, validados pela faixa; o `enterprise` exige os quatro e o `interno` recusa qualquer um;
  - as mensagens citam só o nome da variável, como as outras; `nodePlan(config)` devolve o plano em vigor. O worker registra o plano no log de partida.
- **Medidor** (`apps/api/src/usage/usage-meter.ts` e `model IngestUsage`):
  - uma linha por cliente, mês e fonte (`@@id([tenantId, month, source])`), com `bytes` e `events` em `BigInt`; o model entra em `TENANT_SCOPED_MODELS`, e toda escrita passa por `forTenant`;
  - mês do calendário de Brasília: a virada é às 03:00 UTC do dia 1º (UTC-3 fixo, sem horário de verão);
  - regra única do GiB: bytes UTF-8 de cada registro como a fonte entrega, já descompactado, contando todo registro lido, inclusive o que nenhuma regra acusa;
  - o coletor soma em memória e grava com `flush` só depois de confirmar a leitura: uma escrita (upsert com incremento) por cliente, mês e fonte. O que já foi gravado sai do medidor, então repetir o `flush` depois de uma falha no meio não conta duas vezes;
  - ganchos para as próximas fontes, descritos no próprio arquivo: `aws` pela tarefa `wazuh-usage` (PR-V6, diferença do `bytes.received` do analysisd) e `cloudflare` pelo coletor nativo (`utf8Bytes` do corpo, depois de avançar o cursor).
  - **Migration** `20261104100000_ingest_usage`: a tabela, a chave estrangeira para `Tenant` e dois CHECK (o mês é sempre o dia 1º; os contadores nunca ficam negativos).
- **Sync da GCP:** depois do ack de cada lote, mede o `data` de toda mensagem do lote (inclusive a inválida, a sem dono e a que nenhuma regra acusa) para o cliente da assinatura. A assinatura cadastrada em mais de um cliente não conta para nenhum. O lote que falha antes do ack não conta: volta pelo Pub/Sub e é medido quando for confirmado. Uma reentrega de mensagem já confirmada conta duas vezes ("uso justo").
- **Bootstrap do nó:** grava o rótulo do plano (`Essencial`, `Profissional`, `Enterprise` ou `Interno`) em `Tenant.plan` ao criar o cliente; com o `PLAN` trocado, atualiza na próxima execução, com o antes e o depois na auditoria. Quem vale é o ambiente; o cadastro só mostra.
- **Pacote do nó (`infra/`, revisar linha a linha):**
  - `start.sh`: escreve `PLAN` e os ajustes definidos no `api.env` e no `worker.env`; sem `PLAN` no `node.conf`, a partida para com mensagem;
  - `install.sh`: `PLAN` entra nos obrigatórios, com o nome conferido; no `enterprise`, os quatro ajustes também;
  - `node.conf.example`: `PLAN=interno`, com os ajustes comentados;
  - `infra/terraform/modules/api/main.tf`: a tarefa da API na AWS (implantação com vários clientes, não aplicada) ganha `PLAN=interno`, para continuar subindo;
  - `scripts/test-api-image.sh` (teste da imagem no CI): `PLAN=interno` no contêiner de produção;
  - roteiro `docs/runbooks/no-verax.md`: o `node.conf` precisa de `PLAN=interno` antes do próximo deploy.
- **Testes:**
  - planos (12): tabela comercial, interno sem limite e sem ajuste, enterprise com os quatro ajustes, ajuste parcial, faixas, contrato e rótulo;
  - ambiente (7): `PLAN` ausente em produção, padrão `interno`, enterprise sem os ajustes e com eles, ajuste no Essencial, valores inválidos e o mesmo no worker;
  - medidor sem banco (9): virada do mês às 03:00 UTC e do ano, bytes UTF-8 e base64, validação, uma escrita por chave e falha no meio;
  - medidor com banco (6): soma e incremento, virada do mês, volume acima de 32 bits, A/B (o uso de B nunca conta para A; o escopo de A não grava nem altera a linha de B) e os CHECK;
  - sync da GCP (4): mede toda mensagem lida depois do ack, sem contar para o cliente do projeto intruso; lote que falha antes do ack (gravação ou ack) não conta e, confirmado depois, conta uma vez; mês da execução com a virada; assinatura ambígua não conta para ninguém;
  - bootstrap (3): rótulo gravado e atualizado com auditoria, cliente de antes do plano, sem cliente nada é gravado;
  - shellcheck limpo no pacote do nó e no teste da imagem.
  - Resultado: API 66 arquivos e 838 testes; compartilhado 147; painel 248 unitários (o painel não mudou); lint, tipos e Prettier limpos.
- **Desvios:**
  - o medidor da GCP grava depois de cada ack (uma escrita por lote), e não uma vez no fim da execução: uma falha mais adiante na execução não perde o que já foi confirmado;
  - o `.env.example` não foi alterado; fora de produção o padrão é `interno`, então o ambiente local não muda.
- **O que testar manualmente:** acrescentar `PLAN=interno` ao `node.conf` do nó da Verax antes do próximo deploy; depois do deploy, conferir no journal que a API e o worker subiram (o log do worker mostra `plan`) e rodar o bootstrap uma vez para o cadastro do cliente Verax mostrar "Interno".
- **Riscos:** a reentrega do Pub/Sub conta duas vezes (documentado como "uso justo"); se a gravação do uso falhar depois do ack, aquele lote fica sem medir (a favor do cliente) e a assinatura conta como falha interna na execução.

## Correção: teste do bloqueio do MFA intermitente no CI

- **Problema:** de vez em quando, o teste "depois de 5 códigos errados, nem o código certo entra" (`auth-mfa.test.ts`) falhava no CI: o código certo abria sessão em vez de responder 429. O bloqueio da conta não tinha defeito. O teste "o link expira" (`auth-password-reset.test.ts`) vencia **todas** as linhas de `Verification`, e o banco de teste é o mesmo para os arquivos que rodam em paralelo. Na consulta seguinte, o Better Auth apaga o que venceu, e isso levava junto o desafio de MFA e o contador de tentativas de outro teste.
  - Os códigos errados seguintes respondiam `INVALID_TWO_FACTOR_COOKIE` (401, sem avaliar o código e sem contar para o bloqueio), e o teste só conferia o 401.
  - O mesmo efeito já tinha derrubado "a senha sozinha não abre sessão; o código abre" (o código certo recebeu 401).
  - As falhas começaram depois do PR #35, que encolheu o arquivo da redefinição e o fez coincidir com o do MFA.
- **Correção (só nos testes; produto, configuração do bloqueio e do Vitest sem mudança):**
  - "o link expira" vence só o link da própria pessoa (`where: { value: id }`) e confere que tocou exatamente uma linha;
  - o mesmo teste prova que o link de outra pessoa continua valendo depois da limpeza. Com a linha antiga ele falha sempre, sem depender de tempo;
  - o teste do bloqueio confere o motivo de cada recusa (`INVALID_CODE`) e, no banco, que a conta ficou com 5 falhas e bloqueada. Se algo voltar a derrubar o desafio, a falha aponta a causa no laço, e não parece defeito do bloqueio. "Código errado não abre sessão" também confere o motivo.
- **Testes:**
  - a versão nova de "o link expira" falhou com a linha antiga (o link da outra pessoa voltou 400) e passa com a correção;
  - corrida reproduzida com dois arquivos temporários em paralelo (fora do commit), um repetindo o bloqueio e outro vencendo links. Vencendo tudo: 6 de 30 bloqueios falharam em cada uma de 2 execuções, com o sintoma do CI (200 no lugar de 429, `INVALID_TWO_FACTOR_COOKIE` nos códigos errados). Vencendo só o link da pessoa: 0 de 90 em 3 execuções;
  - os 7 arquivos `auth-*` (4 processos em paralelo) rodaram 16 vezes seguidas: 12 verdes e 4 com a queda conhecida do processo do Vitest no Windows (código 3221226505 ao subir o arquivo, sem nenhuma asserção falhando);
  - API completa: 66 arquivos e 838 testes; lint, tipos e Prettier limpos.
- **Nota:** duas suítes rodando ao mesmo tempo com o mesmo `TEST_DATABASE_URL` se derrubam, porque o `global-setup` recria o schema a cada execução. Para rodar em paralelo (outra cópia do repositório, por exemplo), use um banco `_test` para cada uma.

## Fase 2, PR-W2: leitura do indexer no nó e chave estável do achado

- **Pedido:** a API e o worker leem o indexer do Wazuh do próprio nó de cliente (perfil `standard`), e o achado do Wazuh ganha uma chave que não duplica quando o mesmo evento volta ao indexer (plano revisado da fase 2, PR-W2). O código não depende do PR-W1; o aceite no nó, sim.
- **Modo nó do indexer** (`apps/api/src/indexer/indexer.config.ts` e `indexer-secrets.ts`):
  - `INDEXER_AUTH` escolhe o modo, e os dois nunca se misturam: `aws` (Secrets Manager e SSM, como antes) recusa `INDEXER_USERNAME`, `INDEXER_PASSWORD` e `INDEXER_CA_FILE`; `node` exige essas três e recusa `INDEXER_CREDENTIALS_SECRET_ARN` e `INDEXER_CA_PARAMETER`. A recusa vale em todo ambiente, não só em produção;
  - sem `INDEXER_AUTH`: em produção, `aws` (a implantação na AWS não muda); fora dela, `aws` se houver variável da AWS, senão `node` (o ambiente local não muda);
  - em produção, a senha do modo nó precisa de 16 caracteres ou mais, o mesmo piso do segredo do Secrets Manager. As mensagens citam só o nome da variável;
  - a CA do modo nó (o arquivo do volume público dos certificados, montado só leitura) é lida a cada conexão nova, e não na partida: na primeira subida do nó, a API e o worker sobem antes de o Wazuh gerar os certificados. Até lá, a tarefa `wazuh` falha e tenta de novo no intervalo, e o detalhe do achado sai sem o evento bruto;
  - TLS com `rejectUnauthorized: true`, timeout e renovação da credencial no 401 seguem iguais (`indexer.client.ts` não mudou). `EnvIndexerSecrets` virou `NodeIndexerSecrets`.
- **Fontes** (`infra/node/node.conf.example`, revisar linha a linha): o comentário documenta `SYNC_SOURCES=gcp,wazuh` no nó de cliente e `gcp` no nó da Verax (`lean`), sem nenhuma variável do indexer. O valor do exemplo continua `gcp`, e o `start.sh` não mudou: o nó da Verax segue igual. Escrever `INDEXER_*` no `api.env` e no `worker.env` fica para o PR-W1, que gera a senha e o volume da CA.
- **Chave do achado** (`apps/api/src/alerts/wazuh-alert.ts` e `finding-draft.ts`): `sourceEventId` passa de `alert.id` a `wazuh/<conta>/<tipo>:<id>:<regra>`:
  - o id é o do evento na AWS, extraído com zod por fonte, só com campos do log original (`nativeId`): `eventID` do CloudTrail; `id` do achado do GuardDuty, mais `/<IP>:<porta>` na sondagem de porta; `<timestamp>/<clientIp>/<requestId>` no WAF. Cada parte numa classe de caracteres só e com tamanho limitado. Ausente ou fora do formato, vale o `id` do alerta, com o tipo `alert`;
  - **sondagem de porta (revisão):** o módulo aws-s3 do Wazuh (`AWSGuardDutyBucket.reformat_msg`) divide o achado com vários itens em `portProbeDetails` em um evento por item, todos com o mesmo `id`. Só com o `id`, o primeiro IP viraria achado e os outros cairiam como duplicados (e uma exceção do IP do primeiro levaria os outros junto). Com o IP e a porta do item, cada IP vira o próprio achado, com a própria exceção; item fora do formato (sem IPv4, porta inválida, lista) usa o `id` do alerta e nunca junta dois IPs;
  - **WAF (revisão):** atrás de um ALB, o `requestId` é o trace ID, que o cliente HTTP escolhe pelo `X-Amzn-Trace-Id: Root=...` e que se repete nas chamadas de um mesmo trace do X-Ray. Sozinho, ele deixaria quem ataca fixar o valor e fazer cada rajada nova cair como duplicada da primeira. O horário do WAF (milissegundos) e o IP da conexão entram no id; sem um deles, vale o `id` do alerta. Ainda viram um achado só duas requisições do mesmo IP, com o mesmo trace ID, no mesmo milissegundo e na mesma regra;
  - **números como o Wazuh grava (2ª revisão):** o decoder JSON do analysisd grava cada campo de `data.aws` como texto (conferido no wazuh-logtest do 4.14.9): o inteiro de 32 bits sai como o próprio número (porta `"22"`), e os outros números com seis casas. O horário do WAF, com 13 dígitos, chega como `"1793527200000.000000"`. A primeira revisão só aceitava dígitos sem casas, então todo alerta real do WAF ficava sem id nativo e voltava à chave pelo `id` do alerta (a releitura duplicava). Agora o horário e a porta aceitam o número, o texto e o texto com casas zeradas, e os três dão o mesmo id; fração diferente de zero, notação científica e espaço continuam recusados;
  - a conta é a do cadastro (T5.2). A chave é única no banco inteiro, e cada conta é de um cliente só: um id repetido de propósito no bucket de B nunca apaga, como duplicado, o achado de A;
  - a regra dá chave própria à correlação (80255, 80443): o evento que fecha a rajada, relido sem os anteriores, casa só com a regra simples, e cada regra vira o próprio achado;
  - id longo demais para a coluna (128) entra pelo resumo SHA-256, sempre o mesmo;
  - a fila sem dono continua pelo `id` do alerta.
- **Severidade do GuardDuty (2ª revisão, muda o comportamento):** o `awsSeverity` só era lido quando chegava em número, e o Wazuh o grava em texto (`"8"`, `"5.500000"`). Em produção, a severidade do achado do GuardDuty saía sempre do nível da regra do Wazuh, e não das faixas da AWS que o código e a T5.3 descrevem. Agora o texto vale o mesmo que o número (de 0 a 10; fora disso, volta ao nível da regra). Exemplo: sondagem de porta com severidade 5.5 (regra 80306, nível 6) passa de baixa a média. O defeito vinha do main (T5.3) e ficava escondido pelas fixtures em número; nenhum achado do Wazuh existe em produção.
- **Evento bruto do detalhe (desvio do plano):** o detalhe buscava o evento no indexer pelo `sourceEventId`, que era o `id` do alerta. Com a chave nova, essa busca deixaria de achar o evento. O achado ganha a coluna `rawEventId`, com o `id` do alerta da primeira leitura, e o detalhe busca por ela. Achado sem a coluna (GCP) nem consulta o indexer. A outra saída, buscar pelo id nativo, deixaria um id forjado no bucket de um cliente trazer o evento de outro.
  - **Migration** `20261104110000_finding_raw_event_id`: só a coluna, nula. Nenhum achado do Wazuh existe em produção, então nada é migrado.
- **Dependências:** nenhuma.
- **Testes:**
  - configuração do indexer (8): modo nó em produção, cada variável obrigatória do modo nó, os dois modos misturados (em produção e fora dela), produção sem `INDEXER_AUTH=node` com credencial no ambiente, modo inválido e senha curta sem o valor na mensagem, CA lida na conexão (ausente, inválida, depois válida);
  - cliente do indexer no modo nó (3): leitura com a credencial do ambiente e a CA do arquivo pelo HTTPS local, recusa de certificado de outra CA e **log-capture**: senha recusada, erro 500 e CA ausente, pelo agendador do worker, vão para o log só como `IndexerError`, sem a senha, sem `Basic ` e sem o base64 da credencial;
  - alerta (6): id nativo de cada fonte (inclusive o do CloudFront, em base64, e IPv6 no WAF, e o horário e a porta em número, em texto e com seis casas), trace ID repetido no WAF em horário ou IP diferente, cada item da sondagem de porta com id próprio, ausente ou fora do formato (inclusive WAF sem horário ou IP, horário com fração ou acima do maior inteiro exato e item de sondagem inválido), severidade do GuardDuty em texto e fora da faixa, e o **formato que o Wazuh grava**: um WAF e uma sondagem de porta passados pelo socket do wazuh-logtest do manager 4.14.9 (dados fictícios), com o `data.aws` que saiu guardado no teste, dão o id nativo e a severidade;
  - chave (7): formato por fonte (inclusive a sondagem de porta), o que a AWS repete em eventos diferentes não junta achados, mesmo evento com outro `id` de alerta, GuardDuty atualizado, correlação com chave própria, contas diferentes, sem id nativo e id longo;
  - sync com banco real (8): mesmo evento relido numa execução posterior não duplica nem desfaz a triagem, GuardDuty atualizado três vezes vira um achado, GuardDuty atualizado depois da triagem não reabre nada (o risco abaixo, fixado em teste), sondagem de porta com três IPs vira três achados e a exceção do primeiro IP não leva os outros, WAF com o mesmo trace ID em duas rajadas vira dois achados e a releitura não duplica, correlação e evento simples viram dois achados e a correlação relida não duplica, **A/B** (o mesmo id de evento no bucket de B chega antes e não apaga o achado de A, e cada um fica no próprio cliente), chave pelo `id` do alerta sem id nativo;
  - detalhe (1): achado da GCP sai sem evento bruto e não consulta o indexer;
  - os testes do sync e do detalhe foram ajustados para achar o achado pela chave nova; as fixtures ganharam o id nativo de cada fonte.
  - **fixtures no formato do Wazuh (2ª revisão):** o `data.aws` de toda fixture passa por `asWazuhWrites`, que grava como o analysisd (números e booleanos em texto, texto e objeto vazios fora), e o teste do formato confere essa função contra a saída do wazuh-logtest. Com o parser anterior, 9 testes falham nesse formato (WAF sem id nativo, severidade do GuardDuty ignorada); o sync do WAF com banco real agora lê o horário como o Wazuh grava. `withAws` segue gravando o valor como veio, para os casos fora do formato.
  - **severidade do GuardDuty no banco (3ª revisão, só teste):** o sync com banco real do GuardDuty, que dizia usar a severidade da AWS, não conferia a severidade, e a fixture padrão (8, regra de nível 10) dava alta pelos dois caminhos. Agora grava 5.5 e 9.5 em texto, com a regra de nível 10, e confere média e crítica no achado gravado. Recalcular a severidade pelo nível da regra na gravação (`findingRow`) faz o teste falhar (conferido).
  - Resultado: API 66 arquivos e 871 testes (869 antes da 2ª revisão, 863 antes da 1ª); lint, tipos e Prettier limpos. O compartilhado e o painel não mudaram.
- **Definição de pronto:** aceite do código ✔ (o aceite no nó depende do PR-W1) · testes, com A/B e log-capture ✔ · lint e tipos ✔ · nenhuma dependência ✔ · regras de segurança ✔ (TLS validado, nenhum segredo em log ou mensagem, entrada do indexer validada com zod, dados fictícios).
- **O que testar manualmente:** nada no nó da Verax (`lean`), que segue com `SYNC_SOURCES=gcp`. Com o PR-W1 no nó de homologação: `INDEXER_AUTH=node` no ambiente da API e do worker, a tarefa `wazuh` concluindo no journal e o detalhe de um achado da AWS com o evento bruto.
- **Riscos e pendências:**
  - o `.env.example` não foi alterado (o agente não lê arquivos `.env*`). Sem `INDEXER_AUTH`, o ambiente local continua igual; só um `.env` com variáveis dos dois modos juntas passa a ser recusado;
  - a chave nova deduplica pelo primeiro que chega: quem escreve no bucket de log do cliente consegue, com um id previsto, fazer um evento forjado ocupar a chave do verdadeiro (mesma conta e mesma regra). Quem escreve no bucket já consegue apagar logs. De fora, sem acesso ao bucket, nenhuma parte do id basta: o `eventID` do CloudTrail e o `id` do GuardDuty são gerados pela AWS, e o trace ID do WAF, que o cliente HTTP escolhe, só entra junto com o horário do WAF e o IP da conexão;
  - o achado do GuardDuty atualizado guarda os campos e o evento bruto da primeira versão. Uma atualização que mude a severidade a ponto de trocar a regra do Wazuh vira outro achado (a escalada aparece);
  - **atividade nova num achado do GuardDuty já triado não aparece (decidido em 2026-11-04; implementado na correção "reincidência do achado do GuardDuty", abaixo):** o GuardDuty soma a atividade nova ao mesmo achado (mesmo `id`, `service.count` maior, `updatedAt` novo). Na mesma faixa de severidade, a versão nova caía como duplicada: nenhum achado, nenhum incidente, e um achado resolvido ou legítimo continuava assim (no main, cada versão virava um achado novo). Decisão do responsável: a atividade nova num achado já triado vira um **achado novo**, ligado ao original, que não é reaberto; a versão nova de um achado ainda não triado continua sem duplicar;
  - com a retenção de 30 dias do indexer (D-6), o evento bruto do detalhe é o da primeira leitura e some com ele, mesmo que versões mais novas do mesmo evento sigam no índice;
  - a fila sem dono continua pelo `id` do alerta: uma releitura repete o alerta na fila.

## Fase 2, PR-04': módulo do nó, perfil standard e homologação em São Paulo ⚠️ altera `infra/` e `.github/`

- **Pedido:** a "config vendável" que a fase 3 vai executar e o nó de homologação em São Paulo (plano revisado da fase 2, PR-04'), mais o swap cifrado decidido no PR-01'. Nada foi aplicado: o apply da homologação fica com o responsável.
- **Terraform (`infra/gcp/`, revisar linha a linha):**
  - **`modules/node`:** rede, NAT, VM, disco, snapshot, segredos, logs, backups e alerta, extraídos da raiz antiga (`node.tf`, `network.tf`, `secrets.tf`, `logs.tf` e `backups.tf`, movidos com `git mv`). A variável `node_profile` define:
    - `lean`: e2-micro (aceita e2-small e e2-medium), 30 GB pd-standard, snapshot semanal de 28 dias e NAT automático, os valores de antes um a um;
    - `standard`: e2-standard-2 (e2-standard-4 aceito como plano B), 60 GB pd-balanced, snapshot diário de 7 dias e IP do NAT reservado (`google_compute_address` com `prevent_destroy`, `MANUAL_ONLY` e a saída `nat_ip`);
    - uma VM fora do perfil é recusada no `plan`.
  - **Script de boot do módulo** (`startup.sh.tftpl`, na chave `startup-script` dos metadados, que muda sem recriar a VM):
    - swap de 2 GB cifrado com dm-crypt no modo plain (AES-256-XTS), com uma chave nova de `/dev/urandom` a cada boot, sobre um loop com acesso direto ao arquivo (`/var/lib/verax-swap.img`, que só recebe texto cifrado);
    - o `cryptsetup-bin` entra antes de qualquer mudança no swap, com 5 tentativas (cada uma baixa a lista do apt de novo) e espera pela trava do apt; sem ele, o script para ali;
    - o arquivo do swap só é criado com 3 GB livres no disco (os 2 GB dele e 1 GB de folga para o nó); se o `fallocate` falhar no meio, o arquivo incompleto sai na hora, e um arquivo fora de uso com o tamanho errado é refeito;
    - num disco que veio do script antigo, liga primeiro o swap cifrado; depois desliga o swap em claro (as páginas passam para o cifrado), zera o `/swapfile` e só então tira a linha do `fstab` e apaga o arquivo. Se parar no meio, a execução seguinte repete a limpeza;
    - no `standard`, `vm.max_map_count=262144` e `vm.swappiness=1` em `/etc/sysctl.d/90-verax.conf`.
  - **Cofres que a VM grava:** `credentials-key` (`secretVersionAdder` e `secretAccessor` só nele) e `admin-bootstrap` (só `secretVersionAdder`: a VM grava a senha temporária e não lê de volta).
  - **Pub/Sub** com `message_storage_policy` na região do nó.
  - **Alerta de fila parada** (`monitoring.tf`): `oldest_unacked_message_age` acima de `stalled_subscription_hours` (24 h; de 1 a 144) nas assinaturas do nó, com e-mail opcional (`alert_email`, só no `terraform.tfvars`).
  - **`envs/verax`:** a raiz antiga (APIs, orçamento e registro das imagens), agora chamando o módulo no perfil `lean`, com o mesmo backend (bucket e prefixo `verax-node`) e 26 blocos `moved` (30 recursos no estado de hoje). Para o nó no ar não mudar nada:
    - passa o `startup.sh` de antes, idêntico (o provider recria a VM se o `metadata_startup_script` mudar);
    - desliga o Pub/Sub na região, os cofres novos e o alerta;
    - o NAT continua automático.
  - **`envs/homolog-sp`:** southamerica-east1, perfil `standard`, projeto dos nós de clientes por variável, estado próprio (prefixo `homolog-sp`), `disk_gb` opcional (60 GB do perfil sem ele), orçamento opcional e leitura do registro de imagens do projeto da Verax só para a conta da VM. Nunca aplicado.
  - `deletion_protection` virou variável do módulo (padrão `true`), para a manutenção que recria a VM;
  - os acessos dos operadores na VM (OS Login de administrador e túnel do IAP) têm `replace_triggered_by` no `instance_id`: quando a VM é recriada, o Terraform grava os acessos de novo na VM nova, e uma mudança no lugar não mexe neles.
- **Pacote do nó (`infra/node/`, revisar linha a linha):**
  - `compose.yaml`: o `mem_limit` do Postgres, da API e do worker, os heaps (`NODE_OPTIONS`) e o `shared_buffers` vêm de variáveis, com o padrão igual ao de antes (lean);
  - `start.sh`: escreve `/run/verax/memory.env` pelo `NODE_PROFILE` e passa o arquivo ao Compose quando ele existe:
    - lean: Postgres 256m com `shared_buffers=32MB`, API 320m com heap de 192 e worker 256m com heap de 160;
    - standard: Postgres 512m com `shared_buffers=128MB`, API 384m com heap de 256 e worker 512m com heap de 384;
  - `install.sh`: confere o `NODE_PROFILE` (lean ou standard; sem a linha, lean, e o nó da Verax sobe igual sem mudar o `node.conf`) e o formato do `NODE_EGRESS_IPS` quando presente (IPv4 com /32, separados por vírgula);
  - `node.conf.example`: `NODE_PROFILE=lean` e `NODE_EGRESS_IPS=`.
- **CI e Dependabot (`.github/`, revisar linha a linha):**
  - `iac.yml`, job do Terraform: valida `infra/gcp/envs/verax` e `infra/gcp/envs/homolog-sp` no lugar de `infra/gcp`, que deixou de ser raiz, e roda o tflint da GCP com `--recursive` (ambientes e módulo);
  - `iac.yml`, job "Pacote do nó": passo novo de memória por perfil. Sem as variáveis, o Compose tem de dar exatamente o lean do `start.sh` (o nó da Verax antes do perfil), e o standard tem de chegar aos três contêineres. A checagem de memória que o plano citava não existia; o passo novo é ela;
  - `iac.yml`, job do Terraform: `terraform test` do módulo do nó, com o provider simulado (`init -backend=false` com o lock do módulo, o mesmo `google` 8.9.0 dos ambientes);
  - `iac.yml`, job "Pacote do nó": shellcheck do script de boot do módulo (o modelo e o resultado nos dois perfis) e os cenários do `tests/startup-test.sh`;
  - `dependabot.yml`: as duas pastas de ambiente no lugar de `/infra/gcp`.
- **Documentação:** `infra/gcp/GUIA.md` (organização, perfis, init, plan e apply por ambiente, o que conferir no plan com os `moved`, homologação e a manutenção do swap), `docs/ARQUITETURA.md` (situação dos perfis e caminho do nó da Verax) e `docs/runbooks/no-verax.md` (caminho e `NODE_PROFILE`).
- **Dependências:** nenhuma. Os ambientes continuam no `hashicorp/google` 8.9.0 (o lock não mudou); o módulo aceita `>= 8.9.0, < 9.0.0`.
- **Testes:**
  - `terraform fmt -check`, `init -backend=false` e `validate` no módulo e nos dois ambientes;
  - tflint 0.65.0 recursivo e checkov 3.4.0 (os do CI) em `infra/`, sem falhas. As checagens dos metadados da VM (chaves de projeto, OS Login e console serial) continuam passando com o `merge`;
  - `terraform test` do módulo (`modules/node/tests`, provider simulado, 16 casos, sem credencial):
    - `lean_verax`: o módulo chamado como em `envs/verax`, com os valores de antes um a um (VM, disco, snapshot semanal de 28 dias com o mesmo nome, NAT automático, metadados, cofres de antes, nada dos extras), o `sha256` do `startup.sh` aplicado, os nomes e os valores que recriariam algo se mudassem (rede, sub-rede e faixa, roteador, NAT, firewall, conta de serviço e papéis, réplica dos cofres, bucket, tópico, assinatura e sink, com o filtro) e a VM depois da manutenção do swap (script do módulo na chave `startup-script`, proteção ligada, mesmo disco);
    - `perfis`: o standard, o standard com `disk_gb` maior, o lean novo (o script que a VM recebe é o modelo com o perfil trocado, e nada mais), VM fora do perfil recusada nos dois perfis, perfil inválido e o alerta de fila parada com 1 hora (o teste do GUIA) e abaixo disso (recusado);
    - `operadores`: recriar a VM recria os dois acessos de cada operador; mudar o tamanho da VM (no lugar) não mexe neles;
    - mutações conferidas: sem o `replace_triggered_by`, com ele no recurso inteiro, outro nome de snapshot, IP fixo no lean, um byte a mais no `startup.sh` da Verax e uma sequência de modelo no script; cada uma derruba ao menos um caso;
  - `tests/startup-test.sh`, sem root, com os comandos do kernel, do disco e da rede simulados e o `shred`, o `sed`, o `grep` e o `stat` de verdade (rodado num contêiner Debian 12 como usuário comum): nó novo lean e standard, mesmo boot e boot seguinte, disco do script antigo, rede fora do ar (5 tentativas, cada uma com a lista do apt de novo; o swap antigo fica intacto e ligado), rede de volta no meio das tentativas, trava do apt, disco sem 3 GB livres, `fallocate` interrompido, arquivo do swap incompleto de um boot antigo (refeito) e em uso (intocado), VM reiniciada no meio do `shred`, arquivo sem a linha, linha sem o arquivo e perfil inválido. O apt simulado faz o que o apt 2.6 do Debian 12 faz sem rede (o `update` só avisa e sai com 0), conferido num contêiner sem rede. Mutações conferidas: a ordem antiga, a linha do `fstab` antes do `shred`, sem repetir o apt, o `update` e o `install` repetidos em separado, só o `fstab` decidindo, sem `shred`, sem `mkswap`, sem apagar o arquivo do `fallocate` que falhou, sem conferir o tamanho, o loop, o espaço livre ou a folga; todas falham;
  - shellcheck no pacote do nó, no script de boot (o modelo e o resultado nos dois perfis) e no teste;
  - antes da revisão, o script de boot rodou num contêiner Debian 12 privilegiado (cryptsetup 2.6.1, com `swapon` e `sysctl` falsos): o loop e o dm-crypt de verdade subiram com aes-xts-plain64 de 512 bits. Os comandos do loop e do dm-crypt não mudaram na revisão, só o arquivo e a ordem;
  - Compose com e sem as variáveis, como o passo novo do CI, mais uma mutação: um padrão diferente do lean faz o passo falhar;
  - **`plan` só de leitura de `envs/verax` contra o estado real** (`-lock=false`, sem apply): `Plan: 0 to add, 0 to change, 0 to destroy`, com 47 recursos sem mudança, 30 deles movidos para o módulo, e nenhuma diferença nas saídas. O `terraform.tfvars` não estava nesta máquina; as variáveis foram montadas a partir do próprio estado.
- **Correções da revisão do PR, com testes novos:**
  - a manutenção do GUIA recria a VM, e a política de IAM dela some junto. Os acessos dos operadores usam o nome da VM, que não muda, e o Terraform não os gravaria de novo: quem está em `operators` e não é dono do projeto perderia o SSH. Agora eles têm `replace_triggered_by`, e o GUIA diz o que o `plan` mostra;
  - o script de boot desligava e apagava o swap em claro antes de instalar o `cryptsetup` e de ligar o cifrado: na e2-micro, uma falha do apt deixaria o nó da Verax sem swap. Agora o cifrado sobe antes, num arquivo novo, e o antigo só sai depois; sem o `cryptsetup`, nada muda;
  - a linha do `fstab` saía antes do `shred`. Se a VM reiniciasse no meio, o arquivo meio zerado viraria o do swap cifrado, com o resto do texto claro dentro. Agora a linha só sai com o arquivo zerado, e um arquivo que sobrou é zerado e apagado no boot seguinte;
  - os valores que mantêm o nó da Verax sem mudança e o script de boot não tinham teste no CI: os testes do módulo e do script foram versionados e entraram no `iac.yml` (acima);
  - o passo de memória por perfil do `iac.yml` ganhou a diretiva `# shellcheck source=/dev/null`: o actionlint do CI (`security.yml`) recusaria o `source <(...)` dele.
- **Correções da segunda revisão, com testes novos:**
  - sem rede, o `apt-get update` do Debian 12 só avisa e sai com 0, e o `retry` dele nunca repetia: as 5 tentativas do `install` usavam a mesma lista vazia ou velha, mesmo com a rede de volta. Agora cada tentativa baixa a lista e instala. O teste simulava o `update` saindo com erro, o que o apt de verdade não faz; agora simula o apt 2.6 e tem o cenário da rede que volta no meio;
  - um `fallocate` sem espaço deixava um arquivo incompleto, reaproveitado para sempre (o `-f` só via que ele existia), e enchia o disco do nó da Verax, onde o arquivo novo convive com o antigo. Agora o script exige 3 GB livres, apaga o arquivo do `fallocate` que falhou e refaz um arquivo fora de uso com o tamanho errado. O GUIA pede 3 GB livres;
  - com o `replace_triggered_by`, um `apply` que recria a VM com a proteção ainda ligada apaga os acessos dos operadores na VM no ar antes de esbarrar na proteção. O Terraform não deixa conferir isso no `plan`; o GUIA manda conferir `deletion_protection = false -> true` na troca da VM e diz como devolver os acessos;
  - o GUIA mandava apagar o `envs/verax/startup.sh`, que o `lean_verax` lê: o check do Terraform falharia. O passo agora inclui ajustar o teste no mesmo commit, e o `run "apos_a_manutencao_do_swap"` já confere a VM depois da manutenção;
  - a VM recriada tem chaves de SSH novas, e o `deploy.sh` recusaria a conexão: o GUIA e o runbook dizem como trocar a chave guardada;
  - `envs/homolog-sp` não tinha `disk_gb`, e o "Aumentar o disco" do GUIA não fazia nada nele. A variável entrou (conferido num plan simulado: 60 sem ela, 120 com ela);
  - o GUIA dizia que a leitura do registro era a única coisa fora do projeto dos nós; faltavam os sinks nos projetos monitorados e o orçamento;
  - o `lean_verax` conferia só a VM, o disco, o snapshot e o NAT, e o comentário do `iac.yml` prometia mais. Entraram os nomes e os valores que recriariam algo no ar (11 mutações conferidas, como renomear a VPC, a sub-rede, o NAT, a conta de serviço, o bucket, um tópico ou o sink, mudar a réplica dos cofres ou o filtro; todas falham), e o comentário diz o que o teste cobre.
- **Correções da terceira revisão, com testes novos:**
  - o primeiro `plan` da homologação num projeto novo parava com 403, e o "espere e rode de novo" do GUIA não resolvia: o `data "google_project"` (o número do projeto, para o orçamento) era lido no `plan`, pela API do Resource Manager cobrada do próprio projeto (`billing_project`), que vem desligada num projeto novo e só o `apply` liga. Agora a leitura tem `depends_on` nas APIs e fica para o `apply` enquanto alguma delas for ligada; com todas ligadas, volta para o `plan`. Conferido num `plan` local do ambiente com o provider apontado para um servidor falso que recusa tudo (sem credencial e sem falar com a GCP): antes, uma chamada (`GET /v1/projects/...`) e o erro; depois, nenhuma chamada e `Plan: 51 to add` (com orçamento, e-mail, 1 projeto monitorado e 1 operador). Teste novo `envs/homolog-sp/tests/primeira_subida.tftest.hcl`, no `iac.yml`: no `plan` de um projeto novo, o provider simulado falha se o projeto for lido (sem o `depends_on`, o caso falha); depois do `apply`, o `plan` seguinte lê o projeto e o orçamento fica igual. O GUIA diz o que o primeiro `plan` mostra (a leitura no `apply` e, quando a lista de APIs mudar, o orçamento com `update in-place` para o mesmo projeto) e separa o erro de API no `apply` (esperar e repetir) do erro no `plan` (ligar a API). O `envs/verax` não muda: o projeto da Verax já tem a API ligada;
  - a manutenção do swap mandava conferir a chave de SSH nova nos atributos de convidado (_guest attributes_), que o módulo não liga, e dizia que o `gcloud compute ssh` confere a chave sozinho, o que ele não faz numa VM nova (outro ID, chave aceita na primeira conexão). O GUIA agora diz que o `deploy.sh` aceita a chave nova na primeira conexão, como na primeira vez, e como comparar as impressões digitais depois. Os metadados da VM continuam os mesmos, conferidos pelo `lean_verax`;
  - o teste do alerta de fila parada, que só existe na homologação, mandava usar o `sinks update` e o `pull` com os nomes do nó da Verax, que não existem no projeto de teste da homologação. Agora traz os comandos da homologação (`verax-homolog-security`, com a assinatura no projeto dos nós).
- **Correções da quarta revisão (GUIA e exemplos; nenhum recurso muda), com testes novos:**
  - o GUIA dizia que um erro de API no `plan` nunca é propagação. Só vale antes do primeiro `apply`: depois dele, mesmo um que parou nesse erro, as APIs estão no estado, o `plan` lê o projeto e os recursos que já existem, e um 403 ali é a mesma propagação, que se resolve esperando. O passo 6 agora separa os dois casos (antes do primeiro `apply`, ligar a API; depois, conferir com `gcloud services list --enabled` e esperar). Reproduzido num `terraform test` local (fora do commit): depois do `apply`, o `plan` com a leitura do projeto falhando para no `data "google_project"`. O `plan_seguinte` do `primeira_subida` ganhou a asserção de que o projeto é lido no `plan`;
  - o passo 3 pedia só `project_id` e `monitored_projects` no `terraform.tfvars` do `envs/verax`, mas o estado do nó da Verax tem o orçamento (é o 47º recurso do `plan` só de leitura), e a primeira subida foi por `-var`, sem arquivo. Com o arquivo do passo 3, o `plan` mostraria `google_billing_budget.project[0] will be destroyed`, e o passo 5 culpava só um `moved` ou o perfil. Agora o passo 3 pede todas as variáveis da primeira subida (com `billing_account_id` e `monthly_budget`) e diz como tirá-las do estado (`terraform state list` e `terraform state show`), o passo 5 cita a variável que falta como causa, e o exemplo do `envs/verax` avisa. Teste novo `envs/verax/tests/variaveis.tftest.hcl`, no `iac.yml`: com as variáveis da primeira subida, o orçamento continua igual; sem a conta de faturamento, ele sai do plano (uma mutação com o orçamento sempre criado derruba o caso);
  - o exemplo do `terraform.tfvars` da homologação sugeria 2 horas para o teste do alerta, e o GUIA usa 1 e manda esperar pouco mais de 1 hora: com 2, o alerta não abriria nesse tempo. O exemplo agora diz 1. Casos novos no `perfis`: com 1 hora, a condição tem o limite de 3600 s, os 5 minutos de duração e o nome com "1 h"; abaixo de 1, a variável é recusada (mutações conferidas: o limite com 7200 por hora e a validação aceitando 0; cada uma derruba um caso).
- **Desvios do plano:**
  - o `infra/gcp/startup.sh` não ganhou o swap cifrado nem os ajustes do kernel: virou o script do nó da Verax, idêntico, e o comportamento novo está no script do módulo, que só chega aos nós novos;
  - APIs, orçamento e registro de imagens ficam no ambiente, porque valem para o projeto inteiro (vários nós de clientes no mesmo projeto);
  - o nó da Verax fica sem os cofres, o alerta e o Pub/Sub na região, para o `plan` dele não mudar nada;
  - `NODE_EGRESS_IPS` é opcional por enquanto: quem o usa (template do usuário IAM e regras do Wazuh) vem nos PRs V2 a V4.
- **Definição de pronto:** módulo, perfis e ambientes ✔ · `plan` do nó da Verax sem mudança ✔ · validate, tflint, checkov e shellcheck ✔ · testes do módulo e do script de boot no CI ✔ · nenhuma dependência ✔ · regras de segurança ✔ (nenhum ID de projeto, conta ou e-mail real no código) · **aceite:** depende do apply da homologação.
- **Pendências para o responsável:**
  - criar o projeto dos nós de clientes e o bucket do estado, preencher o `terraform.tfvars` da homologação e aplicar (GUIA, passos 2 a 6); conferir o `nat_ip`, o Pub/Sub na região e o swap cifrado (passo 8);
  - no nó da Verax: rodar o `init`, montar o `terraform.tfvars` de `envs/verax` com todas as variáveis da primeira subida, inclusive `billing_account_id` e `monthly_budget` (GUIA, passo 3; sem o arquivo de antes, os valores saem do estado), e rodar o `plan` (tem de dar 0, 0 e 0, com 30 linhas `has moved to`) e o `apply`, que só grava os endereços novos no estado;
  - **swap cifrado no nó da Verax:** manutenção planejada, descrita no GUIA (o script novo recria a VM; o disco fica; 3 GB livres antes; depois, trocar a chave de SSH guardada pelo `deploy.sh` e, num commit, apagar o `envs/verax/startup.sh` e ajustar o `lean_verax`). Não há passo manual seguro enquanto o script antigo estiver na VM: no boot seguinte, ele recolocaria o swap em claro no `fstab` e falharia ao ligá-lo. Até a manutenção, o swap do nó da Verax segue em claro;
  - ligar no nó da Verax, quando quiser, o alerta de fila parada e o Pub/Sub na região (mudanças no lugar), e o cofre junto com o PR-V1.
- **Riscos:**
  - um `moved` errado recriaria a VM; o `plan` contra o estado real mostrou que não;
  - o swap passa por loop e dm-crypt, uma camada a mais que o swap em arquivo, sob pressão de memória: medir no ensaio da homologação (24 h de `docker stats`);
  - o script de boot instala o `cryptsetup-bin` pela internet no primeiro boot, com 5 tentativas em cerca de 80 s. Se não instalar (ou se o disco não tiver 3 GB livres), um nó novo fica sem swap (nunca em claro) e o disco do script antigo continua com o swap de antes, sem nada apagado; o log do `google-startup-scripts` mostra o erro;
  - um `apply` que recria a VM com a proteção ligada tira os acessos dos operadores da VM no ar antes de falhar (o Terraform não deixa barrar isso no `plan`); o GUIA manda conferir a proteção no `plan` e diz como devolvê-los;
  - a homologação dá à VM leitura do registro de imagens no projeto da Verax (só as imagens do código aberto);
  - o PR-V1 pode precisar listar as versões do `credentials-key` (`secretmanager.versions.list`), que o `secretAccessor` não dá; se o desenho dele pedir, o papel entra lá;
  - a homologação ligada custa o mesmo que um nó `standard` (valor fora do repositório público): parar fora das janelas de teste.

## Fase 2, PR-V2: usuário IAM somente leitura do cliente ⚠️ altera `infra/` e `.github/`

- **Pedido:** o template que o cliente aplica na conta AWS para o nó ler com uma chave restrita ao IP do nó (plano revisado da fase 2, PR-V2, seção 2.3 e decisões D-1, D-10, D-11, D-12 e D-17). O código não depende de nada; o aceite depende do PR-04' (IP do NAT) e de uma conta AWS de teste. Nada foi aplicado em conta nenhuma.
- **Template (`infra/cloudformation/verax-control-reader.yaml`, revisar linha a linha):**
  - **Recursos com os padrões:** só quatro, no caminho `/verax/`: as políticas gerenciadas `VeraxControlReader` (leitura) e `VeraxControlGuardrails` (negação), o grupo `VeraxControlReaders` com as duas e o usuário `verax-control-reader`, membro só do grupo e com a política de leitura como limite de permissões (`PermissionsBoundary`). **Sem `AWS::IAM::AccessKey` e sem `LoginProfile`.**
  - **`VeraxControlReader`:** as declarações da seção 2.3 (`ListarBucketsDeLog`, `LerObjetosDeLog`, `DecifrarSoPeloS3`, `AutoInspecao`, `ValidarFontes` e `PosturaEAtivos`), com os buckets e as chaves só quando informados (`Fn::If`), mais as dos buckets e da chave criados pela pilha, se pedidos (`kms:ViaService` da região da pilha). `iam:SimulatePrincipalPolicy` só no ARN do próprio usuário.
  - **`VeraxControlGuardrails`:**
    - `SoDoNoDaVerax`: `Deny *` com `NotIpAddress aws:SourceIp` = `NodeEgressIps`, como o plano (sem `aws:ViaAWSService`);
    - `NuncaAlterarLogs` e `NuncaAmpliarOProprioAcesso`: as listas do conector, idênticas (o teste compara). O `iam:Delete*` cobre a autorrevogação (D-12: o usuário não apaga nem desativa a própria chave);
    - `SoOsPrefixosInformados` (com `LogObjectPrefix`): `Deny s3:GetObject` com `NotResource` `arn:*:s3:::*/<prefixo>*` por prefixo, mais os buckets criados pela pilha;
    - `RevogarSessoesAntigas` (com `RevokeSessionsIssuedBefore`): `Deny *` com `DateLessThan aws:TokenIssueTime`. A chave de longa duração não tem essa chave de contexto e não é afetada.
  - **Parâmetros:** `NodeEgressIps` obrigatório, sem padrão, IPv4 só com `/32` (a mesma expressão do `install.sh`, que o teste compara; D-1); `LogBucketArns`, `LogKmsKeyArns` (chave comum, UUID, ou multirregião, `key/mrk-...`) e `LogObjectPrefix` (listas, vazias por padrão); `CreateTrail` e `EnableGuardDutyExport` com padrão `false` (D-11), `GuardDutyDetectorId`, `LogRetentionDays` (só nos buckets criados) e `RevokeSessionsIssuedBefore` (UTC).
  - **Regras da pilha (`Rules`):** IP obrigatório também com a lista vazia; export do GuardDuty só com o ID de um detector já ativo; nenhuma lista com item vazio (uma vírgula sobrando num prefixo viraria `arn:*:s3:::*/*` e liberaria o bucket inteiro).
  - **Opcionais (do conector T4.3, `8f537ff`):** trilha multi-região `verax-control` com validação de integridade, export do GuardDuty, chave KMS com rotação, bucket de log de acesso e buckets privados, versionados, com TLS obrigatório e `Retain`. Os três buckets **não têm nome fixo**: o CloudFormation gera o nome, e a política do bucket de log de acesso aponta o ARN exato dos buckets criados (`ArnEquals` com `GetAtt`, a ordem do exemplo da AWS). Com `Retain`, um nome fixo faria falhar religar a opção ou recriar a pilha, porque o bucket que ficou já existe. Sem a parte do WAF: **o WAF nunca é alterado**, e o GuardDuty nunca é ativado pela pilha.
  - **Saídas:** `UserArn`, `SecurityCredentialsUrl` (a aba _Security credentials_ do usuário) e, se criados, os ARNs dos buckets (inclusive o de log de acesso) e da chave. Nenhuma é segredo.
- **Sem CloudFormation:** `verax-control-reader.policy.json` traz as duas políticas com os valores fictícios da seção 2.3; o teste confere que é exatamente a pilha montada com esses valores. O README tem os comandos `aws iam create-policy`, `create-group`, `attach-group-policy`, `create-user --path /verax/ --permissions-boundary` e `add-user-to-group`, com `jq` para separar as duas políticas do arquivo.
- **README (`infra/cloudformation/README.md`):** passo a passo do cliente (D-10: download e `aws cloudformation deploy`), criação da chave no console, troca aos 90 dias, incidente (desativar a chave e `RevokeSessionsIssuedBefore`), opcionais, bucket com logs de várias contas, custos e remoção. O conector com papel e ExternalId ficou numa seção marcada como **obsoleta** (D-17), e o arquivo dele ganhou um comentário no topo dizendo isso; o template em si não mudou. `docs/ARQUITETURA.md` marca o template como feito.
- **cfn-guard e CI (`.github/workflows/iac.yml`, revisar linha a linha):** o job de CloudFormation instala o cfn-guard 3.2.1 (binário `cfn-guard-v3-x86_64-ubuntu-latest.tar.gz` do release do GitHub, publicado em 25/08/2026, com o SHA-256 fixado em `CFN_GUARD_SHA256`; é o `digest` que o GitHub mostra no release e confere com o arquivo baixado) e roda `cfn-guard test` (21 casos) e `cfn-guard validate` no template. Regras em `infra/cloudformation/guard/verax-control-reader.guard`: sem chave, nenhuma saída com segredo, usuário sem senha e com o limite, Deny de IP (a condição inteira comparada: nenhum outro operador, nenhuma outra chave ao lado do `aws:SourceIp`, sem `NotAction` nem `NotResource`), leitura só com verbos de leitura, conteúdo de log só nas declarações condicionais e nunca em `*` nem num curinga de bucket ou de chave (ação e recurso em texto ou em lista), Decrypt só pelo S3, nada de WAF nem de detector. O nome do job não mudou, porque é um check obrigatório do ruleset. O cfn-lint e o checkov já pegam o arquivo novo pelo caminho.
- **Arquivos:** `infra/cloudformation/{verax-control-reader.yaml,verax-control-reader.policy.json,README.md,verax-control-connector.yaml}` (no conector, só o comentário), `infra/cloudformation/tests/test_reader.py`, `infra/cloudformation/guard/{verax-control-reader.guard,verax-control-reader.tests.yaml}`, `.github/workflows/iac.yml`, `docs/ARQUITETURA.md`.
- **Dependências:** nenhum pacote novo de npm ou de pip. Ferramenta nova no CI: cfn-guard 3.2.1, fixada por versão e SHA-256.
- **Testes:**
  - `tests/test_reader.py` (36, no mesmo venv do cfn-lint e no mesmo `unittest discover` do CI): reaproveita `READ_ACTION`, `WAZUH_CALLS` (o subconjunto S3, mais `GetBucketLocation` e `kms:Decrypt`), `MUST_DENY` e o teste de deny que não cancela allow do `test_connector.py`. Um avaliador mínimo de políticas do IAM monta a pilha com valores fictícios (Ref, Sub, GetAtt, If, Join, Split, condições e `Rules`) e decide cada chamada com negação explícita, permissão e limite de permissões:
    - só os quatro recursos com os padrões; nenhuma chave, senha ou saída com segredo; usuário, grupo e políticas em `/verax/`; nada de WAF nem de detector;
    - padrões dos parâmetros (IP só `/32`, sem padrão, e a expressão igual à do `install.sh`; ARNs exatos, com a chave KMS comum ou multirregião; prefixos terminados em `/`; data em UTC; detector) e as três regras da pilha;
    - todo Allow casa com `READ_ACTION` (exceções: `kms:Decrypt` só pelo S3 e a simulação só do próprio usuário), e conteúdo de log nunca em `*`;
    - do IP do nó, os grupos `WAZUH_CALLS`, `POSTURE_CALLS` (as do inventário de hoje, `collectors.ts`) e `VALIDATION_CALLS` (V3 e V5) passam; de outro IP, inclusive o vizinho, tudo é negado; `MUST_DENY` (o do conector mais a própria chave, o usuário, o grupo, o WAF, a trilha e o export) é negado mesmo com uma política de administrador anexada ao usuário, e o limite segura o resto (Secrets Manager, SSM, `RunInstances`, relatório de credenciais, `GetObjectAcl`, `kms:Encrypt`);
    - prefixos (a trilha da organização e o export da própria conta no mesmo cliente; outra conta e a raiz negadas; os buckets da pilha fora da regra; a listagem continua), revogação de sessões (antes nega, depois passa, a chave sem sessão passa), trilha e export criados legíveis do nó (e o bucket de log de acesso, não), buckets e trilha como no T4.3, buckets sem nome fixo e a política do log de acesso com o ARN exato dos buckets criados nas três combinações, limite de 6.144 caracteres com 10 buckets, 10 chaves e tudo ligado;
    - o `.policy.json` igual à pilha com os valores do exemplo; os comandos do README criam o mesmo usuário, sem chave e sem senha, e o README nomeia as duas chamadas do STS que o Deny de IP não barra;
    - **mutações do plano, automáticas** (5): sem o Deny de IP, com uma chave (e com senha), com `GetObject` em `*` (e em `arn:aws:s3:::*/*`), sem o limite (com uma política de administrador, o Secrets Manager abre), e com escrita ou Decrypt fora do S3.
  - **Mutações conferidas à mão** (num contêiner, numa cópia): 21 de 21 derrubam ao menos um teste (Decrypt da pilha sem `ViaService`, IP com `/24`, sem a revogação, sem a negação dos prefixos, relatório de credenciais, limite trocado, export sem o detector, regra do IP ou das listas desligada, bucket apagado com a pilha, trilha de uma região, simulação de qualquer usuário, objetos de qualquer bucket, negações sem `s3:Delete*` ou `iam:Delete*`, `GetObjectAcl`, trilha ligada por padrão, WAF alterado, JSON fora de sincronia, README criando chave ou sem o limite).
  - **cfn-guard 3.2.1:** `test` com 21 casos (um modelo, uma mutação por regra e as formas que uma regra frouxa deixaria passar: um segundo operador ou outra chave no Deny de IP, `NotResource`, ação ou recurso em lista, curinga de chave) e `validate` no template, passando. As quatro mutações do plano aplicadas no template real derrubam a regra certa, e também as seis formas acima. Um caso com a expectativa errada faz o `test` sair com erro (conferido).
  - cfn-lint 1.59.0 (os três templates) sem achados; checkov 3.4.0 como o CI (`infra`, Terraform e CloudFormation): 46 aprovadas em CloudFormation, 0 falhas; Trivy 0.76.1 (misconfig e segredos, HIGH e CRITICAL) limpo em `infra/cloudformation` e `.github`; Semgrep 1.183.0 com as configurações do CI limpo; actionlint 1.7.12 e zizmor 1.31.1 sem achados; os 34 testes antigos de CloudFormation continuam passando (70 no total).
  - Repositório: `npx eslint . --ignore-pattern ".claude/**"`, `pnpm typecheck` e `npx prettier --check apps packages docs infra .github` limpos. O banco da API não foi rodado (nada em `apps/` mudou).
- **Decisões onde o plano deixava margem:**
  - **o prefixo fica numa negação** (`NotResource`), e não no Allow: o CloudFormation não junta cada bucket da lista com um prefixo de parâmetro (o delimitador do `Fn::Join` tem de ser fixo). Por isso o prefixo vale para todos os buckets informados, e um objeto com o prefixo mais adiante no nome (depois de uma `/`) também passa. Os logs que a AWS grava nunca têm o caminho de outra conta assim. O README diz isso;
  - **`LogObjectPrefix` aceita uma lista**, com o nome do plano: com um prefixo só, a trilha da organização (`AWSLogs/o-.../<conta>/`) e o export do GuardDuty da própria conta (`AWSLogs/<conta>/`) não caberiam juntos;
  - **o prefixo limita só o `GetObject`:** o módulo do Wazuh lista o bucket a partir da raiz (`<path>`, depois `AWSLogs/`), e uma condição em `s3:prefix` quebraria a coleta. A listagem mostra o nome dos objetos (conta e data), não o conteúdo;
  - **export do GuardDuty só com um detector já ativo:** o T4.3 criava o detector quando o ID vinha vazio, o que ativa um serviço cobrado e falha se o GuardDuty já estiver ligado. Aqui o ID é obrigatório com o export (regra da pilha);
  - **a trilha cria uma chave KMS e um bucket de log de acesso** como no T4.3, e `LogRetentionDays` (365, de 90 a 3650) vale só para os buckets criados;
  - **o `.policy.json` tem as duas políticas num arquivo só**, com o nome do plano; os comandos do README separam cada uma com `jq` (já instalado no AWS CloudShell);
  - **saídas a mais:** os ARNs dos buckets e da chave criados, para cadastrar no painel. Nenhuma é segredo.
- **Desvios do plano:**
  - o checkov do CI não avalia as duas políticas gerenciadas, porque elas têm declarações com `Fn::If` (conferido: numa cópia sem as condicionais, as duas passam nas 5 checagens de IAM). Ele também roda com os padrões, que desligam os opcionais; numa cópia com tudo ligado, 41 aprovadas e 1 exceção com motivo (a do T4.3). Quem cobre as políticas são os testes e o cfn-guard;
  - o painel (`ConnectorSteps` e o link do template em `apps/web/src/features/admin/labels.ts`) continua no conector antigo: muda no PR-V3, com a rota `reader-template`. O roteiro de onboarding (`docs/runbooks/onboarding-cliente.md`) já diz para não pedir pilha ao cliente até lá, e não mudou.
- **Correções da revisão (IAM e template), com testes novos:**
  - o README prometia que só o `sts:GetCallerIdentity` responde de fora do IP do nó; o `sts:GetSessionToken` também responde, porque a AWS não deixa negar nenhuma das duas chamadas por política (IAM: _"You cannot use policies to control authentication operations"_). O README, o comentário do template e o passo de aceite abaixo agora dizem as duas; a sessão emitida continua presa ao IP do nó, e `RevokeSessionsIssuedBefore` a corta. O teste confere que a seção do README nomeia as duas;
  - as regras do cfn-guard conferiam menos do que diziam: um segundo operador no Deny de IP (que o estreitaria a uma região) e um `GetObject` em `arn:aws:s3:::*/*` escrito como lista passavam; conferido com o binário, o template passou nas duas mutações. Também passavam a ação em lista (`[s3:GetObject, ...]` em `*`), o `Decrypt` em lista sem `kms:ViaService` e o curinga de chave (`key/*`). O Deny de IP agora é comparado pela condição inteira (sem `NotAction` nem `NotResource`), e toda declaração condicional tem o recurso conferido em texto ou em lista. Oito casos novos no `cfn-guard test`; os testes em Python já pegavam tudo isso;
  - `LogKmsKeyArns` recusava chave multirregião (`key/mrk-` e 32 hexadecimais, comum em landing zones): a pilha era recusada, e sem a chave a leitura cifrada falharia no KMS. O padrão aceita os dois formatos (e, com isso, deixou de aceitar 36 hexadecimais sem hífen); o teste confere;
  - os três buckets opcionais tinham nome fixo e `Retain`: desligar e religar a opção, ou apagar e recriar a pilha, falharia porque o bucket que ficou já existe, e o cliente só sairia disso apagando os logs. Os nomes agora são gerados pelo CloudFormation, a política do log de acesso aponta o ARN exato dos buckets criados (como no exemplo da AWS para `LoggingConfiguration`), e a saída `AccessLogsBucketArn` mostra o terceiro bucket. O README explica que religar ou recriar cria buckets novos. O teste confere os três buckets sem `BucketName` e a política nas três combinações.
- **Definição de pronto:** template, política JSON e README ✔ · testes, mutações e cfn-guard ✔ · cfn-lint, checkov, Trivy, Semgrep, actionlint e zizmor ✔ · lint, tipos e Prettier ✔ · nenhuma dependência de pacote ✔ (ferramenta de CI fixada por SHA-256) · regras de segurança ✔ (só valores fictícios: conta `111111111111` e IPs fictícios) · **aceite:** depende da conta AWS de teste.
- **O que testar manualmente (responsável, na conta AWS de teste, com o IP do NAT da homologação):**
  - criar a pilha com o `aws cloudformation deploy` do README: o usuário nasce sem chave (`aws iam list-access-keys --user-name verax-control-reader` vazio) e sem senha;
  - criar a chave no console e, de fora do IP do nó, conferir que tudo dá AccessDenied, menos o `aws sts get-caller-identity` e o `aws sts get-session-token` (os dois não passam por política); com a sessão que o segundo devolve, ainda de fora do IP do nó, tudo dá AccessDenied;
  - do nó (com o IP do NAT), `aws s3api get-object` num objeto com SSE-KMS (o export do GuardDuty): confirma que a sessão encaminhada do S3 ao KMS preserva o IP. Se der AccessDenied no KMS, a saída é acrescentar `"Bool": {"aws:ViaAWSService": "false"}` ao `SoDoNoDaVerax` (o primeiro salto continua preso ao IP);
  - `aws iam simulate-principal-policy` do próprio usuário passa, e de outro usuário é negado;
  - com `LogObjectPrefix`, um objeto de outra conta num bucket compartilhado é negado; com `RevokeSessionsIssuedBefore`, uma sessão de `aws sts get-session-token` emitida antes é negada;
  - opcional: `CreateTrail=true` e `EnableGuardDutyExport=true` numa conta sem trilha (o log de acesso chega ao bucket da saída `AccessLogsBucketArn` em até algumas horas), e depois apagar a pilha (os buckets e a chave ficam) e criá-la de novo com as opções ligadas: a segunda criação passa, com buckets novos.
- **Riscos e pendências:**
  - o Deny de IP segue o exemplo da AWS sem `aws:ViaAWSService`, como o plano decidiu; se o KMS chamado pelo S3 não receber o IP de origem, a leitura cifrada falha até o ajuste acima (risco só de disponibilidade, nunca de acesso a mais);
  - o `sts:GetSessionToken` não pode ser negado por política; as sessões emitidas valem até 36 h depois da exclusão da chave, presas ao IP do nó, e o `RevokeSessionsIssuedBefore` as corta;
  - o `GetCallerIdentity` não pode ser negado e revela a conta e o ARN (risco aceito no plano);
  - uma pilha por conta (os nomes do IAM são únicos na conta); o export criado cobre o detector da região da pilha;
  - o cfn-guard não está no Dependabot (como o Terraform e o tflint, a versão e o SHA-256 ficam no `iac.yml`).

## Correção: reincidência do achado do GuardDuty depois da triagem

- **Decisão (responsável, 2026-11-04):** atividade nova num achado do GuardDuty já triado vira um **achado novo**; o antigo não é reaberto. A versão nova de um achado ainda não triado continua sem duplicar (fica o primeiro). Fecha a pendência registrada no PR-W2, que fixava em teste a versão nova caindo como duplicada mesmo depois da triagem.
- **Regra implementada** (`apps/api/src/alerts/wazuh-alert.ts`, `finding-draft.ts` e `finding-store.ts`):
  - o parser lê do GuardDuty a **versão** do achado: o `updatedAt`, que a AWS grava em toda versão e que só avança, com zod (ISO 8601 com fuso, inclusive na forma sem dois-pontos que o Wazuh grava, normalizada para UTC; fora do formato, ausente, sem reserva). O `service.eventLastSeen` não entra (ver "Correções da revisão"). Com id nativo, o alerta traz também o `id` do achado inteiro (`findingId`): na sondagem de porta, o `nativeId` leva o IP e a porta do item, e o `findingId` não. As outras fontes não têm os campos (`lastSeenAt` e `findingId` no alerta, `recurrence` no rascunho);
  - o achado guarda a última versão conhecida (`lastSeenAt`, coluna nova), a chave do achado inteiro (`chainKey`, coluna nova: `wazuh/<conta>/guardduty:<id>:<regra>`, a mesma no original, nas recorrências e, na sondagem de porta, no achado de cada IP) e, quando é recorrência, o original (`recurrenceOfId`, coluna nova);
  - na gravação, a chave base é tentada primeiro, como antes. Se já existe e o alerta traz a versão, quem decide é o **achado mais recente da cadeia** (pelo `chainKey`, mais o original pelo id: o original, as recorrências e, na sondagem de porta, o achado de cada IP):
    - achado sem versão conhecida (`lastSeenAt` nulo: gravado antes da coluna, ou com o `updatedAt` fora do formato na primeira versão): a versão relida vira a base de comparação (`lastSeenAt` e `chainKey` gravados), seja qual for o status, e nada mais muda;
    - versão igual ou mais antiga que a última conhecida: duplicada, nada muda;
    - achado ainda `new`: absorve a versão (só `lastSeenAt` avança; campos, severidade e evento bruto seguem os da primeira versão). Por isso a mesma versão, relida na sobreposição depois da triagem, não vira achado;
    - achado **triado**, isto é, em qualquer status fora do inicial (`investigating`, `legitimate`, inclusive o que nasceu legítimo pela exceção, e `resolved`), com versão **estritamente mais nova** pelo `updatedAt`: achado novo, com a chave do achado inteiro mais o horário (`wazuh/<conta>/guardduty:<id>:<regra>@<ISO>`), os campos, a severidade (faixa da AWS) e o evento bruto da versão nova, e `recurrenceOfId` apontando para o original. O original não muda em nada (status, campos, evento bruto, versão). Reler essa versão cai na mesma chave e não duplica. Uma recorrência ainda aberta absorve a versão seguinte; triada, a próxima vira o terceiro achado, também ligado ao original;
    - **sondagem de porta:** o wodle entrega a versão em vários alertas (um por IP), todos na mesma cadeia. A recorrência é **uma por versão** (a chave não leva o IP; os outros itens da versão caem como duplicados), nasce do primeiro item lido **sem exceção** (campos, IP e evento bruto dele, `recurrenceOfId` no achado daquele IP), e o item com exceção não a cria, porque a exceção é do IP dele, e a recorrência fala pela versão inteira; se todos os IPs têm exceção, a versão não vira nada. Um IP que aparece pela primeira vez continua virando outro achado por IP, com a própria exceção;
  - a recorrência entra no agrupamento de incidentes e na exceção como um achado comum (conta em `created` e, se for o caso, em `excepted`; a absorção, a base de comparação e a versão velha contam em `duplicates`). Nascido legítimo pela exceção (fora da sondagem), a atividade nova vira outro achado legítimo, e a exceção conta o uso;
  - isolamento: a chave estrangeira da recorrência leva o cliente (`(recurrenceOfId, tenantId) → (id, tenantId)`, como a dos comentários), então nunca aponta para achado de outro cliente; a cadeia é lida no escopo do cliente (índice `(tenantId, chainKey)`). O mesmo `id` de achado no bucket de outro cliente é o achado dele (a chave leva a conta). A chave ocupada por achado de outro cliente (conta recadastrada) não é vista pelo escopo, e nada é criado nem tocado;
  - as chaves da sondagem de porta por IP e das correlações não mudam; a chave com horário cabe na coluna (o id longo entra pelo resumo, 111 caracteres no máximo).
- **Migration** `20261105120000_finding_recurrence`: as três colunas nulas (`lastSeenAt`, `chainKey`, `recurrenceOfId`), os índices (`recurrenceOfId` e `(tenantId, chainKey)`) e a chave estrangeira composta. Nenhum achado do Wazuh existe em produção, então nada é migrado.
- **Painel e contrato compartilhado:** sem mudança; a recorrência aparece como um achado novo comum. O vínculo com o original fica no banco para uma tela futura.
- **Dependências:** nenhuma.
- **Testes:**
  - alerta (5 testes, um novo e quatro alterados): a versão é o `updatedAt` com a fixture passada por `asWazuhWrites` (o `count` em texto) e o `eventLastSeen` mais antigo de propósito, fuso sem e com dois-pontos, oito valores fora do formato (texto, só data, milissegundos, vazio, espaço, número, booleano, nulo) deixando o achado sem versão mesmo com o `eventLastSeen` válido, as outras fontes sem o campo; o `findingId` em cada fonte, igual em todos os itens da sondagem de porta, ausente no item fora do formato, e no achado do wazuh-logtest;
  - chave e rascunho (3 testes, um novo e dois alterados): a chave da recorrência (achado inteiro mais horário da versão), a mesma versão relida com a mesma chave e outra versão com outra, as três chaves no rascunho (base, cadeia e recorrência), a sondagem de porta com a base por IP e a cadeia e a recorrência iguais em todos os itens, o id longo com o horário entrando pelo resumo; o rascunho do WAF, o do GuardDuty sem versão e o da sondagem sem id nativo sem `recurrence`;
  - sync com banco real (13, no lugar dos dois do PR-W2): três versões sem triagem viram um achado com a versão da mais nova e a versão do meio relida não muda nada; para **cada status triado** (`investigating`, `legitimate`, `resolved`), a versão nova vira o segundo achado (status `new`, severidade crítica pela faixa da AWS contra a média do original, evento bruto da versão nova, ligado ao original) e o original fica idêntico, e reler a versão nova e a antiga não faz um terceiro; já triado, a mesma versão e uma mais antiga não viram nada; a recorrência aberta absorve a terceira versão e, triada, a quarta vira o terceiro achado ligado ao original (e a terceira relida não vira nada); nascido legítimo pela exceção, a atividade nova vira outro achado legítimo com a exceção contando dois usos e sem incidente; **sondagem de porta** com três IPs triados: a versão nova vira um achado só (chave sem IP, na cadeia), relida não vira nada, a recorrência aberta absorve a versão seguinte mesmo chegando primeiro pelo IP de outro original, e triada a próxima vira outro achado só, com os originais por IP intactos; sondagem com o IP autorizado chegando primeiro: ele não cria a recorrência, o IP sem exceção cria (sem exceção, com o evento bruto dele), a versão só com o IP autorizado não vira nada, o IP novo é outro achado por IP na mesma cadeia, e a exceção conta um uso só; achado triado sem versão conhecida (linha semeada sem `lastSeenAt`): a versão relida vira a base (`lastSeenAt` e `chainKey` gravados, status intacto) e só a seguinte vira recorrência; versão nova com o `eventLastSeen` atrás do `updatedAt` da anterior (que saiu sem `eventLastSeen`) vira recorrência mesmo assim; **A/B** (o mesmo `id` no bucket de B é o primeiro achado de B, nunca recorrência do de A, e o de A fica idêntico; a chave de A ocupada por um achado de B não é vista nem tocada pelo sync de A, e nada é criado);
  - os quatro testes das correções da revisão falham com a correção correspondente desfeita (conferido revertendo cada trecho);
  - Resultado: API 66 arquivos e 884 testes (871 antes do fix); lint, tipos e Prettier limpos; `prisma migrate diff` entre as migrations e o schema sem diferença. O compartilhado e o painel não mudaram.
- **Definição de pronto:** decisão implementada ✔ · testes, com A/B ✔ · lint e tipos ✔ · nenhuma dependência ✔ · regras de segurança ✔ (entrada validada com zod, escopo por cliente e chave estrangeira com o cliente, dados fictícios).
- **O que testar manualmente:** no nó de homologação com o PR-W1, resolver um achado do GuardDuty e esperar a próxima exportação com atividade nova (o `count` sobe no console do GuardDuty): o painel mostra um achado novo, e o resolvido continua resolvido. Numa sondagem de porta com mais de um IP, resolver todos e esperar a exportação seguinte: aparece um achado só.
- **Riscos e desvios:**
  - `service.count` não é extraído: não há coluna para compará-lo, e o `updatedAt` sozinho decide. Uma versão gravada pela AWS sem atividade nova (raro: o GuardDuty atualiza o achado quando a atividade se repete) contaria como versão nova. Sem `updatedAt` válido, a versão cai como duplicada (ou vira a base de comparação de um achado sem versão), como antes;
  - o achado não triado **absorve** a versão nova (só `lastSeenAt` avança), em vez de ficar intocado: sem isso, a versão já descartada como duplicada, relida na sobreposição logo depois da triagem, viraria um achado por atividade anterior à triagem. Pelo mesmo motivo, o achado triado sem versão conhecida recebe `lastSeenAt` e `chainKey` da versão relida (só esses dois campos, de controle);
  - a recorrência de um achado nascido legítimo pela exceção vira outro achado legítimo a cada exportação com atividade nova (uma varredura autorizada contínua pode gerar um por exportação, como já acontece por evento no CloudTrail). Na sondagem de porta, não: o item com exceção não cria recorrência;
  - a recorrência da sondagem de porta leva o IP, o título e o evento bruto de um item só (o primeiro sem exceção que o sync leu), e o `recurrenceOfId` aponta para o achado daquele IP; os outros IPs da versão seguem no evento bruto do indexer e no console do GuardDuty;
  - a recorrência aponta sempre para um original (não para a recorrência anterior); a cadeia inteira sai pelo `chainKey`.
- **Correções da revisão** (revisão independente do fix, 2026-11-04):
  1. **[alta] sondagem de porta multiplicava recorrências:** cada item da sondagem (`<id>/<IP>:<porta>`) era uma cadeia própria com o mesmo horário do achado inteiro, e o wodle reemite todos os itens a cada exportação: com N achados por IP triados, uma sonda nova virava N recorrências, a cada exportação. Agora a reincidência é do achado inteiro: o parser expõe o `id` do achado (`findingId`), o rascunho monta a cadeia e a chave da recorrência sem o IP, a coluna `chainKey` (com índice por cliente) liga o original, as recorrências e os achados por IP, e a gravação decide pela cadeia inteira (uma recorrência por versão; o item com exceção não a cria). Teste com três IPs triados: a versão nova vira exatamente um achado, relida não vira nada;
  2. **[média] achado triado sem `lastSeenAt` virava recorrência ao reler a mesma versão:** a linha sem versão (anterior à coluna, ou com horário fora do formato na primeira versão) agora recebe a versão relida como base de comparação, seja qual for o status, e a releitura cai como duplicada. Teste com a linha semeada resolvida e sem `lastSeenAt`;
  3. **[baixa] `eventLastSeen` e `updatedAt` misturados entre versões:** a primeira versão sem `eventLastSeen` guardava o `updatedAt`, e a seguinte, com um `eventLastSeen` anterior a ele, caía como antiga. O comparador agora é só o `updatedAt`, presente em toda versão e monotônico; o `eventLastSeen` não é lido (não há tela que o mostre). Teste do caso misto;
  4. **[baixa] contagens de testes no registro:** corrigidas acima (sync com banco real: eram 9, e não 8; agora 13).

## Fase 2, PR-05: conexão de projeto GCP de cliente, sem acesso ao projeto ⚠️ altera `infra/`

- **Pedido:** um projeto GCP de cliente entra no monitoramento sem que a Verax ganhe nenhum papel nele (plano da fase 2, PR-05; o "revisor de segurança no projeto" dos passos do painel contrariava a arquitetura, C11). Antes, o Terraform só sabia criar o sink dentro do projeto monitorado, o que só funciona em projetos da própria Verax. Nada foi aplicado: o projeto dos nós de clientes ainda não existe (nasce na primeira venda) e a homologação segue sem apply.
- **Como funciona:** o painel mostra o comando `gcloud logging sinks create` pronto (filtro de segurança, tópico do nó); o cliente roda no projeto dele e cola no painel a identidade do sink, que a GCP criou (`serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com`); a Verax põe projeto e identidade em `customer_projects`, aplica (quatro recursos, todos no projeto do nó: tópico, assinatura, a publicação só para essa identidade e a leitura da assinatura pela conta de serviço do nó) e informa a assinatura na conta. Nenhuma chave de conta de serviço é criada, e nada no projeto do cliente muda.
- **Terraform (`infra/gcp/`, revisar linha a linha):**
  - **`modules/node`:** variável `customer_projects = map(object({ writer_identity }))`, padrão vazio, com três validações: a chave é um ID de projeto; a identidade é só o agente do Cloud Logging do projeto (regex `serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com`, que recusa conta de serviço comum, pessoa, grupo, a identidade compartilhada antiga `cloud-logs@system` e os agentes de pasta e organização); e um projeto não fica nas duas listas. Em `logs.tf`, o tópico e a assinatura passam a iterar `local.log_projects` (monitorados + clientes, o mesmo nome `<prefixo>-security-<projeto>`), o sink continua só nos monitorados, e o `google_pubsub_topic_iam_member.customer_sink_publisher` dá `roles/pubsub.publisher` no tópico do projeto só à identidade do cliente. O `node_subscriber` e o alerta de fila parada já cobrem a assinatura nova (iteram as assinaturas e o prefixo).
  - **`envs/homolog-sp`:** variável `customer_projects` repassada ao módulo, exemplo comentado no `terraform.tfvars.example` e a descrição da saída `pubsub_subscriptions`.
  - **`envs/verax`:** nenhuma mudança (o padrão vazio dá a mesma lista de antes); o `startup.sh` continua byte a byte igual (`sha256` conferido).
- **Pacote do nó (`infra/node/bin/start.sh`, revisar linha a linha):** o `api.env` ganha `GCP_SINK_TOPIC_PREFIX=projects/$VERAX_GCP_PROJECT/topics/$VERAX_SECRET_PREFIX-security-`, o começo do nome dos tópicos do nó (o prefixo dos cofres é o `name_prefix` do módulo). Não é segredo; o `node.conf` não muda.
- **Schema e API:**
  - migration `20261105110000_cloud_account_sink_writer_identity`: `CloudAccount.sinkWriterIdentity VARCHAR(128)` nula, com `CHECK (provider = 'gcp' OR sinkWriterIdentity IS NULL)`, no padrão das outras restrições fora do schema do Prisma. Nenhuma conta existente muda;
  - `packages/shared`: `sinkWriterIdentitySchema` (a mesma regex do módulo), `normalizeSinkWriterIdentity` (o aviso do gcloud entre crases ou só o e-mail viram a forma completa), `GCP_SINK_LOG_FILTER`, `gcpSinkCommand` e `gcpSinkIdentityCommand`; `sinkWriterIdentity` no cadastro e na alteração da GCP (recusado nos outros provedores por `fieldsOutsideProvider`), e `sinkTopic` e `sinkWriterIdentity` na conta devolvida;
  - `env.schema.ts`: `GCP_SINK_TOPIC_PREFIX` opcional, só no formato `projects/<projeto>/topics/<prefixo>-security-`; sem ele (ambiente local), `sinkTopic` é null e o painel mostra o comando com o tópico a preencher;
  - `cloud-accounts.service.ts`: grava e devolve a identidade, com o antes e o depois na auditoria como os outros campos, sem mexer na conexão (a identidade não é a fonte que o nó lê); a identidade entra na checagem de origens com lock (uma identidade é de um projeto, e um projeto é de um cliente: colada em outro cliente, 409 sem dizer de quem). Quem pode gravar é quem já tem `cloud_accounts:write`.
  - O sync da GCP não muda: a assinatura do projeto de cliente tem o mesmo nome dos monitorados e um projeto só, então cada evento vai para o cliente do projeto; de outro projeto ou de outro cliente, vai para a fila sem dono.
- **Painel (`cloud-accounts-page.tsx`):** os passos da GCP viram o comando do sink pronto (com o botão de copiar), o comando que mostra a identidade, o campo "Identidade do sink" (só para quem tem `cloud_accounts:write`; os demais veem a identidade salva) e o aviso de que a Verax libera a publicação só para ela e informa a assinatura. Sai o "revisor de segurança". Mocks com `sinkTopic` e `sinkWriterIdentity` (o projeto da demonstração vira projeto de cliente, com a assinatura no projeto do nó), texto do tour, testes da tela e o painel de detalhe do projeto na revisão de acessibilidade do e2e.
- **Documentação:** `docs/runbooks/onboarding-cliente.md` (seção 5, o roteiro inteiro), `infra/gcp/GUIA.md` (seção "Projeto de cliente: o sink é do cliente", com o teste na homologação com um projeto de outra organização e o aviso da restrição de domínio) e `docs/ARQUITETURA.md` (tabela dos provedores e o item da fase 2).
- **Dependências:** nenhuma.
- **Testes:**
  - `packages/shared` (164): identidade aceita e as recusadas (compartilhada antiga, conta comum, pasta, organização, sink antigo, pessoa, grupo, sem o tipo, maiúscula, domínio parecido, com o resto do aviso, vazia, longa demais), só na GCP, a normalização e o comando (sem `add-iam-policy-binding` nem papel);
  - API (68 arquivos, 892 testes, banco real): `gcp-customer-project.test.ts` com o tópico na conta (lista e detalhe) e null na AWS; a identidade gravada e auditada sem mexer na conexão, e `null` apaga; no cadastro; as inválidas com 400 sem gravar; só na GCP, na API (400) e no banco (a `CHECK`); **A/B:** a identidade de A não entra em B no cadastro nem na alteração (409 sem dizer de quem), B não a vê na lista, e a suíte genérica de isolamento; leitura vê e não grava (403); o log da requisição não leva a identidade (`log-capture`). `gcp-audit-sync.test.ts`: com a topologia de projeto de cliente (assinatura `<prefixo>-security-<projeto>` no projeto do nó, identidade na conta), o evento do projeto de A vira achado de A, e um evento do projeto de B pela assinatura de A vai para a fila sem dono (`source_mismatch`), nunca para B. `gcp/sink-contract.test.ts` prende o painel ao Terraform e ao `start.sh`: o filtro do comando é o `security_log_filter` de `logs.tf` sem a exclusão do nó, a regex da API é a do módulo, e o tópico do `start.sh` é o nome que o módulo dá;
  - `terraform fmt -check`, `init -backend=false` e `validate` no módulo e nos dois ambientes; `terraform test` do módulo (25 casos: os 16 de antes mais `projetos_de_clientes`: tópico, assinatura e saída iguais aos monitorados, nenhum sink no projeto do cliente, publicação só da identidade do cliente e só no tópico dele, leitura pelo nó e cobertura do alerta, só projetos de clientes, e as recusas: identidade compartilhada antiga, conta comum, agente de pasta ou organização, pessoa ou grupo, sem o tipo, projeto inválido e projeto nas duas listas), do `envs/homolog-sp` (5: o `customer_projects` chega ao módulo, a assinatura sai e nenhum sink é criado; sem projeto, como antes) e do `envs/verax` (3). O `lean_verax` ganhou a asserção de que o nó da Verax não ganha tópico, assinatura nem publicação de projeto de cliente;
  - tflint 0.65.0 recursivo e checkov 3.4.0 (os do CI) em `infra/`, sem falhas; shellcheck no pacote do nó;
  - painel: 250 testes (`admin-pages.test.tsx`: o comando aponta para o tópico do nó, sem `AND NOT` e sem "revisor de segurança"; o admin cola a identidade entre crases e ela vira a forma completa, a inválida é recusada; quem só lê vê o comando e a identidade sem os campos) e o e2e `pages.mock.spec.ts` (53, com o painel do projeto da GCP sem violação de acessibilidade); `pnpm typecheck`, eslint e prettier limpos.
- **Decisões onde o plano estava aberto:**
  - a regex aceita só o agente do projeto (`service-<número>`), como o pedido diz. Um sink de pasta ou organização (agregado) publicaria logs de vários projetos no tópico de um só, e o sync os mandaria para a fila sem dono; o formato dos sinks de antes de 2023 (`p<número>-<id>`) não é o que o `sinks create` devolve hoje;
  - o tópico chega ao painel pela API (`sinkTopic`), montado de `GCP_SINK_TOPIC_PREFIX`, que o `start.sh` deriva do `node.conf` em vez de pedir uma linha nova: o prefixo dos cofres já é o `name_prefix` do módulo, e o teste de contrato prende os três;
  - a identidade é única entre clientes pela mesma checagem com lock das outras origens (mensagem genérica), e não por `@unique` no banco, para a resposta ser a mesma das outras origens. Ao contrário das outras origens, ela também não se repete entre as contas do mesmo cliente (correção da revisão, abaixo): o `@@unique([provider, accountId])` só impede o mesmo projeto duas vezes, não a mesma identidade em dois projetos;
  - a troca da identidade não volta a conexão para `waiting`: ela não é a fonte lida, e um projeto já conectado não deve parecer parado por causa dela.
- **Desvios do plano:** o Terraform fica em `infra/gcp/modules/node` (o `infra/gcp/logs.tf` do plano virou o módulo no PR-04'), e o ambiente que o recebe é `envs/homolog-sp`; o `start.sh` entrou (o plano não o citava) para o painel conhecer o tópico do nó.
- **Definição de pronto:** comando pronto, identidade colada e Terraform só com a publicação para ela ✔ · A/B e isolamento ✔ · `plan` do nó da Verax sem mudança (por teste; o `plan` contra o estado real fica com o responsável) ✔ · validate, tflint, checkov e shellcheck ✔ · nenhuma dependência ✔ · regras de segurança ✔ (nenhum projeto, identidade ou e-mail real; a identidade não é segredo e não vai para o log) · **aceite:** depende do teste manual na homologação.
- **Pendências para o responsável:**
  - `plan` só de leitura de `envs/verax` contra o estado real: tem de dar 0, 0 e 0 (a variável nova tem padrão vazio);
  - aplicar a migration no nó da Verax no próximo deploy (`db:deploy`; a coluna nasce nula e a restrição só vale para a GCP). O `api.env` do nó ganha o `GCP_SINK_TOPIC_PREFIX` na próxima partida pelo `start.sh` novo;
  - o teste manual do plano, quando a homologação subir: um projeto de **outra organização** cria o sink com o comando do painel e cola a identidade; `customer_projects` no `terraform.tfvars`, `apply`, assinatura na conta; conferir, nesta ordem, o log `logging.googleapis.com/sink_error` do projeto do cliente **sem `PERMISSION_DENIED`** depois de uma ação posterior ao `apply` (o portão do desenho: ver "Correções da revisão"), o `pull` e o `get-iam-policy` do tópico (GUIA). É esse teste que valida o risco da restrição de domínio (plano, §7, item 9): se a organização da Verax a ligar, o `apply` do projeto dos nós falha e precisa de exceção.
- **Riscos:**
  - a identidade do sink identifica o projeto pelo número, e o cadastro pelo ID: o painel não tem como conferir que a identidade colada é a do projeto cadastrado. Uma colada errada dá a publicação a outro projeto do mesmo cliente; a mesma identidade em dois projetos é recusada pela API e pelo módulo (correção da revisão), e o `pull` de conferência do GUIA mostra o resto;
  - o sink do cliente é criado antes do tópico existir: até o `apply`, o Cloud Logging registra erros de exportação no projeto do cliente (sem perder nada que já estivesse lá) e os eventos desse intervalo não chegam ao nó;
  - um cliente que apague o sink ou mude o filtro deixa a conta em `waiting` sem erro: a GCP entrega por evento, e o alerta de fila parada só vê mensagens que chegaram. O estado por conta (D-x da fase 2) continua dependendo do primeiro evento.
- **Correções da revisão (duas revisões independentes), com testes novos:**
  - a documentação da Google para sinks ("Configure and manage sinks", _Set destination permissions_; "Route logs to Pub/Sub", passo 7) pede para a identidade do sink no destino `roles/pubsub.publisher` **e** `roles/logging.logWriter` (`logging.logEntries.route`); o módulo concede só o `pubsub.publisher` no tópico, e sem a GCP não dá para confirmar se um destino em outro projeto exige o segundo. Nenhuma concessão no nível do projeto entrou. Em vez disso: o log `logging.googleapis.com/sink_error` do projeto do cliente, sem `PERMISSION_DENIED` depois de uma ação posterior ao `apply`, virou o primeiro portão do teste na homologação (GUIA e runbook, com o `gcloud logging read` exato); a decisão, se o `logWriter` for exigido, ficou registrada no GUIA antes da primeira venda (`roles/logging.logWriter` no projeto do nó à identidade do sink, restrito por condição do IAM ao tópico do projeto se a condição valer para `logging.logEntries.route`; se não, por variável própria do módulo, desligada por padrão, com o custo aceito e registrado: a identidade passa a poder gravar logs no projeto do nó, e só isso); e o "só três coisas, nada no nível do projeto" virou o que o módulo cria mais "o teste na homologação confirma que basta";
  - a mesma identidade de sink entrava em dois projetos do mesmo cliente: `assertOriginsFree` só olhava os outros clientes, e as duas frases do STATUS (o `@@unique([provider, accountId])` impediria; o `apply` falharia por repetição) eram falsas: o unique é por projeto, e o IAM aceita o mesmo membro em dois tópicos. Agora a API recusa (409, mensagem genérica) a identidade já usada por outra conta do mesmo cliente, no cadastro e na alteração (a própria conta pode repetir a sua), com teste de banco real; o módulo recusa `writer_identity` repetida em `customer_projects` (`distinct`), com caso no `projetos_de_clientes.tftest.hcl`; as duas frases foram corrigidas;
  - o `start.sh` escrevia `GCP_SINK_TOPIC_PREFIX` de `VERAX_GCP_PROJECT` e `VERAX_SECRET_PREFIX` sem conferir nada, e a API recusa a variável fora do formato: um `node.conf` fora das regras do módulo derrubaria a API, e o `install.sh` só conferia presença. Agora o `install.sh` recusa os dois fora das regras do módulo (`project_id`, a mesma do `deploy.sh`, e `name_prefix`), e o `start.sh` só escreve a variável quando os dois valem (fora disso, avisa e a API sobe com o "tópico a preencher" do painel). O `sink-contract.test.ts` prende as regexes do módulo, do `install.sh`, do `start.sh`, do `deploy.sh` e do `env.schema.ts` umas às outras, e o novo `infra/node/tests/start-test.sh` (sem root, sem Docker, `gcloud` simulado) roda o `render` com o `node.conf` de exemplo e com o prefixo e o projeto fora do formato; entrou no job do pacote do nó do `iac.yml` (⚠️ `.github/`);
  - o runbook e o GUIA diziam "só três coisas"; são quatro recursos (faltava a leitura da assinatura pela conta de serviço do nó, `node_subscriber`). Corrigido nos dois, no "Passo 5" do GUIA (4 por projeto de cliente) e na tabela de origens do `docs/ARQUITETURA.md`, que ganhou a identidade do sink;
  - no nó da Verax, o painel mostrava o comando do sink também para os projetos de `monitored_projects`, cujo sink o Terraform já criou: segui-lo criaria um segundo sink e dobraria o medidor de uso. Os passos da GCP ganharam a nota ("se o projeto está em `monitored_projects` do nó, o sink já existe: não rode"), sem flag por conta, com asserção no teste da tela;
  - a premissa de que o `VERAX_SECRET_PREFIX` do `node.conf` é o `name_prefix` do ambiente (o teste de contrato prende o painel ao Terraform, não ao `node.conf` instalado) ficou escrita no runbook do nó, no GUIA e no `node.conf.example`;
  - o CodeQL do PR apontou regex polinomial em `normalizeSinkWriterIdentity` (`^[\s`'"]+|[\s`'"]+$` com `g`: a segunda alternativa era tentada em cada posição, e uma identidade colada com milhares de tabulações seguidas de outro caractere custava tempo quadrático, ~300 ms com 10 mil e ~10 s com 50 mil). A normalização passou a andar pelas pontas da string caractere a caractere (linear, mesmo resultado em todas as formas); a regex estrita da identidade não mudou, e as outras regexes do PR (`GCP_SINK_TOPIC_PREFIX` no `env.schema.ts`, ancorada e com quantificadores limitados) ficaram como estão. Testes novos no `packages/shared`: as formas aceitas (crases, aspas simples e duplas, espaços, tabulações, só o e-mail) e a entrada com 10 mil tabulações em volta do valor, concluída em menos de 50 ms.

## Fase 3, plano de controle: ambiente `envs/control-plane` em Terraform ⚠️ altera `infra/` e `.github/`

- **Pedido:** a parte da GCP do plano de controle da fase 3 (`plano-controle.md`, seção 9, itens 8 a 12, mais o que o Terraform consegue fazer do Firebase e do Cloudflare) como `terraform apply`, no projeto da Verax que hospeda o Firebase dos painéis (decisão do responsável: o rewrite do Hosting exige o mesmo projeto). Nada foi aplicado.
- **Terraform (`infra/gcp/envs/control-plane/`, revisar linha a linha):**
  - **`apis.tf`:** 15 APIs com `disable_on_destroy = false`; a leitura do projeto com `depends_on` nas APIs, como na homologação.
  - **`firestore.tf`:** banco `(default)` nativo em `southamerica-east1`, protegido contra exclusão (`DELETE_PROTECTION_ENABLED`, `deletion_policy = "ABANDON"`); TTL em `expiresAt` nas coleções com retenção do plano (`slugs`, `stripeEvents`, `statusTokens`, `rateLimits`, `provisioningRuns`, `steps`, `auditLog`), com o contrato de quem grava o campo no comentário; os 4 índices compostos de `tenants`. **PITR desligado por padrão** (`firestore_pitr`): conferido em 04/11/2026 nos preços do Firestore que o armazenamento do PITR é cobrado à parte, sem nível gratuito e com no mínimo 1 dia cobrado.
  - **`identities.tf`:** `cp-public`, `cp-worker`, `cp-terraform` e `cp-deployer` com os papéis da seção 2.2 que valem neste projeto, cada um no menor recurso (fila, segredo, Job, conta): `datastore.user` no projeto; `cloudtasks.enqueuer` por fila; `iam.serviceAccountUser` do `cp-public` (e do próprio `cp-worker`) em `cp-worker`; `firebasehosting.admin` neste projeto (o primeiro do pool) e nos de `firebase_panel_projects`; o papel personalizado `cpJobRunner` (`run.jobs.run`, `run.jobs.runWithOverrides`, `run.executions.get/list`), concedido no próprio Job; `run.developer` nos dois serviços e no Job, `serviceAccountUser` nas três contas e `artifactregistry.writer` para o `cp-deployer`. Pool e provedor de federação `cp-github` próprios deste projeto (o do Painel está em outro projeto e fora do Terraform), com a condição no subject do environment `control-plane` e nos IDs fixos do repositório e do dono (molde do `envs/verax`), e a concessão `workloadIdentityUser` só para esse subject.
  - **`secrets.tf`:** os cinco segredos `cp-*` vazios, réplica só na região, `secretAccessor` por segredo e por conta (public: chave da Stripe, webhook, cookie; worker: chave da Stripe, Cloudflare, SMTP). Nenhum `google_secret_manager_secret_version`; o `iac.yml` confere.
  - **`images.tf`:** registro `verax-control-plane` neste projeto e nesta região (o do nó fica em outro projeto e região; um registro aqui evita leitura entre projetos e tráfego entre regiões, pelo mesmo custo), tags imutáveis e limpeza como no do nó; `cp-deployer` publica. Sem leitura para as contas de execução: quem baixa a imagem é o agente de serviço do Cloud Run, que já lê os registros do projeto.
  - **`run.tf`:** `cp-public` (1 vCPU, 512 MiB, concorrência 80, 0 a 2, 60 s, `INGRESS_TRAFFIC_ALL`, `allUsers` como invoker, exigido pelo rewrite) e `cp-worker` (0 a 1, 900 s, `INGRESS_TRAFFIC_INTERNAL_ONLY` por padrão, invoker só para a própria conta e `owner_principals`); CPU só na requisição; `deletion_protection`; variáveis da seção 2.5 como `service_env_defaults` + `service_env` (do responsável) + o que o Terraform sabe (URL determinística do worker, contas, filas, pool dos painéis), sem valor vazio; segredos montados como variável (`latest`); Job `cp-terraform` (1 vCPU, 2 GiB, 1800 s, 1 tentativa). Imagem com placeholder (a de exemplo do Google) e `ignore_changes` na imagem, `client` e `client_version`, para o workflow e o Terraform não brigarem. **`services_enabled` (padrão `false`)** adia serviços, Job, Scheduler e o rewrite para a segunda subida: o Cloud Run recusa uma revisão que monte um segredo sem versão.
  - **`tasks.tf`:** filas `provisioning` e `lifecycle` (8 tentativas, 30 s a 600 s, 4 dobras, 2 despachos); `tick` a cada hora e `reconcile` às 3 h de São Paulo, com OIDC da conta do `cp-worker` (seção 9, item 10) e `audience` na URL do worker.
  - **`hosting.tf` (provider `google-beta` 8.9.0, só aqui):** site `verax-conta`, versão com o rewrite `/**` → `cp-public` em `southamerica-east1`, release, e o domínio `conta.veraxsistemas.com.br` sem esperar o DNS; os registros saem em `output cloudflare_dns_records`. Na 8.9.0 esses quatro recursos existem só no beta (conferido no schema do provider).
  - **`monitoring.tf`:** canal de e-mail opcional e dois alertas por log (`condition_matched_log`, sem métrica): `jsonPayload.event="provisioning_failed"` no `cp-worker` e `jsonPayload.event="stripe_webhook_signature_failed"` no `cp-public`, um aviso por hora; o contrato dos campos (`event`, `tenantId`, `step`, `code`, `requestId`) está no comentário, para o CP-04 e o CP-12.
  - **`budget.tf`:** orçamento de R$ 15 (opcional). **`cross_project.tf`:** opcional e desligado por padrão: com `nodes_project_id`, os 12 papéis do `cp-terraform` no projeto dos nós, `objectAdmin` no bucket `<projeto>-tfstate`, o papel `cpNodeLifecycle` do `cp-worker` com condição `vx-*` e `objectViewer` só em `runs/`; com `images_project_id`, um papel personalizado só para gravar a política do registro das imagens; com `release_bucket`, leitura para o `cp-worker`. TODO para o `envs/nodes-platform` (CP-06) no cabeçalho.
  - **`outputs.tf`:** `github_environment` (GCP_WIF_PROVIDER, GCP_DEPLOYER_SA, GCP_PROJECT_ID, GCP_PROJECT_NUMBER, GCP_REGION, CP_IMAGES_REPOSITORY, CP_PUBLIC_SERVICE, CP_WORKER_SERVICE, CP_TERRAFORM_JOB), `cloudflare_dns_records`, contas, segredos, URLs, site e banco.
  - **`terraform.tfvars.example`**, **`.terraform.lock.hcl`** (`google` 8.9.0 com os mesmos hashes dos outros ambientes e `google-beta` 8.9.0, 4 plataformas) e **`tests/`** com provider simulado: `identidades` (os papéis de cada conta um a um, nada anônimo no worker nem no Job, o provedor e a concessão da federação, o projeto dos nós preenchido e vazio, grupo recusado), `servicos` (primeira subida sem serviços, tamanhos, variáveis e segredos de cada serviço sem valor vazio, filas, relógio, rewrite, a imagem trocada pelo workflow que fica, o worker aberto só por escolha, entrada inválida) e `dados_e_alertas` (Firestore, PITR, alertas com e sem e-mail, orçamento, APIs). 17 casos.
- **`.github/` (revisar linha a linha):** `iac.yml` valida e testa o ambiente novo e confere que nenhum `google_secret_manager_secret_version` entra nele; `dependabot.yml` acompanha o lock dele.
- **Documentação:** `infra/gcp/GUIA.md`, seção "O plano de controle": o que cria, custo, as duas subidas (66 recursos; depois 13 mais 1 por operador), os segredos, o DNS, o environment do GitHub (saídas → variáveis), o que continua manual (Stripe, Blaze, Cloudflare, GitHub, `service_env`) e as operações do responsável.
- **Dependências:** nenhuma de npm. Provider `google-beta` 8.9.0 só neste ambiente, pelo Firebase Hosting.
- **Testes:** `terraform fmt -check -recursive infra/gcp`; `init -backend=false -lockfile=readonly` e `validate`; `terraform test` (17 casos, provider simulado; mutação conferida: sem o `ignore_changes` da imagem, o caso `imagem_trocada_pelo_workflow_fica` falha); tflint 0.65.0 recursivo em `infra/gcp` sem avisos; checkov 3.4.0 (a imagem do CI) com 31 aprovados e 2 exceções inline justificadas (`CKV_GCP_84`, a mesma do registro do nó; `CKV_GCP_125`, que trata todo subject com `environment` como abusável, embora seja o desenho do Painel e das imagens, com os IDs fixos por cima); `prettier --check` em `docs`, `infra` e `.github`; actionlint no `iac.yml`. Nada falou com a GCP.
- **Desvios do plano e decisões, com motivo:**
  - PITR do Firestore desligado (não é gratuito); `firestore_pitr` liga.
  - `cp-worker` com entrada só interna por padrão (defesa a mais sobre o IAM); as operações do responsável da própria máquina pedem `worker_ingress = "INGRESS_TRAFFIC_ALL"` temporariamente. O `aud` de um token de usuário do gcloud não é a URL do serviço: como o worker aceita o responsável fica para o CP-11.
  - `cp-worker` com `iam.serviceAccountUser` em si mesmo, que a seção 2.2 não lista: o Cloud Tasks exige a permissão de quem cria a task com o token de uma conta, mesmo da própria. _(Substituído pela `cp-invoker` nas correções da revisão, abaixo.)_
  - TTL também em `steps` (o TTL não desce para subcoleções) e em `auditLog` (24 meses, a retenção do plano); o nome do campo de `provisioningRuns` e `steps` (`expiresAt`) é decisão deste PR, registrada no comentário para o CP-02.
  - Registro de imagens próprio neste projeto, em vez do registro do nó em outro projeto e região.
  - Pool de federação próprio (`cp-github`) em vez do pool do Painel, que fica em outro projeto e fora do Terraform; o subject padrão do GitHub (`repo:dono/repo:environment:control-plane`) com os IDs fixos na condição, em vez do subject com IDs do provedor do Painel, que é um mapeamento daquele provedor.
  - Leitura do registro para as contas de execução não concedida: o Cloud Run baixa a imagem com o agente de serviço, não com a conta do serviço.
  - Duas subidas (`services_enabled`): o Cloud Run não sobe com segredo vazio, e os segredos nunca passam pelo Terraform.
- **Definição de pronto:** ambiente completo ✔ · validate, tflint, checkov, tftest ✔ · nenhuma dependência de npm ✔ · regras de segurança ✔ (nenhum ID de projeto, conta ou e-mail real no código; só os IDs públicos do repositório no GitHub, já em `envs/verax`) · **aceite:** depende do apply pelo responsável.
- **Pendências para o responsável (GUIA, "O plano de controle"):** passos 1 a 7 (login e Blaze, variáveis, primeira subida, os cinco segredos, segunda subida antes do primeiro deploy do CP-01, registros no Cloudflare sem proxy, environment `control-plane` no GitHub com as saídas) e o que continua manual (Stripe itens 1 a 7, Cloudflare item 13, `service_env`, primeira venda).
- **Riscos:**
  - o `google_firestore_field` sem `index_config` deve ficar sem diferença no `plan` seguinte (o provider descarta a configuração herdada); se mostrar diferença, acrescentar `index_config {}` com o índice padrão;
  - o `plan` depois da primeira implantação pelo workflow deve dar `No changes.`; outra diferença que o gcloud grave entra no `ignore_changes`;
  - a URL determinística do `cp-worker` (`https://cp-worker-<número>.<região>.run.app`) é a que o Cloud Run publica para serviços novos; se o projeto tiver a URL determinística desligada, `terraform output worker_url` e a URL real do serviço divergem, e `WORKER_URL` e o Scheduler precisam da URL real;
  - a versão do Hosting só com o rewrite e sem arquivo foi montada pelo exemplo do provider; se o Firebase exigir um arquivo, o CP-01 publica um `index.html` mínimo pela mesma versão;
  - `firebasehosting.admin` para o `cp-worker` neste projeto alcança também os sites do Painel que já existem aqui (é o desenho do plano: um pool compartilhado). _(Removido nas correções da revisão, abaixo: o pool dos painéis dos clientes é outro projeto.)_
- **Correções da revisão (IAM/segurança e correção, mesmo PR, nada aplicado):**
  - **I1 (agentes de serviço):** `google_project_service_identity` (provider beta) do Cloud Tasks e do Cloud Scheduler, com `iam.serviceAccountUser` dos dois na `cp-invoker`. O que o Google documenta como exigência é o papel de agente de serviço de cada um, concedido ao ligar a API; o recurso garante que o agente existe antes do primeiro job e da primeira task (num projeto que acabou de ligar a API, a criação do job do Scheduler falha antes disso), e a concessão explícita vale mesmo que aquele papel encolha. O Scheduler entrou pelo mesmo motivo, embora a revisão só citasse o Tasks.
  - **I2 (`cp-invoker`):** quinta conta, só com `run.invoker` no `cp-worker`. `cp-public` e `cp-worker` agem como ela (e não mais como o `cp-worker`; a concessão do `cp-worker` em si mesmo saiu). O Scheduler e `WORKER_SA_EMAIL`/`SCHEDULER_SA_EMAIL` apontam para ela; `CP_WORKER_SA` do Job continua o `cp-worker` (é a ele que o `envs/tenant` dá os papéis por tenant). Contrato com o app (plano, 2.5, inalterado na forma): `aud == WORKER_URL` e `email ∈ {WORKER_SA_EMAIL, SCHEDULER_SA_EMAIL} ∪ OWNER_PRINCIPALS`.
  - **I3 (projeto dos nós):** `secretmanager.admin` e `storage.admin` saem; entram `cpSecretsProvisioner` (`secrets.{create,delete,get,list,update,getIamPolicy,setIamPolicy}` + `versions.list`) e `cpBucketsProvisioner` (`buckets.{create,delete,get,list,update,getIamPolicy,setIamPolicy}`), sem `versions.access/add/destroy` nem `storage.objects.*`. Conferido no módulo `node`: ele só cria cofres vazios com os papéis da VM e o bucket de backups com `force_destroy = false`; o estado dos tenants segue no `objectAdmin` explícito do bucket do estado. Desvio da seção 2.2 do plano, com motivo no `cross_project.tf`.
  - **I4 (pool dos painéis):** `panel_projects = toset(var.firebase_panel_projects)` e `FIREBASE_PANEL_PROJECTS` sem este projeto; a validação recusa `project_id` na lista. O pool dos painéis dos clientes é um projeto à parte, criado na primeira venda, no plano Spark (site estático com domínio próprio não precisa de faturamento; só este projeto precisa do Blaze, pelo rewrite). Primeira subida: `Plan: 74 to add` (era 66).
  - **I5 (federação):** condição do provedor com `assertion.ref == "refs/heads/main"`, `assertion.ref_type == "branch"` e `event_name` em {`push`, `workflow_dispatch`} (um `pull_request_target` roda com o `ref` da base e ficaria dentro sem isso); `ref`, `ref_type` e `event_name` mapeados como atributos. A proteção do environment no GitHub vira a segunda tranca.
  - **I6 (variáveis):** `merge(padrões, service_env, [worker_env,] infra)`, com o que o Terraform deriva por último; validação recusa em `service_env` e `worker_env` as chaves reservadas (`ROLE`, `NODE_ENV`, `PORT`, os cinco segredos, `FIRESTORE_DATABASE`, `TASKS_*`, `WORKER_URL`, `WORKER_SA_EMAIL`, `SCHEDULER_SA_EMAIL`, `OWNER_*`, `NODES_*`, `TFSTATE_BUCKET`, `IMAGES_PROJECT_ID`, `RELEASE_BUCKET`, `FIREBASE_PANEL_PROJECTS`, `CLOUDFLARE_ACCOUNT_ID`/`ZONE_ID`, `TERRAFORM_JOB_NAME`). `SMTP_HOST`/`SMTP_PORT` viram padrão só do worker e a variável nova `worker_env` leva o que é só dele (`SMTP_USER`, `MAIL_FROM*`, `NODE_RELEASE`, `PROVISIONING_ENABLED`); `service_env` recusa `SMTP_*` e `MAIL_FROM*`. `TRUST_PROXY_HOPS` saiu dos padrões: é do app (CP-01) ou de `service_env`. _Atenção para o CP-01: o schema atual do app exige `TRUST_PROXY_HOPS ≥ 1` em produção; ou o app assume o padrão 1, ou o responsável põe `TRUST_PROXY_HOPS = "1"` em `service_env` (o `tfvars.example` mostra)._
  - **I7 e C1 (`iac.yml`):** o `grep` antigo casava com o comentário de `secrets.tf` (a checagem falhava sempre, conferido na árvore anterior); agora ancora na declaração `resource "google_secret_manager_(regional_)?secret_version"` e o comentário foi reescrito.
  - **I8 (regras do Firestore):** `google_firebaserules_ruleset` + `google_firebaserules_release` `cloud.firestore` com `allow read, write: if false;` (API `firebaserules` ligada, 16 APIs).
  - **I9 (auditoria):** `google_project_iam_audit_config` do `secretmanager.googleapis.com` com `ADMIN_READ`, `DATA_READ` e `DATA_WRITE`; o alerta em `SetIamPolicy` do CP-12 fica anotado no TODO do `cross_project.tf` como do projeto dos nós.
  - **I10 (fronteira de confiança):** comentário do `run.developer` corrigido (muda qualquer atributo do serviço, apaga, executa o Job). Fronteira aceita: quem controla a `main` com o environment `control-plane` controla a imagem do `cp-worker` e, por ele, o Job como `cp-terraform` no projeto dos nós; a `main` é protegida por ruleset sem exceção e o provedor só aceita a `main`. Seção "Quem pode o quê" no GUIA.
  - **C2:** `display_name` do pool `GitHub Actions (control-plane)` (30 caracteres; limite 32), com teste. **C3:** `keep_count = 3` no registro, como a estimativa (as publicadas nos últimos 30 dias também ficam). **C4:** `attempt_deadline = "900s"` nos dois jobs do Scheduler. **C5:** acesso uniforme no bucket do estado anotado no TODO do `nodes-platform` (a condição de `worker_runs` exige).
  - **Revisão da base:** `startup_probe` HTTP em `/health` (5 s, 12 tentativas de 3 s) nos dois serviços; `traffic` no `ignore_changes` (a revisão candidata `candidato` do workflow, sem tráfego, não vira diferença); escala, prazos, variáveis e segredos continuam do Terraform; as nove saídas de `github_environment` inalteradas, com teste dos nomes. O `dependabot.yml` já acompanhava `/infra/gcp/envs/control-plane` desde o commit original (a revisão da base se enganou nisso; nada a mudar).
  - **Rejeitado:** nada. Ampliado: o agente do Scheduler em I1 (mesmo mecanismo do Tasks).
  - **Contas e papéis depois das correções:** `cp-public`: `datastore.user`; `cloudtasks.enqueuer` nas duas filas; `serviceAccountUser` em `cp-invoker`; lê `cp-stripe-secret-key`, `cp-stripe-webhook-secret`, `cp-cookie-key`. `cp-worker`: `datastore.user`; `cloudtasks.enqueuer`; `serviceAccountUser` em `cp-invoker`; `cpJobRunner` no Job; `firebasehosting.admin` só em `firebase_panel_projects`; no projeto dos nós `cpNodeLifecycle` (condição `vx-*`) e `objectViewer` em `runs/`; `objectViewer` no bucket de releases; lê `cp-stripe-secret-key`, `cp-cloudflare-api-token`, `cp-smtp-password`. `cp-invoker`: `run.invoker` no `cp-worker`, e nada mais; agentes do Tasks e do Scheduler com `serviceAccountUser` nela. `cp-terraform`: no projeto dos nós `compute.{instanceAdmin.v1,networkAdmin,securityAdmin,storageAdmin}`, `iam.{serviceAccountAdmin,serviceAccountUser}`, `resourcemanager.projectIamAdmin`, `pubsub.admin`, `monitoring.{alertPolicyEditor,notificationChannelEditor}`, `cpSecretsProvisioner`, `cpBucketsProvisioner`; `objectAdmin` no bucket do estado; `cpImagesAccessGranter` no registro do nó; nenhum segredo. `cp-deployer`: `run.developer` nos dois serviços e no Job; `serviceAccountUser` em `cp-public`, `cp-worker`, `cp-terraform`; `artifactregistry.writer`; só pelo subject do environment `control-plane` na `main`.
  - **Testes:** `terraform fmt`, `init -backend=false -lockfile=readonly`, `validate`; `terraform test` com 25 casos (8 novos: `cp_invoker`, `pool_dos_paineis`, `este_projeto_nao_entra_no_pool`, `auditoria_do_secret_manager`, `variaveis_do_responsavel` e os três de chaves recusadas; os demais ajustados: condição da federação, 32 caracteres do pool, papéis personalizados no projeto dos nós, sonda, `attempt_deadline`, `keep_count`, SMTP só no worker, sem `TRUST_PROXY_HOPS`); tflint 0.65.0 em `infra/gcp` sem avisos; checkov 3.4.0 com 31 aprovados e as mesmas 2 exceções (nenhuma nova); prettier em `docs`, `infra` e `.github`; actionlint no `iac.yml`. Nada falou com a GCP.
  - **Pendências novas para o responsável:** criar o projeto do pool dos painéis na primeira venda (Spark) e preenchê-lo em `firebase_panel_projects`; mover `SMTP_USER`, `MAIL_FROM`, `MAIL_FROM_NODES`, `NODE_RELEASE` e `PROVISIONING_ENABLED` para `worker_env`; decidir `TRUST_PROXY_HOPS` com o CP-01; se o projeto já tiver logs de auditoria do Secret Manager à mão, importar `google_project_iam_audit_config.secretmanager` antes do `apply`.
  - **Risco novo:** a sonda de partida em `/health` vale desde a primeira subida dos serviços, com a imagem de exemplo do Google; ela responde em qualquer caminho (o servidor dela atende `/`), mas se recusar `/health` a segunda subida para na revisão, e a saída é publicar a imagem do CP-01 antes (ou tirar a sonda só nessa subida).
- **Revisão do PR (Codex, P2 em `images.tf`), aplicada aqui:** tags imutáveis desligadas no registro `verax-control-plane`. Conferido na documentação das políticas de limpeza do Artifact Registry: com tags imutáveis, artefato com tag não é apagado; como o workflow publica cada versão com a tag do commit, a política `apagar-antigas` nunca apagaria nada e o registro guardaria todas as versões, contra a estimativa de custo (3 versões por imagem). A imutabilidade acrescentava pouco: os serviços rodam pelo digest, e quem move uma tag (`artifactregistry.writer`) já implanta qualquer imagem (`run.developer`). Alternativa descartada: manter as tags imutáveis e publicar só por digest, com `tag_state = "UNTAGGED"` na limpeza (mais peças no workflow do CP-01 pelo mesmo resultado). Teste novo em `servicos.tftest.hcl`: tags imutáveis e uma política DELETE que alcance versões com tag nunca juntas (mutação conferida: com `immutable_tags = true` o caso falha). O registro do nó (`envs/verax/images.tf`, 10 versões, já aplicado) tem a mesma combinação e fica para um PR próprio (uma linha; a documentação permite mudar o ajuste num registro existente).

## Fase 2, PR-V1: cofre de credenciais do nó ⚠️ altera `infra/` e `.github/`

- **Pedido:** o cofre onde a chave de acesso do usuário IAM da AWS e o token do Cloudflare ficam cifrados no nó de cliente (plano revisado da fase 2, PR-V1, com as decisões D-2, cifra assimétrica, e D-3, chave nascida na VM). Ainda sem rota: o `PUT`/`DELETE` da credencial vem no PR-V3, e a entrega ao Wazuh, no PR-V4.
- **Banco** (migration `20261105100000_cloud_credentials`):
  - `enum CloudCredentialKind { aws_access_key cloudflare_api_token }` e `model CloudCredential`, uma linha por conta: `cloudAccountId` (chave primária), `tenantId`, `kind`, `ciphertext VarChar(1024)`, `keyVersion`, `keyIdSuffix VarChar(4)`, `issuedAt?`, `expiresAt?`, `verifiedAt`, `rotationNoticeAt?`, `createdAt` e `updatedAt`;
  - a chave estrangeira para a conta é composta (`cloudAccountId` + `tenantId` → `CloudAccount(id, tenantId)`, com cascade): o banco recusa a credencial de um cliente na conta de outro, mesmo por um erro da aplicação. Para isso, a `CloudAccount` ganhou o índice único `(id, tenantId)`; o `tenantId` também tem FK Restrict para o `Tenant`;
  - CHECK: versão a partir de 1, sufixo de 4 letras ou números, envelope `v<versão>:<base64>` com a versão igual à da coluna;
  - entra em `TENANT_SCOPED_MODELS`; o `accountSelect` de contas cloud não a seleciona, e o teste confere que nada dela sai pela API.
- **Cofre** (`apps/api/src/credentials/`):
  - `credential-vault.ts`: `seal` (RSA-OAEP-SHA256 com a chave pública) e `open` (só com as privadas, no worker), com o rótulo do OAEP `verax-cred:v1:<cliente>:<conta>:<tipo>:<ID no provedor>`, conferido parte a parte; envelope `v<versão>:<base64>`; texto claro mínimo (`{i,s}` na AWS, `{t}` no Cloudflare) conferido com zod ao abrir; `reseal` para a recifragem; erros só com código (`decrypt_failed`, `key_version_missing`...);
  - invólucros `StaticAwsCredentials` e `CloudflareToken` (no molde de `read-only-session.ts`): `toJSON`, `toString` e `inspect` redigidos, segredo só por `identity()`/`value()`, e o segredo entra na máscara do logger ao ser montado;
  - `credential-keys.ts`: a chave pública da API e o chaveiro do worker, lidos do ambiente (PEM em base64), RSA de 3072 a 4096 bits. A pública recusa uma chave privada no lugar dela (o `createPublicKey` aceitaria e derivaria a pública);
  - `credential-rekey.ts`: tarefa `credential-rekey` do worker, diária (e na partida): recifra com a versão corrente as linhas de versões antigas, uma transação por linha, com lock por conta (`lockCredential`, que o PUT do PR-V3 vai usar), pelo escopo do cliente e com auditoria `cloud_credential.rekey` (só tipo e versões) na trilha dele. Linha que não abre fica como está e entra no relatório por código.
- **Ambiente** (`env.schema.ts`): a API aceita só `CREDENTIALS_PUBLIC_KEY` e `CREDENTIALS_KEY_VERSION` (em par) e **recusa** qualquer outra `CREDENTIALS_*` (as do worker) e qualquer nome com `PRIVATE_KEY`, antes de qualquer outra checagem; o worker aceita `CREDENTIALS_PRIVATE_KEYS_FILE` (o caminho do arquivo das privadas, uma linha `<versão>:<PEM em base64>` por versão ativa) e `CREDENTIALS_KEY_CURRENT` (em par, a corrente entre elas), e **recusa** `CREDENTIALS_PRIVATE_KEYS` no ambiente (as chaves só chegam por arquivo). Sem as variáveis, os dois sobem sem o cofre. A configuração guarda a chave lida, nunca o texto em base64 nem o caminho; as mensagens citam só o nome da variável.
- **Logger** (`sanitize.ts`): máscara de segredos vivos (`registerLiveSecret`, um `Set` dos valores decifrados no processo, de 16 caracteres ou mais), padrão `aws_secret_access_key = …` (e `aws_session_token`) e `ciphertext` nas chaves exatas.
- **Pacote do nó (`infra/node/`, revisar linha a linha):**
  - `node.conf.example`: `CREDENTIALS_VAULT=false`. O cofre só liga com `true`, no nó que tem o segredo `credentials-key` (`credentials_vault` no Terraform). **Sem a linha, vale `false`: o nó da Verax não consulta o Secret Manager e os arquivos de ambiente saem byte a byte iguais aos de antes** (conferido rodando o `start.sh` da `main` e o novo sobre os mesmos segredos);
  - `install.sh`: confere o valor e, com `true`, lê a versão 1 do segredo. Sem ela (NOT_FOUND), gera o par com `openssl genpkey` (RSA-3072) e o envia por pipe a `gcloud secrets versions add --data-file=-`: a chave não passa pelo disco nem por variável. Com ela (ativa, desativada ou destruída), não mexe. Qualquer outro erro (segredo inexistente, permissão) para a instalação;
  - `start.sh`: com `true`, lê as versões da 1 até a primeira que não existe (NOT_FOUND), pulando as desativadas e destruídas (FAILED_PRECONDITION), com `--format='get(payload.data)'` (o PEM fica em base64 e não passa pelo shell), e confere cada versão ativa como o worker vai conferir (PEM de chave privada RSA, não RSA-PSS, de 3072 a 4096 bits, começando na linha BEGIN; o `openssl` 1.1 e o 3 são aceitos), em pipes, repondo o `=` do fim do base64 se o `gcloud` o cortar. Escreve as privadas no arquivo `/run/verax/vault/worker-keys` (tmpfs, 0400, do usuário do worker, uid 1000, numa pasta 0750 de root e do grupo do worker; o arquivo nasce ao lado e entra no lugar por `rename`), uma linha `<versão>:<PEM em base64>` por versão, e no `worker.env` só `CREDENTIALS_PRIVATE_KEYS_FILE` (o caminho em que o worker o lê, `/run/vault/worker-keys`) e `CREDENTIALS_KEY_CURRENT` (a mais alta ativa); no `api.env`, só `CREDENTIALS_PUBLIC_KEY` (derivada da corrente pelo `openssl pkey -pubout`, num pipe) e `CREDENTIALS_KEY_VERSION`. Sem versão ativa, avisa (com a saída certa para cada caso: `enable N` quando há versão desativada, chave nova quando só há destruídas, deploy quando não há versão nenhuma) e sobe sem o cofre, com o arquivo vazio; erro de leitura ou versão ativa que não é chave para a partida, dizendo qual versão desativar, e apaga a pasta das chaves. O `down` também a apaga;
  - `compose.yaml`: `ulimits: core: 0` na API e no worker; `compose.vault.yaml` (novo): com `CREDENTIALS_VAULT=true`, o `start.sh` o soma ao `compose.yaml` (`-f` dos dois), e ele monta a pasta `/run/verax/vault` só leitura no worker (a pasta, e não o arquivo: a origem de um bind mount que falta vira uma pasta criada pelo Docker). Sem o cofre, os serviços são só os do `compose.yaml`;
  - `tests/vault-test.sh` (novo): `install.sh` e `start.sh` numa raiz temporária, sem root, com `gcloud`, `docker`, `systemctl`, `iptables`, `chown` e `id` simulados (o `gcloud` faz o papel do Secret Manager, com o estado de cada versão).
- **CI (`.github/workflows/iac.yml`, revisar linha a linha):** job "Pacote do nó": shellcheck também em `infra/node/tests/*.sh`, passo novo que roda o `vault-test.sh`, checagem de `ulimits.core` 0 na API e no worker no passo do endurecimento, `config` também com o `compose.vault.yaml`, um passo que confere nele o volume das chaves (a pasta `/run/verax/vault`, só no worker, só leitura, no caminho que o `start.sh` escreve, `WORKER_VAULT_MOUNT`, com o arquivo em `WORKER_KEYS_MOUNT`, e nenhuma variável com `PRIVATE_KEY` no nome escrita pelo `start.sh` além do caminho do arquivo) e um passo que sobe o serviço `worker` de verdade com os dois arquivos do Compose (a base da imagem da API no lugar dela e um `sh` no lugar do comando) com a pasta ausente: o Docker a cria, o contêiner sobe, e o arquivo escrito nela depois, como o `start.sh` faz, é lido pelo uid do worker, não é gravável e não é lido por outro usuário. Em `scripts/test-api-image.sh` (job da imagem no `ci.yml`), o uid e o gid do usuário da imagem têm de ser o `WORKER_UID` do `start.sh`.
- **Documentação:** `docs/ARQUITETURA.md` (situação do cofre, o `CREDENTIALS_VAULT`, a entrega por arquivo e o risco do ambiente do contêiner na tabela), `docs/runbooks/no-verax.md` (o cofre fica desligado no nó da Verax, como ligar, e como trocar, reativar ou gravar de novo a chave) e `infra/gcp/GUIA.md` (`CREDENTIALS_VAULT=true` na homologação).
- **Dependências:** nenhuma (só `node:crypto`, zod e o que já existia).
- **Testes:**
  - unitários do cofre (`credential-vault.test.ts`, 16): a API não decifra (a pública não abre e não entra no lugar das privadas); linha copiada para outro cliente, outra conta, outro tipo ou outro ID no provedor não abre; texto adulterado, cortado ou fora do envelope não abre; versão ausente falha fechado (e o envelope que mente a versão também); troca da v1 para a v2; 318 bytes cabem no RSA-3072 com OAEP-SHA256 e 319 não; zod ao abrir; segredo fora do formato; tipo e provedor; invólucros redigidos e máscara do segredo vivo; erros só com o código; leitura das chaves (2048 bits, EC, privada no lugar da pública, versão repetida ou fora da lista);
  - configuração (`load-config.test.ts`, 6 novos: o worker lê as chaves do arquivo e recusa as chaves pelo ambiente, o par incompleto, o arquivo ilegível ou vazio, a corrente fora da lista e a pública no lugar da privada, sem valor nem caminho na mensagem) e logger (`sanitize.test.ts`, 4 novos);
  - integração com o banco real (`test/cloud-credentials.test.ts`, 7): A/B pelo escopo (o cliente A não lê, não altera, não apaga e não grava na conta do B, nem pelo `upsert`); FK composta, CHECKs e cascade; nada sai por `GET /v1/cloud-accounts`; recifragem da v1 para a v2 em dois clientes, com auditoria na trilha de cada um; linha copiada para a conta de outro cliente não abre e não é recifrada; versão ausente e texto adulterado ficam como estão; `log-capture` da recifragem pelo agendador sem segredo nem texto cifrado;
  - `vault-test.sh`, cenários: o nó da Verax sem o cofre (nenhuma leitura, os mesmos arquivos de ambiente, sem a pasta das chaves nem o `compose.vault.yaml`, e nenhuma menção ao cofre na saída do `install.sh` nem do `start.sh`); a primeira instalação de um nó de cliente (a chave em base64 existe na raiz só em `/run/verax/vault/worker-keys`, 0400 e do uid 1000, numa pasta 0750 de root e do grupo 1000, sem sobra; o `worker.env` aponta o arquivo dentro da pasta que o `compose.vault.yaml` monta; o `compose.vault.yaml` entra na partida e na parada; a parada apaga a pasta e deixa os arquivos de ambiente); a pasta já criada pelo Docker (0755) com o arquivo anterior e um temporário dentro; o base64 do `gcloud` sem o `=` do fim; a rotação; 101 versões (100 destruídas); nenhuma versão ativa: desativada (o aviso manda `enable 1` e não manda gravar chave), destruída (manda gravar chave nova e não fala em `enable`), a 1 destruída com a 2 desativada (`enable 2`) e o segredo sem versão nenhuma (deploy); segredo inexistente; rede fora do ar (a partida para e apaga a pasta da partida anterior); conteúdo que não é chave na versão corrente e, numa versão antiga, lixo, RSA-2048, RSA-PSS, EC, chave pública e texto antes do BEGIN (a partida para antes de subir, diz qual versão desativar e apaga a pasta; a de 4096 bits passa);
  - mutações conferidas: tirar o cliente do rótulo e tirar o registro do segredo vivo derrubam testes; no `vault-test.sh`, ler o cofre sem o `true`, mandar as privadas para a API, gravar a chave no disco, tratar a versão desativada como erro, gerar chave com a versão 1 destruída, parar sem versão ativa e escolher a primeira versão como corrente, cada uma derruba um cenário; depois da revisão, o `start.sh` de antes dela derruba os cenários da primeira instalação, da versão antiga inválida, das 101 versões e do aviso sem versão ativa, e as chaves de volta no `worker.env`, a conferência só da corrente e uma menção ao cofre com ele desligado derrubam cada uma o seu cenário;
  - suíte da API inteira: 68 arquivos, 904 testes; `pnpm typecheck`, ESLint da raiz, Prettier e shellcheck (`koalaman/shellcheck:latest`) sem erros; `vault-test.sh` num contêiner Debian como usuário comum.
- **Decisões onde o plano deixava espaço:**
  - **interruptor `CREDENTIALS_VAULT` no `node.conf`**, em vez de detectar a ausência do segredo: a VM só tem permissão em cada segredo, e o Secret Manager responde PERMISSION_DENIED tanto para um segredo que não existe quanto para falta de permissão. Sem o interruptor (o nó da Verax), nada é lido; com ele e sem o segredo, a instalação e a partida param com a mensagem do gcloud;
  - **versões lidas uma a uma**, sem `secretmanager.versions.list`: o `secretAccessor` basta, e o módulo do Terraform não muda (o risco anotado no PR-04' não se confirmou);
  - **FK composta** com a conta (o plano pedia FK com cascade): a mesma garantia do rótulo, agora também no banco;
  - formato do worker: um arquivo com uma linha `<versão>:<PEM em base64>` por versão; token do Cloudflare aceito no alfabeto do Bearer (RFC 6750), de 20 a 255 caracteres; o `install.sh` decide pela versão 1 (gera só se o cofre nunca teve chave);
  - cofre com todas as versões desativadas: o nó sobe sem o cofre, com aviso (como o túnel sem token), em vez de parar o SOC do cliente; uma versão ativa que não é chave (em qualquer posição) para a partida, porque só o worker a recusaria, em laço, com a partida já dada como boa;
  - sem limite de versões: o Secret Manager nunca reaproveita número, então um limite contaria as destruídas e nenhuma destruição o resolveria; cada versão que existe custa uma leitura na partida, e o roteiro manda desativar (não destruir) a antiga depois da recifragem.
- **Revisão independente (rodada 1), cinco achados, todos aplicados:**
  - **alto, `start.sh`:** as privadas iam no `worker.env`, que o Compose passa como ambiente do contêiner; o Docker grava o ambiente em `/var/lib/docker/containers/<id>/config.v2.json`, no disco do nó e nos snapshots diários, e o `docker inspect` o mostra, o que contradizia o `ARQUITETURA.md`. Reproduzido num projeto descartável do Compose (o valor do `env_file` aparece no `config.v2.json`; o conteúdo de um arquivo montado, não, só o caminho). Agora as privadas vão por `/run/verax/worker-keys`, montado só leitura no worker pelo `compose.vault.yaml`; o worker recusa `CREDENTIALS_PRIVATE_KEYS` no ambiente; o `vault-test.sh` confere que a chave em base64 existe só nesse arquivo; o CI confere o volume. O `ARQUITETURA.md` volta a ser verdadeiro, com a ressalva na tabela de riscos: os outros segredos do nó (senhas do banco, chaves da sessão e do CSRF, token do túnel, senha do e-mail) seguem por `env_file` e ficam na configuração dos contêineres, como já ficavam antes do cofre; nenhum abre credencial de cliente;
  - **baixo, `start.sh`:** só a versão corrente passava pelo `openssl`; uma versão antiga inválida derrubaria o worker em laço com a partida dada como boa. Agora toda versão ativa passa pela mesma régua do worker (BEGIN na primeira linha, RSA, 3072 a 4096 bits), e a partida para dizendo qual versão desativar;
  - **baixo, `start.sh`:** o limite de 100 versões contava as destruídas (e falhava com exatamente 100), e a saída da mensagem ("destrua as antigas") não reduziria a contagem. O limite saiu (ver as decisões);
  - **baixo, `vault-test.sh`:** `grep 'a|b'` sem `-E` (o `|` é literal no BRE) nunca falhava, e a saída do `install.sh` era sobrescrita antes da conferência. Agora `grep -qE`, conferido logo depois de cada script;
  - **baixo, `start.sh`:** o aviso sem versão ativa mandava rodar o `install.sh`, que não gera chave quando a versão 1 existe em qualquer estado. Agora o aviso distingue o segredo sem versão nenhuma (o deploy gera) de versões desativadas ou destruídas (reativar a mais recente, ou gravar uma chave nova e colar as credenciais de novo), e o roteiro ganhou os três procedimentos.
- **CI do PR (Semgrep, bloqueante), três achados, todos corrigidos sem `nosemgrep` nem mudança nas regras:** `node_secret` em `sanitize.ts` (a variável do laço chamava-se `secret`; agora `liveValue`) e em `credential-vault.ts` (o parâmetro de `seal` chamava-se `secret`; agora `credential`), e `regex_dos` no construtor de `StaticAwsCredentials`. A regra do `regex_dos` é estrutural: trata o primeiro parâmetro de qualquer função com dois ou mais parâmetros como o `req` e acusa qualquer `.test()` nele; as expressões já eram ancoradas, de tamanho limitado e sem quantificador aninhado (lineares). A correção tira a régua duplicada: os invólucros conferem o formato pelos mesmos schemas zod (`awsPayload`, `cloudflarePayload`) que `open` aplica ao texto decifrado, com `safeParse`, e um teste novo cobre os limites (39, 40 e 41 caracteres no segredo da AWS, `AKIA` com 15, 16 e 17, minúsculas; token com 19, 20, 255 e 256 caracteres e com até dois `=` no fim). O outro job que falhou, "Wazuh", caiu porque o disco do executor encheu (`disk usage exceeded flood-stage watermark` no indexer), sem relação com o PR.
- **Revisão independente (rodada 2), seis achados, todos aplicados:**
  - **alto, `compose.vault.yaml` e `start.sh`:** o volume era o arquivo `/run/verax/worker-keys`. A origem de um bind mount que não existe vira uma pasta (0755, de root) criada pelo Docker ao subir o contêiner, e depois de um reboot inesperado (sem a parada, que remove os contêineres) o Docker reinicia o worker (`restart: unless-stopped`) antes do `verax-node.service`, com `/run` vazio: o worker cairia em laço com EISDIR e o `rm -f` do `start.sh` numa pasta derrubaria o `render` (`set -e`), deixando o nó parado até alguém intervir. Reproduzido com um contêiner descartável (pasta ausente → criada 0755 de root; arquivo escrito depois visível no contêiner em execução; `rename` visível na hora; 0750 root:1000 + 0400 1000 legível pelo uid 1000, só leitura, e não por outro usuário). Agora o volume é a pasta `/run/verax/vault` (montada em `/run/vault`; o arquivo segue em `/run/vault/worker-keys`), o `start.sh` a cria com `install -d -m 0750 -o 0 -g 1000` (acerta modo e dono de uma pasta que o Docker tenha criado), escreve o arquivo num temporário ao lado (0400, uid 1000) e o põe no lugar com `mv -fT` (de uma vez; recusa um destino que seja pasta), sem deixar temporário. Um worker que o Docker esteja reiniciando passa a subir sozinho quando o arquivo aparece; o `up` não ganhou um `compose down` antes do `render`, porque derrubaria a API a cada reinício sem necessidade: um contêiner que sobrou é recriado pelo `compose up` quando a configuração mudou e deixado como está quando não mudou, nos dois casos com a pasta montada. O `vault-test.sh` cobre a pasta pré-criada (0755) com o arquivo anterior e um temporário dentro; o CI confere a origem e o destino do volume e sobe o `worker` de verdade com a pasta ausente;
  - **baixo, `start.sh`:** o `down` deixava as chaves no tmpfs. Agora `down` apaga `/run/verax/vault` mesmo que o `compose down` falhe (e devolve o código dele), e toda saída com erro de `credentials_vault` apaga a pasta (nem o arquivo da partida anterior fica); o `vault-test.sh` confere nos três casos (parada, rede fora do ar, versão inválida);
  - **baixo, `start.sh`:** `vault_key_bits` aceitava uma chave RSA-PSS (o `openssl pkey -text` imprime `Private-Key: (N bit` e o módulo para ela, mas o worker a recusa, `asymmetricKeyType: 'rsa-pss'`) e a âncora `^Private-Key:` só casava com o OpenSSL 3. Conferido no OpenSSL 3: a PSS leva `No PSS parameter restrictions` (ou `PSS parameter restrictions:`) no texto, e a RSA nunca leva `PSS parameter`. Agora recusa `PSS parameter` e aceita `(RSA )?Private-Key:`; `rsa-pss` entrou no laço de versões inválidas do `vault-test.sh`;
  - **baixo, `env.schema.ts`:** o worker recusava só a literal `CREDENTIALS_PRIVATE_KEYS`. Agora recusa qualquer variável com `PRIVATE_KEY` ou `PRIVATEKEY` no nome (a régua da API) que não seja exatamente `CREDENTIALS_PRIVATE_KEYS_FILE`; o teste percorre seis nomes (e confere que `PRIVATE_NETWORK` passa), e o grep do CI no `start.sh` passou a procurar qualquer `PRIVATE_?KEY...=` fora do caminho do arquivo;
  - **baixo, `vault-test.sh` e `start.sh`:** o cenário "destruída" não conferia nada além do "desativada". A mensagem `FAILED_PRECONDITION` do `gcloud` diz o estado (`is in DISABLED state` / `is in DESTROYED state`; o simulado imprime o mesmo), então o `start.sh` separa as versões desativadas das destruídas e escolhe a saída: com alguma desativada, `gcloud secrets versions enable N` com o número da mais recente; só com destruídas, chave nova (sem falar em `enable`). O teste confere os dois casos e o misto (1 destruída, 2 desativada → `enable 2`); o roteiro foi ajustado;
  - **baixo, `start.sh` e `scripts/test-api-image.sh`:** `WORKER_UID=1000` nunca era conferido contra a imagem. Agora o teste da imagem (job da imagem no `ci.yml`) lê o `WORKER_UID` do `start.sh` e exige que o uid e o gid do usuário da imagem sejam ele (o gid importa porque a pasta é do grupo do worker);
  - **nota do revisor, aplicada:** o `base64 -d` do Debian 12 (coreutils 9.1) recusa base64 sem o `=` do fim (`invalid input`, conferido num contêiner `debian:12-slim`); se o `gcloud` o cortasse, toda versão seria recusada. O `start.sh` repõe o `=` pelo resto da divisão por 4 antes de conferir o formato, e o `vault-test.sh` tem o cenário (o simulado corta o `=`; o arquivo do worker sai com o base64 completo). O `ulimits` dos serviços do nó da Verax fica como documentado (achado aceito, sem mudança).
- **Revisão do Codex (P2, `credential-rekey.ts`) e CI dos workflows, aplicados:**
  - **`credential-rekey.ts`:** a tarefa lia só as 500 primeiras linhas pendentes (ordem do ID da conta), uma vez por execução. Uma linha que nunca abre (versão da chave desativada, texto adulterado) continua na versão antiga, entra de novo na primeira página todo dia e, com 500 delas, as linhas depois nunca seriam tentadas. Agora a execução percorre todas as linhas pendentes em páginas de 500, com cursor pelo último ID lido (`cloudAccountId > último`; nem deslocamento, que a linha recifrada deslocaria, nem o `cursor` do Prisma, que para se a linha do cursor sumir entre duas páginas), seguindo depois de uma falha até a última linha; a linha que falhou fica como está e é tentada de novo na execução seguinte (um `privateDecrypt` por dia; sem coluna nova nem migration). Lock por conta, escopo do cliente e auditoria `cloud_credential.rekey` seguem iguais; o sinal do agendador é conferido a cada página e a cada linha; `stale` passa a somar todas as páginas. O tamanho da página virou opção da construção (`batch`, para o teste; o worker usa o padrão). Teste novo com o banco real (`cloud-credentials.test.ts`, 8 agora): três contas, páginas de 1 linha, a primeira na ordem do ID cifrada com a versão 2, que o chaveiro da primeira execução não tem (só 1 e 3, corrente 3): a primeira falha (`key_version_missing`) e as outras duas recifram na mesma execução, pelo agendador, com `log-capture` sem segredo nem texto cifrado; a execução seguinte, com a versão 2 de volta, recifra a que faltava e abre o segredo, com uma entrada de auditoria por linha recifrada e nenhuma pela falha. Mutação conferida: sem o cursor (a busca de antes, com `take`), o teste cai com `stale: 1`;
  - **`iac.yml`:** o job "Workflows" (actionlint 1.7.12, que roda o shellcheck nos `run:`) acusou SC2016 nos três `grep` do passo do cofre (`'^WORKER_VAULT=\$run/vault$'`: `$` literal em aspas simples). Agora os quatro `grep` são `-qxF` (linha inteira, texto literal) com o `$` escapado em aspas duplas; a conferência é a mesma. Conferido com o `rhysd/actionlint:1.7.12` (acusa o arquivo de antes, passa no novo) e com o `koalaman/shellcheck:latest` no script do passo;
  - suíte da API inteira com o banco real: 68 arquivos, 906 testes; `pnpm typecheck`, ESLint da raiz e Prettier sem erros.
- **Definição de pronto:** schema, cofre, logger, chave do nó e recifragem ✔ · A/B do model e teste negativo ✔ · lint, tipos e Prettier ✔ · nenhuma dependência ✔ · regras de segurança ✔ (nenhuma chave, conta ou e-mail real; os segredos dos testes são gerados na hora) · o `.env.example` não mudou (as variáveis do cofre são opcionais e só existem no nó).
- **O que testar manualmente (na homologação, com o PR-04' aplicado):**
  - `CREDENTIALS_VAULT=true` no `node.conf` e deploy: a saída diz "Chave nova (RSA-3072) gravada no cofre"; `gcloud secrets versions list verax-homolog-credentials-key` mostra a versão 1; um segundo deploy diz "já tem chave";
  - na VM: `sudo grep -c CREDENTIALS_ /run/verax/api.env /run/verax/worker.env` dá 2 e 2, `sudo grep -c PRIVATE /run/verax/api.env` dá 0 e `sudo grep -c BEGIN /run/verax/worker.env` dá 0; `sudo ls -la /run/verax/vault` mostra a pasta `drwxr-x--- root 1000` só com `-r-------- 1 1000 1000 worker-keys`; `sudo docker inspect verax-worker-1 --format '{{json .Config.Env}}'` mostra `CREDENTIALS_PRIVATE_KEYS_FILE=/run/vault/worker-keys` e nenhuma chave (só o caminho); `sudo docker inspect verax-worker-1 --format '{{json .Mounts}}'` mostra a pasta `/run/verax/vault` montada em `/run/vault` com `RW: false`; o log do worker mostra `vaultKeyVersion: 1` e a tarefa `credential-rekey`; `sudo systemctl stop verax-node` apaga `/run/verax/vault`, e `start` a recria; um `sudo reboot -f` (sem a parada) deixa o worker reiniciando sozinho até o `verax-node.service` escrever o arquivo, e o nó volta sem intervenção;
  - rotação: na VM, `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 | gcloud secrets versions add verax-homolog-credentials-key --data-file=-`, `sudo systemctl restart verax-node` e conferir `vaultKeyVersion: 2`; depois da recifragem, desativar a versão 1 e reiniciar; com uma versão ativa que não é chave (por exemplo, `echo lixo | gcloud secrets versions add ...`), a partida para e diz qual versão desativar;
  - no nó da Verax, nada muda (o `node.conf` fica sem a linha): depois do deploy, o `api.env` e o `worker.env` não têm `CREDENTIALS_`, `/run/verax/vault` não existe e `docker inspect verax-worker-1 --format '{{json .Mounts}}'` mostra só a CA do banco.
- **Riscos:**
  - **perder a chave** (destruir as versões do `credentials-key`) obriga os clientes a colar as credenciais de novo: fica no roteiro, e a destruição é o passo da saída de cliente (D+97);
  - o comportamento do `gcloud` (NOT_FOUND depois da última versão, FAILED_PRECONDITION na desativada, base64 do `get(payload.data)`) foi simulado no teste a partir da documentação; só a homologação confirma com o Secret Manager de verdade;
  - versão antiga desativada antes da recifragem deixa as linhas dela sem abrir (falha fechado, no relatório da tarefa): recifrar primeiro, desativar depois;
  - o `ulimits` novo recria a API e o worker no próximo deploy do nó da Verax (eles já são recriados a cada versão nova da imagem); o `compose.vault.yaml` é instalado em `/opt/verax` em todo nó, mas só entra nos comandos do Compose com `CREDENTIALS_VAULT=true`;
  - os segredos que o nó passa por `env_file` (senhas do banco, chaves da sessão e do CSRF, token do túnel, senha do e-mail) ficam na configuração dos contêineres, em `/var/lib/docker`, no disco e nos snapshots, como antes do cofre. Nenhum abre credencial de cliente; levá-los para arquivo é melhoria fora deste PR;
  - a chave do cofre é `0400` do uid 1000 numa pasta do gid 1000 (o usuário `node` da imagem da API): se a imagem mudar de usuário, o worker deixa de ler o arquivo e para na partida com `CREDENTIALS_PRIVATE_KEYS_FILE: não foi possível ler o arquivo das chaves privadas`; o teste da imagem no CI acusa a mudança antes (uid e gid contra o `WORKER_UID` do `start.sh`);
  - uma partida que falha depois de `credentials_vault` (por exemplo, erro de rede ao ler o token do túnel) deixa a pasta das chaves no tmpfs até a próxima partida ou parada (as duas a reescrevem ou apagam); o disco nunca a vê.

## Fase 3, CP-00: arquitetura do plano de controle

- **Arquivos:** `docs/ARQUITETURA.md` (seção nova "Plano de controle": peças, identidades, estados do cliente, exclusão em dois tempos; o parágrafo da fase 3 em "Ordem de execução" aponta para ela e lista os blocos de PRs), `docs/STATUS.md`.
- **Dependências:** nenhuma.
- **Testes:** `prettier --check docs`. Só documentação.
- **Definição de pronto:** seção escrita a partir do plano da fase 3 (§2, §4b e §4d), sem ID de projeto, conta ou pessoa ✔ · **aceite:** texto a aprovar pelo responsável.
- **Teste manual:** ler a seção e conferir que descreve o que o responsável decidiu (projeto da Verax, nível gratuito, boleto mensal, exclusão em D+30 e D+97).
- **Notas:** o plano completo (fluxos, limites, custos, 14 PRs) é documento interno e não entra no repositório público; a seção resume o que o código vai implementar.

## Fase 3, CP-01: esqueleto do plano de controle, configuração e health ⚠️ altera `.github/`

- **Arquivos:**
  - `apps/control-plane/` (NestJS 12 ESM, molde de `apps/api`): `package.json`, `tsconfig*.json`, `nest-cli.json`, `vitest.config.ts` (unplugin-swc), `.env.example`, `Dockerfile`;
  - `src/common/config/env.schema.ts` (zod; `ROLE=public|worker` obrigatório e os grupos do plano §2.5: site, Stripe, estado e filas, provisionamento, Cloudflare e Firebase, acesso e e-mail, todos com o formato conferido e opcionais até o PR que os usar; regras: `TRUST_PROXY_HOPS` padrão 1 e nunca 0 em produção, emulador do Firestore proibido em produção e exigindo `FIRESTORE_PROJECT_ID`, chave da Stripe coerente com `STRIPE_LIVE`, `PROVISIONING_ENABLED=true` exige o grupo inteiro, o grupo do SMTP é do worker (`SMTP_HOST` exige usuário, senha e remetente; no public, as variáveis comuns do SMTP são ignoradas com aviso), segredo de um papel só é recusado no outro (`ROLE_ONLY`; revisão abaixo), `load-config.ts` (mensagens só com o nome da variável), `config.module.ts`, `load-env-file.ts` (`.env` da pasta do app, só fora de produção);
  - `src/common/logger/sanitize.ts` (cópia da API com teste, mais chaves e segredo de webhook da Stripe, token de acesso do Google, JWT e a chave `signature`) e `logger.options.ts` (mesmas três camadas; `message`, `severity` e `time` ISO no formato do Cloud Logging; `/health` sem log por requisição);
  - `src/common/http/` (`ApiError`, o filtro global com mensagens genéricas e `requestId`, e `client-ip.ts`, a regra do IP do cliente atrás do Hosting e do Cloud Run; revisão abaixo), `src/health/` (`GET /health`, fora do prefixo `/v1`, sem dependência), `src/app.setup.ts` (helmet com a política da API, corpo JSON de 16 KB, `trust proxy`), `src/app.module.ts` (módulos por papel: ponto de extensão para as rotas públicas e internas), `src/main.ts`;
  - testes: `load-config.test.ts`, `sanitize.test.ts`, `logger.options.test.ts`, `test/health.test.ts` (público) e `test/health-worker.test.ts` (worker em modo produção), `test/support/{create-app,log-capture}.ts`;
  - `scripts/test-control-plane-image.sh` (a imagem como no Cloud Run: raiz só leitura, sem capabilities, sem root, os dois papéis, configuração inválida citando só a variável, valor de chave ausente da mensagem);
  - raiz: `.dockerignore` (lista de permissão do contexto), `eslint.config.js` (o app nas mesmas regras da API), `pnpm-lock.yaml` (só o importer novo).
- **CI e implantação (`.github/`, revisar linha a linha):**
  - `ci.yml`: job novo "Imagem do plano de controle (build, Trivy e raiz só leitura)", com o mesmo binário e checksum do Trivy dos outros jobs e o script acima. Não está na lista de checks obrigatórios do ruleset da `main`: incluir quando o responsável quiser;
  - `plano-controle.yml` (novo): só na `main` (push em `apps/control-plane/**` e nos arquivos do workspace, ou manual), environment `control-plane`, WIF com `google-github-actions/auth` (o mesmo SHA do `painel.yml`), conferência de que os dois serviços já existem (o Terraform os cria; o workflow nunca cria serviço), build e push da imagem para o Artifact Registry com atestação de origem, `gcloud run deploy --image` dos dois serviços com `--no-traffic` e etiqueta `candidato` (só a imagem, mais `ROLE` e `NODE_ENV`; conta de serviço, variáveis, segredos, IAM, escala, timeout e sonda de partida são do Terraform e o gcloud os preserva), conferência do `/health` da revisão candidata (endereço etiquetado no `cp-public`; condição `Ready` da revisão nos dois) e só então `update-traffic --to-latest`. Projeto, região, registro e nomes dos serviços vêm das variáveis do environment, com os nomes da saída `github_environment` do Terraform; sem elas o job registra um aviso e não faz nada, então o workflow é seguro antes de o environment existir;
  - `dependabot.yml`: a imagem base do `apps/control-plane/Dockerfile`.
- **Dependências:** nenhuma nova. `@nestjs/*` 12.3.2, `zod` 4.6.7, `nestjs-pino` 5.3.1, `pino` 10.4.0, `pino-http` 11.0.0, `helmet` 8.3.0, `vitest` 5.0.5, `supertest` 7.3.1, `unplugin-swc` 2.0.0, `@swc/core` 1.16.20, nas versões já aprovadas do monorepo.
- **Testes:**
  - `pnpm --filter @verax/control-plane test`: 72 testes (configuração: mínimo válido, `ROLE` ausente ou inválido, proxies em produção, emulador, Stripe, provisionamento, listas, SMTP, `PORT`, valor nunca na mensagem; logger: redaction por chave, por valor e em erros, severidade do Cloud Logging; HTTP: `/health` 200 nos dois papéis, cabeçalhos do helmet, request id, 404 e JSON malformado genéricos, health sem log);
  - `pnpm --filter @verax/control-plane typecheck`, eslint e prettier verdes;
  - imagem: `docker build` e `scripts/test-control-plane-image.sh` locais, 9 verificações aprovadas (`/health` nos dois papéis, uid 1000, raiz só leitura, sem `ROLE` o processo cita a variável e sai, chave de produção com `STRIPE_LIVE=false` recusada sem o valor na mensagem).
- **Definição de pronto:** configuração inválida cita só o nome da variável ✔ · imagem sobe com raiz só leitura ✔ · lint, tipos e testes ✔ · dependências aprovadas ✔ · regras de segurança ✔ · **aceite** (serviço no ar respondendo `/health` em `conta.veraxsistemas.com.br` via Hosting): depende da configuração abaixo.
- **O que o responsável faz antes de o workflow implantar** (plano §9, itens 8, 9 e 11): tudo o que é da GCP vem do Terraform de `infra/gcp/envs/control-plane`, seguindo a seção "O plano de controle" do `infra/gcp/GUIA.md` (APIs, Firestore com índices e TTL, as quatro contas de serviço com os papéis por recurso, federação com o GitHub, segredos vazios, filas, relógio, Hosting com o rewrite e, com `services_enabled = true` depois de gravar os segredos, os dois serviços e o Job). Nada é criado à mão com o gcloud: o `cp-deployer` tem `run.developer` só em cada serviço e no Job (nunca no projeto), `iam.serviceAccountUser` nas três contas de execução e `artifactregistry.writer` no registro, e não tem papel nenhum no Firestore (índices e TTL são do Terraform). No GitHub, o environment `control-plane` (só a `main`) recebe as variáveis de `terraform output github_environment` (passo 7 do GUIA): `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `CP_IMAGES_REPOSITORY`, `CP_PUBLIC_SERVICE`, `CP_WORKER_SERVICE` e `CP_TERRAFORM_JOB`. A primeira execução do workflow exige os serviços já criados (passo 5 do GUIA, antes do primeiro deploy); ela só troca a imagem de exemplo pela do plano de controle.
- **Teste manual:** `pnpm --filter @verax/control-plane build && ROLE=public NODE_ENV=development node apps/control-plane/dist/main.js` e `curl -i http://127.0.0.1:8080/health`; sem `ROLE`, o processo sai com código 1 citando `ROLE`.
- **Decisões e desvios:**
  - uma só imagem com `ROLE` em vez de dois alvos no Dockerfile: é o que o plano §2.1 descreve (mesma imagem, flag), e evita duas builds e duas varreduras por commit;
  - o workflow usa o `gcloud` já instalado no runner `ubuntu-24.04`, autenticado pelo arquivo de credenciais que o `auth` exporta (`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`), em vez de mais uma action de terceiro; a versão do gcloud não fica fixada. Se o responsável preferir fixar, `google-github-actions/setup-gcloud` entra por SHA;
  - a prova do `/health` no `cp-worker` (só IAM) é a sonda de partida do Cloud Run mais a condição `Ready` da revisão: um token de identidade para o endereço etiquetado exigiria `serviceAccountTokenCreator` na SA do deploy;
  - `--update-env-vars` preserva as variáveis existentes (o `--set-env-vars` as apagaria); a documentação só diz isso por contraste, então conferir no primeiro deploy que os segredos montados continuam no serviço e que o `terraform plan` seguinte dá `No changes.`;
  - `PORT` padrão 8080 (o do Cloud Run), não 3000.
- **Riscos:** a primeira execução do workflow é a que valida o `gcloud` do runner; qualquer erro ali para antes de promover tráfego (a revisão anterior continua servindo).

## Fase 3, CP-02: Firestore, modelo de dados e auditoria ⚠️ altera `.github/`

- **Arquivos:**
  - `src/firestore/document-store.ts`: a fronteira com o Firestore (ler, consultar, transação com `create`/`set`/`delete` de documentos inteiros), `parseDocument` ("zod em toda leitura", erro cita coleção, id e campos, nunca valores) e a validação de caminhos; `firestore-document-store.ts` (SDK oficial: `Timestamp` vira `Date` na leitura, `ignoreUndefinedProperties`, `ALREADY_EXISTS` vira `DocumentAlreadyExistsError`, `createFirestore` a partir da configuração) e `memory-document-store.ts` (dublê em memória para unitários: transações em fila, leitura depois de escrita recusada, consulta com igualdade, desigualdade, ordenação e limite com as regras do Firestore);
  - `src/firestore/collections.ts`: nomes das coleções do plano §3, os quatro índices compostos sobre `tenants` e os campos de TTL (`slugs`, `stripeEvents`, `statusTokens`, `provisioningRuns`, `steps`, `auditLog`, `rateLimits`); `firestore.indexes.json` (formato do Firebase CLI) e `firestore.ttl.json`, espelhos legíveis conferidos por teste (quem cria índices e TTL no projeto é o Terraform, `infra/gcp/envs/control-plane/firestore.tf`; o teste confere o `.tf` também, quando ele está na árvore);
  - `src/tenants/tenant.schema.ts` (documento `tenants/{id}` estrito com os campos do plano §3, `transitions`, `lock`, slug, CNPJ alfanumérico, planos vendidos), `tenant-transitions.ts` (tabela de transições do §4b e §4d; esqueleto que o CP-04 e o CP-11 completam) e `tenant-store.ts` (`create`, `get`, `require`, `findBySlug`, `transition` com transição e auditoria na mesma transação, `listTransitions`, `acquireLock`/`renewLock`/`releaseLock`);
  - `src/audit/audit.service.ts` (`auditLog`: ator `system`, `stripe:<eventId>`, `owner:<principal>` ou `customer:<tenantId>`, ação, `tenantId`, `details` com a mesma limpeza dos logs e teto de 16 KB, `requestId`, `at` e `expiresAt` 24 meses; só insere) e `audit.module.ts`; `src/common/clock.ts` (relógio injetável: os prazos são comparados pelo app, não por `serverTimestamp`) e `ulid.ts` (id do tenant);
  - `src/firestore/firestore.module.ts` (global: `DOCUMENT_STORE` e `CLOCK`), `tenants.module.ts`; `app.module.ts`, `main.ts` e `test/support/create-app.ts` recebem o `DocumentStore` (real no `main`, dublê nos testes); `.env.example` com o emulador;
  - `scripts/firestore-emulator.sh` (emulador oficial `gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators@sha256:c3b114528245d315af73d92d95d8e2fed9747ce29003ad46232f22b4542da036`, porta só local, `start|stop|status`; serve ao CI e à máquina de desenvolvimento);
  - testes: `test/support/document-store-contract.ts` e `tenant-store-contract.ts` (os mesmos casos rodam contra o dublê em `memory-document-store.test.ts` e contra o emulador em `test/firestore-emulator.test.ts`, que no CI falha se `FIRESTORE_EMULATOR_HOST` faltar e fora dele é pulado), `fake-clock.ts`, `audit.service.test.ts`, `collections.test.ts`, `tenant-transitions.test.ts`, `ulid.test.ts`.
- **CI e implantação (`.github/`, revisar linha a linha):** `ci.yml`, job "Testes": passo que sobe o emulador pelo script (não é um `service` como o Postgres: a imagem não tem comando padrão e o GitHub não aceita comando num service), `FIRESTORE_EMULATOR_HOST` no ambiente do job e parada do emulador no fim. O `plano-controle.yml` não mexe no Firestore: índices e TTL são do Terraform (revisão abaixo).
- **Dependências:** `@google-cloud/firestore` 9.4.0 (aprovada; publicada em 22/10/2026, fora da quarentena). Traz `protobufjs`, que tem postinstall: negado em `allowBuilds` (`pnpm-workspace.yaml`), porque o script só reescreve metadados dos bundles de navegador e o pacote publicado já vem compilado. O `pnpm-lock.yaml` ganha o pacote e as subdependências (`google-gax`, `@grpc/grpc-js`, `google-auth-library` transitiva) e renomeia as chaves de peer de `better-auth` e `vitest`, que passam a citar `@opentelemetry/api` (peer opcional agora presente na árvore); nenhuma versão muda.
- **Testes:**
  - `FIRESTORE_EMULATOR_HOST=127.0.0.1:8681 pnpm --filter @verax/control-plane test`: 148 testes, 20 deles contra o emulador oficial. Contratos: documento inteiro com `Date` de volta e `undefined` descartado; `create` em documento existente falha no commit sem gravar o resto; leitura depois de escrita recusada; transação que lança erro não grava; consulta por igualdade, desigualdade, ordenação e limite (documento sem o campo fica fora); subcoleções; três incrementos concorrentes sem perder escrita; cliente criado em `pending` com a primeira transição e a auditoria na mesma transação; `findBySlug`; transição pela tabela com transição, auditoria e carimbo do relógio; transição fora da tabela recusada sem gravar nada; **duas transições concorrentes: uma commita e a outra relê o estado novo e perde** (`InvalidTransitionError`); a mutação acompanha a transição e não pode mexer na `lock`; trava adquirida, renovada e solta, outro dono recusado enquanto vale; **trava vencida é tomada por outro dono** e o antigo não renova nem solta; a transição preserva a trava; cliente inexistente; documento fora do formato falha na leitura citando o campo e não o valor; **nada sensível chega ao `details` da auditoria** (senha, token, chave da Stripe, Bearer, cookie, assinatura);
  - `collections.test.ts`: os JSON espelham o código; os quatro índices do plano; TTL em todas as coleções com retenção e em nenhuma de vida fiscal ou do tenant; `tenant-transitions.test.ts`: tabela cobre todos os estados, `deleted` é terminal e só vem de `canceled`;
  - `pnpm --filter @verax/control-plane typecheck`, eslint e prettier verdes; `docker build` e `scripts/test-control-plane-image.sh` repetidos com a árvore final.
- **Definição de pronto:** transições concorrentes (uma perde) ✔ · lock vencida é tomada ✔ · TTL e índices configurados e conferidos por teste ✔ · nada sensível em `details` ✔ · suíte verde no emulador ✔ · lint e tipos ✔ · dependência aprovada ✔ · regras de segurança ✔ · **aceite** (suíte verde no emulador em CI): na primeira execução do CI com este commit.
- **Teste manual:** `apps/control-plane/scripts/firestore-emulator.sh start`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8681 pnpm --filter @verax/control-plane test`, `apps/control-plane/scripts/firestore-emulator.sh stop`.
- **Decisões e desvios:**
  - o dublê fica na camada de documentos (`DocumentStore`), não no `TenantStore`: a regra de negócio (tabela de transições, trava, auditoria) existe uma vez e é a mesma nos unitários e no emulador; os testes de contrato provam que o dublê se comporta como o Firestore no que o app usa;
  - documentos são gravados inteiros e validados com `z.strictObject`: um campo desconhecido faz a leitura falhar alto em vez de ser apagado em silêncio por uma versão antiga do serviço durante uma implantação;
  - os carimbos de tempo vêm de um relógio injetável, não de `serverTimestamp`: os prazos (lock, carência, D+30, D+97) são comparados pelo app com o mesmo relógio que escreveu, e os testes andam o tempo sem esperar;
  - o emulador não roda como `service` do job (o plano dizia "igual ao Postgres"): a imagem oficial não tem comando padrão e o GitHub não aceita comando num service; o script com o digest fixado é a fonte única para o CI e para a máquina local, e o `docker-compose.yml` da raiz não muda (ele exige o `.env` do Postgres);
  - TTL fica em `firestore.ttl.json` próprio: o formato `firestore.indexes.json` do Firebase CLI não tem políticas de TTL, e o `firebase-tools` não entra; os dois JSON são espelhos legíveis, e o Terraform cria índices e TTL;
  - `steps` (subcoleção de `provisioningRuns`) ganhou TTL próprio, porque o TTL do documento pai não alcança subcoleções;
  - `auditLog` é listado por `tenantId` com ordenação em memória, sem índice composto; `provisioningRuns`, `invoices` e as demais coleções entram com os PRs que as usam.
- **Riscos:** os índices compostos são criados pelo Terraform em segundo plano, e as consultas do `tick` (CP-11) só funcionam depois de prontos.

## Fase 3, revisão da base do plano de controle (CP-01 e CP-02) ⚠️ altera `.github/`

Correções das duas revisões independentes (IAM e correção) do PR, feitas antes do merge, junto com o alinhamento ao Terraform de `infra/gcp/envs/control-plane` (PR da infraestrutura, em paralelo).

- **Arquivos:**
  - `.github/workflows/plano-controle.yml`: variáveis do environment com os nomes da saída `github_environment` do Terraform (`GCP_DEPLOYER_SA`, `CP_PUBLIC_SERVICE`, `CP_WORKER_SERVICE`, `CP_IMAGES_REPOSITORY`, `GCP_REGION`, `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`); sem `CP_PUBLIC_SA`/`CP_WORKER_SA` nem `--service-account`; passo novo que confere com `gcloud run services describe` que os dois serviços existem e para com erro apontando o GUIA (o workflow nunca cria serviço, e o gcloud nem aceita `--no-traffic` ao criar); o deploy passa só `--image`, `--update-env-vars ROLE=…,NODE_ENV=production`, `--no-traffic` e `--tag candidato` (CPU, memória, instâncias, timeout, sonda de partida e rótulos são do Terraform); o passo de índices e TTL do Firestore saiu (são do Terraform; o `cp-deployer` não tem papel no Firestore); o cabeçalho diz quem é dono de quê;
  - `apps/control-plane/scripts/firestore-apply.sh` removido: dois aplicadores (Terraform e script) do mesmo índice seriam dois donos. `firestore.indexes.json` e `firestore.ttl.json` ficam como espelho legível; `collections.ts` diz que o `firestore.tf` precisa bater, e `collections.test.ts` confere o `.tf` quando ele está na árvore (pulado até o PR da infraestrutura entrar; conferido localmente com o arquivo daquele PR: TTL nas mesmas sete coleções, os mesmos quatro índices);
  - `src/common/config/env.schema.ts`: `TRUST_PROXY_HOPS` padrão 1 (o front end do Cloud Run), `TRUSTED_PROXIES` (endereços e blocos CIDR, v4 e v6), `MAIL_FROM` e `MAIL_FROM_NODES` aceitam `Nome <e-mail>`, `ROLE_ONLY` (variáveis de um papel só) e o grupo do SMTP exigido só no worker; `load-config.ts` tira as variáveis comuns do outro papel com aviso (`onWarning`), que o `main.ts` manda para o logger depois que ele sobe; `src/common/http/client-ip.ts` (novo, a regra do IP do cliente), `app.setup.ts` (`trust proxy` com essa regra), `logger.options.ts` (o `ip` derivado no log da requisição);
  - `src/firestore/collections.ts`: `transitions`/`invoices` exigem um ULID de cliente e `steps` um id de documento válido (nada de `01AAA/transitions/x`); `document-store.ts`: `equalValues` (igualdade profunda) e `NestedTransactionError`; `memory-document-store.ts`: `==` compara arrays, objetos e datas por valor, `undefined` numa condição é recusado, desigualdade sobre array ou objeto é recusada em vez de divergir, empate na ordenação sai pelo id na direção da ordenação (como o `__name__` implícito do Firestore), sem `orderBy` a desigualdade ordena pelo próprio campo, consulta que exigiria índice composto não declarado em `COMPOSITE_INDEXES` falha (`MissingCompositeIndexError`; o emulador não confere índices, só o dublê pega isso antes do deploy) e transação aninhada falha na hora (`NestedTransactionError`) em vez de travar a fila;
  - `src/common/ulid.ts`: modo monotônico no mesmo milissegundo; `tenant-store.ts` e `audit.service.ts`: ids de `transitions` e `auditLog` são ULIDs do instante da escrita, e a listagem por `at` desempata pelo id nos dois backends;
  - `src/tenants/tenant.schema.ts`: `slugDocumentSchema` (`slugs/{slug}`: `reserved` com `checkoutSessionId` e `expiresAt`, ou `taken`); `tenant-store.ts`: `create` lê `slugs/{slug}` na transação e o toma (`tx.create`, ou `tx.set` sobre a reserva do mesmo checkout ou uma reserva vencida), senão `SlugTakenError` sem gravar nada; `transition` recusa mutação em `slug`, `company`, `consent`, `createdAt` e `lock` (`IMMUTABLE_IN_TRANSITION`); `getSlug`; `tenant-transitions.ts`: TODO(CP-04) com as transições de disputa durante o provisionamento;
  - `pnpm-workspace.yaml`: o comentário de `protobufjs: false` descreve o que o postinstall faz de verdade (só avisa sobre o prefixo de versão do dependente); `scripts/test-control-plane-image.sh`: sem `TRUST_PROXY_HOPS=1` (prova o padrão); `docs/ARQUITETURA.md` (papéis do `cp-deployer`).
- **Dependências:** nenhuma nova (`node:net` `BlockList` e `node:async_hooks` `AsyncLocalStorage` são do Node).
- **Testes:**
  - `FIRESTORE_EMULATOR_HOST=127.0.0.1:8681 pnpm --filter @verax/control-plane test`: 184 testes (2 pulados: o `firestore.tf` ainda não está na árvore). Novos, nos dois backends: slug tomado na criação e o segundo cliente com o mesmo slug recusado sem gravar nada; reserva do mesmo checkout vira `taken`, reserva de outro bloqueia até vencer; **duas criações simultâneas com o mesmo slug: só uma nasce**; mutação em `slug`/`company`/`consent`/`createdAt`/`lock` recusada e cópia estrutural aceita; registros do mesmo instante na ordem de gravação; `==` por valor em datas, arrays e objetos; `undefined` recusado; empate na ordenação pelo id nas duas direções. Só no dublê: transação aninhada recusada, índice composto ausente recusado (e a lista injetável), desigualdade sobre array recusada. Configuração: o ambiente exato que o Terraform dá ao `cp-public` (sem SMTP, com segredo do webhook e chave do cookie) e ao `cp-worker` (SMTP completo, token do Cloudflare, senha do SMTP) sobe sem aviso; SMTP no public ignorado com aviso e os segredos do worker recusados; segredos do public recusados no worker; `MAIL_FROM` nos dois formatos e seis inválidos; `TRUSTED_PROXIES`; o valor nunca na mensagem. IP do cliente: a regra pura (saltos, lista v4/v6, IPv4 mapeado, lixo) e, pelo app inteiro, o formato Hosting → Cloud Run (`cliente, saída do Hosting` dá o cliente; cabeçalho forjado antes do cliente ignorado; IPv6; chamador direto do run.app identificado pelo IP que o Cloud Run acrescentou mesmo forjando a saída do Hosting). Subcoleções com id inválido; ULID monotônico;
  - `pnpm typecheck`, `eslint . --max-warnings=0`, `prettier --check`, actionlint 1.7.12 no workflow, `docker build` e `scripts/test-control-plane-image.sh` (9 verificações, agora sem `TRUST_PROXY_HOPS` no ambiente).
- **Definição de pronto:** cada achado corrigido com teste, ou recusado com motivo (abaixo) ✔ · nomes do environment iguais aos do Terraform ✔ · o workflow não cria serviço nem toca o Firestore ✔ · lint, tipos e testes ✔ · sem dependência nova ✔ · regras de segurança ✔.
- **Decisões:**
  - **IP do cliente.** O Cloud Run acrescenta ao `X-Forwarded-For` o IP de quem se conectou a ele, e esse acréscimo ninguém forja; pelo Hosting, quem se conecta é a saída do Hosting (Fastly). Contar dois saltos para "pular" o Hosting seria forjável: quem chama o `run.app` direto está um salto mais perto e escolheria o próprio IP, furando os limites por IP. A regra é: `TRUST_PROXY_HOPS=1` (só o front end do Cloud Run, pela posição) mais `TRUSTED_PROXIES` (as saídas do Hosting, por endereço, em qualquer posição). Sem a lista, uma requisição pelo Hosting tem como "cliente" a saída do Hosting e os limites por IP se juntam num balde (degradação, não forja); com a lista, o cliente é o IP que o Hosting viu, e um chamador direto continua identificado pelo IP dele. O `ip` derivado vai no log da requisição: é por ele que o responsável descobre as saídas do Hosting a listar (ou usa a lista pública da Fastly) e confirma a forma do cabeçalho no primeiro deploy. `Fastly-Client-IP` não é usado: forjável pelo `run.app`. O padrão vale sem o Terraform definir nada;
  - **SMTP e segredos por papel.** Dois níveis, pelas listas de `secrets.tf` e `run.tf`: segredo do outro papel derruba a partida (o `cp-public` nunca pode carregar a senha do SMTP nem o token do Cloudflare; o `cp-worker`, nem o segredo do webhook nem a chave do cookie), variável comum do outro papel (`SMTP_HOST`, `SMTP_USER`, `MAIL_FROM`) é ignorada com aviso, para uma variável compartilhada por engano no `service_env` não derrubar o serviço. O grupo do SMTP só é exigido no worker. `SMTP_PORT` tem padrão e não é conferida;
  - **Slug único na transação.** Leitura de `slugs/{slug}` antes das escritas e `tx.create` (ou `tx.set` sobre a reserva do mesmo checkout ou vencida); a disputa cai em `SlugTakenError` nos dois backends: no Firestore, a segunda transação relê o documento `taken` (ou falha no commit com `ALREADY_EXISTS`, que o store traduz), e no dublê, a fila faz o mesmo. Um erro só, em vez de `DocumentAlreadyExistsError` num caso e outro erro no outro;
  - **Dublê mais estrito que o emulador.** O emulador aceita `orderBy` em campo diferente da desigualdade (a sonda deste PR provou: o Firestore atual aceita), então o dublê não recusa essa forma, como a revisão sugeria; o que ele recusa é o que de fato quebraria em produção (índice composto ausente) ou o que ele não reproduz (desigualdade sobre array). A sonda também mostrou `==` com igualdade profunda em arrays e objetos, que o dublê passou a reproduzir;
  - **Transições de disputa durante o provisionamento (achado E):** não entram agora. O plano completo não está no repositório, e uma tabela permissiva demais é mais arriscada que uma estrita (o worker do CP-07 ainda não sabe tratar um cliente suspenso no meio de um passo); fica um TODO preciso para o CP-04, com teste quando entrar;
  - **`firestore-apply.sh` removido** em vez de virar ferramenta manual (achado F, sobre a assinatura do índice, fica sem objeto): um segundo aplicador do mesmo índice, à mão, criaria deriva em relação ao estado do Terraform.
  - **Contrato com o Terraform final (`infra/plano-controle`, cp-invoker).** `WORKER_SA_EMAIL` e `SCHEDULER_SA_EMAIL` apontam as duas para a conta `cp-invoker`, a única cujo token OIDC chega ao `cp-worker`. O CP-07 confere no token `aud == WORKER_URL` e `email ∈ {WORKER_SA_EMAIL, SCHEDULER_SA_EMAIL} ∪ OWNER_PRINCIPALS`; o CP-04 e o CP-07, ao enfileirar no Cloud Tasks, usam `WORKER_SA_EMAIL` como conta do token (o `cp-public` e o `cp-worker` só têm `actAs` na `cp-invoker`). O contrato está escrito junto das variáveis em `env.schema.ts`. O que o responsável define: em `service_env` (os dois serviços) as versões dos aceites, a URL do Portal e, quando souber as saídas do Hosting, `TRUSTED_PROXIES` (e `TRUST_PROXY_HOPS`, só se quiser algo diferente do padrão 1); em `worker_env` (só o worker) `SMTP_USER`, `MAIL_FROM`, `MAIL_FROM_NODES`, `NODE_RELEASE` e `PROVISIONING_ENABLED`. O Terraform recusa `SMTP_*`/`MAIL_FROM*` em `service_env`; se mesmo assim uma variável comum do worker chegasse ao `cp-public`, ele só avisa e ignora.
- **O que o responsável faz antes do primeiro deploy:** aplicar `infra/gcp/envs/control-plane` em duas subidas (GUIA, passos 1 a 5: a primeira com `services_enabled = false`, gravar os cinco segredos, a segunda com `services_enabled = true`, que cria os dois serviços com a imagem de exemplo), criar o environment `control-plane` do GitHub (só a `main`) com as nove variáveis de `terraform output github_environment` (passo 7) e preencher `worker_env` com `SMTP_USER` e `MAIL_FROM`. Depois do primeiro deploy, ler `req.ip` nos logs do `cp-public` em requisições pelo `conta.veraxsistemas.com.br` e preencher `TRUSTED_PROXIES` (via `service_env`) com as saídas do Hosting.
- **Riscos:** a forma exata do `X-Forwarded-For` que chega ao contêiner pelo Hosting só se confirma no primeiro deploy (o teste cobre a forma documentada: cliente, saída do Hosting); até `TRUSTED_PROXIES` ser preenchida, os limites por IP do CP-03 tratam todo o tráfego pelo Hosting como um IP só.

## Fase 3, base do plano de controle: revisão do PR e CI

Correções dos quatro checks do CI que falharam no PR da base (CodeQL, Semgrep, OSV-Scanner e Dependency Review), lidos nos logs, e do achado P2 do revisor automático (Codex) em `tenant-store.ts`. Dois dos checks (OSV-Scanner e Dependency Review) apontam uma dependência transitiva sem correção por patch ou minor; o responsável decidiu pela opção 1 (abaixo), aplicada em 04/11/2026.

- **Arquivos:**
  - `pnpm-workspace.yaml`: `overrides` ganha `glob@10.5.0` → `14.0.3`, com o motivo ao lado (decisão do responsável, abaixo); `pnpm-lock.yaml` acompanha, e só nisso: `glob@14.0.3` entra no lugar do `10.5.0` (único `glob` da árvore, só o `rimraf@5.0.10` o usa) e traz `minimatch@11.0.4` (o `glob@14` pede `^11.0.2`, fora do override `minimatch@<11.0.1`, que segue servindo ESLint, typescript-eslint e Nest CLI com a 11.0.1) e `path-scurry@3.0.0` (reaproveita o `lru-cache@11.5.3` e o `minipass@7.1.3` já presentes); saem dez pacotes que só o `glob@10` trazia (`jackspeak`, `@isaacs/cliui`, `@pkgjs/parseargs`, `string-width@5`, `eastasianwidth`, `emoji-regex@9`, `wrap-ansi@8`, `package-json-from-dist`, `path-scurry@1`, `lru-cache@10`). Nenhuma outra versão muda; o aviso de depreciação do `glob@10` some do `pnpm install`;
  - `src/firestore/memory-document-store.ts`: `newId` sorteia cada um dos 20 caracteres com `crypto.randomInt` (sem viés) em vez de `byte % 62`, que favorecia os oito primeiros caracteres do alfabeto (CodeQL `js/biased-cryptographic-random`, alerta 13); `fieldValue` só lê campo próprio (`Object.hasOwn`, pelo auxiliar `ownField`): `constructor`, `__proto__` e `toString` contam como ausentes, como no Firestore. Antes, `__proto__` resolvia para `Object.prototype`, igual a `{}` por valor, e uma condição sobre ele casava com qualquer documento (Semgrep `prototype-pollution-loop`);
  - `src/common/ulid.ts`: `isUlid(value)`, a verificação de formato no módulo do ULID; `src/firestore/collections.ts` a usa em `tenantSubcollection`. O Semgrep (`njsscan regex_dos`) marca qualquer função de dois ou mais parâmetros que aplica um regex ao primeiro; `^[0-9A-HJKMNP-TV-Z]{26}$` é ancorado, de tamanho fixo e sem retrocesso, então o achado era um falso positivo, e a verificação passa a morar onde pertence;
  - `src/tenants/tenant-store.ts`: `transition` entrega à `mutate` uma cópia profunda (`structuredClone`) do documento relido. Antes, uma mutação no lugar (`tenant.slug = ...; return tenant`) alterava `current`, e a comparação dos campos imutáveis conferia o valor contra ele mesmo; uma mudança aninhada em `company`, `consent` ou `lock` por trás de uma cópia rasa também passava, e mexer em `state` corrompia o `from` da transição (achado P2 do Codex).
- **Dependências:** nenhuma nova; só o override transitivo `glob@10.5.0` → `14.0.3` (publicado em 28/10/2026, fora da quarentena de 24 h; passa no `trustPolicy`), aprovado pelo responsável.
- **Testes:** `FIRESTORE_EMULATOR_HOST=127.0.0.1:8681 pnpm --filter @verax/control-plane test`: 191 testes (2 pulados: o `firestore.tf` ainda não está na árvore), repetidos depois do override com o mesmo resultado, junto com `pnpm typecheck`, `eslint . --max-warnings=0`, `prettier --check` e o OSV-Scanner 2.7.0 (mesma versão do `security.yml`, pela imagem `ghcr.io/google/osv-scanner:v2.7.0`) sobre o `pnpm-lock.yaml` novo: 941 pacotes, nenhum achado. Novos, nos dois backends: mutação no lugar do `slug`, de `company.legalName` e de `lock.owner` por trás de cópia rasa, recusadas sem gravar nada; `state` alterado na mutação não corrompe o `from` da transição nem da auditoria. Só no dublê: campo do protótipo (`constructor`, `__proto__`, `toString`, inclusive aninhado) ausente na condição e na ordenação; `newId` usa os 62 caracteres sem viés (100 mil sorteios com tolerância de 6 desvios: o `byte % 62` ficaria a mais de 8). `isUlid`. Também `pnpm typecheck`, `eslint . --max-warnings=0`, `prettier --check` e o Semgrep com a imagem fixada do `security.yml` (mesmos packs e exclusões): 0 achados.
- **Definição de pronto:** cada check do CI com a causa lida no log e corrigida no código (sem `nosemgrep`, sem mudar regra) ✔ · achado do revisor corrigido com teste de mutação no lugar e aninhada ✔ · lint, tipos e testes ✔ · sem dependência nova ✔ · regras de segurança ✔ · OSV-Scanner e Dependency Review: decisão tomada e aplicada (opção 1, abaixo), OSV-Scanner local sem achados ✔.
- **Decisão do responsável (OSV-Scanner e Dependency Review): opção 1, aplicada em 04/11/2026.** Os dois apontavam o mesmo item, `glob@10.5.0` (GHSA-3g3m-2fjr-6pw4, moderado, CVSS 6.3, publicado em 30/10/2026: o `AbortSignal` não interrompe a travessia do sistema de arquivos depois do timeout). Entra só pelo plano de controle: `@google-cloud/firestore@9.4.0` (a mais nova) → `@google-cloud/firestore-api@0.2.0` → `google-gax@5.0.8` → `rimraf@5.0.10` → `glob@10.5.0`. O `google-gax@5.0.8`, último da linha 5, depende do `rimraf` diretamente, e o `gaxios@7.1.3`, fixado pelo `gcp-metadata@8.1.4`, também; o `google-gax@6.14.0`, que o Firestore usa de fato, não traz nenhum dos dois. Nenhum código de execução do `google-gax@5.0.8` nem do `gaxios@7.1.3` carrega o `rimraf` (conferido em `build/`): o `glob` nunca é carregado pelo cliente do Firestore. Não há correção por patch ou minor: todas as versões de 9.0.0 a 14.0.1 são afetadas e a primeira corrigida é a 14.0.2 (27/10/2026). As saídas levadas ao responsável (a 1 foi a escolhida, pela menor superfície: nada de `allow-ghsas`, e o override cai sozinho quando o Firestore deixar de trazer o `google-gax@5`):
  1. **(aplicada)** override `glob@10.5.0` → `14.0.3` (28/10) em `pnpm-workspace.yaml`, onde já mora o override do `minimatch`; o seletor por versão exata casa só com o `glob@10.5.0` do `rimraf@5.0.10` e deixa qualquer outro major do `glob` em paz (hoje não há outro). Quatro majors numa dependência que nunca é carregada; o `rimraf@5` importa o `glob` no topo do módulo, mas ninguém carrega o `rimraf`. Remover quando o `@google-cloud/firestore` deixar de trazer o `google-gax@5`;
  2. `pnpm.overrides` `rimraf@5.0.10` → `6.1.4`: major; traz `glob@14.0.3`; publicado em 03/11 às 17:25 UTC, fica na quarentena de 24 h até 04/11 às 17:25 UTC;
  3. `pnpm.overrides` `@google-cloud/firestore-api@0.2.0` → `0.7.1` (23/10): fora do `^0.2.0` que o Firestore declara; tira o `google-gax@5`, o `rimraf` e o `glob` da árvore, porque passa a usar o `google-gax@6` já presente;
  4. exceção documentada e estreita: `osv-scanner.toml` com `[[IgnoredVulns]] id = "GHSA-3g3m-2fjr-6pw4"` e `allow-ghsas: GHSA-3g3m-2fjr-6pw4` no passo do `dependency-review-action`, com motivo e data de revisão. O argumento é o de cima: o código vulnerável não roda no plano de controle (o `rimraf@5` só chama o `glob` com a opção `glob` ou pelo CLI; o `google-gax` e o `gaxios@7.1.3` listam o `rimraf` sem carregá-lo, sobra que o `gaxios` removeu no 7.3.1).
- **Riscos:** o teste de viés do `newId` é estatístico (uma falha espúria a cada ~10 milhões de execuções); o `clone` do dublê ainda gravaria uma chave própria chamada `__proto__` como protótipo do objeto copiado (falha alto na leitura seguinte, não em silêncio; nos documentos do domínio o schema zod estrito recusa a chave antes disso).

## Fase 2, PR-W1: Wazuh no nó (perfil `standard`) ⚠️ altera `infra/` e `.github/`

- **Pedido:** o Wazuh (manager e indexer 4.14.9, sem dashboard) no nó de cliente, só com `NODE_PROFILE=standard`, no mesmo projeto `verax` do Compose da aplicação (plano revisado da fase 2, PR-W1, com o desenho da seção 2.1 e a decisão D-6: 30 dias, nível 5 e 1 shard). O nó da Verax (`lean`) segue com o mesmo `compose.yaml` (byte a byte o da `main`) e os mesmos contêineres; o que muda nele (revisão final, abaixo): os arquivos de ambiente ganham um `bootstrap.env` vazio, e a topologia do systemd é outra: a guarda do metadata vira o `verax-metadata-guard.service`, instalado e habilitado também no `lean`, antes do Docker e exigido por ele (`RequiredBy=docker.service`: sem a guarda, o Docker não sobe), e o `verax-node.service` passa a exigi-la (`Requires=`) e ganha `TimeoutStopSec=180`. O primeiro commit (`6ae9ef3`) ficou sem fechamento (o agente caiu no meio); este registro cobre a auditoria dele contra o plano e o que faltava.
- **Compose (`infra/node/compose.wazuh.yaml`, revisar linha a linha):** parte de `infra/wazuh/docker-compose.yml` (mesmas imagens por digest; o CI confere a paridade), e o `start.sh` junta `-f compose.yaml -f compose.wazuh.yaml` só no `standard`:
  - sem o dashboard, sem porta publicada do indexer e sem IP fixo do manager; o volume `manager-aws` virou o bind `/run/verax/wazuh-aws:/root/.aws:ro` (memória do host, só root), escrito só pelo job `manager-config`, sem rede;
  - redes: `wazuh` (interna, `172.30.54.0/24`: indexer e manager), `wazuh-read` (interna, `172.30.56.0/24`: indexer, API e worker; separada da `wazuh` na revisão de segurança, abaixo) e `wazuh-egress` (`172.30.55.0/24`: só o manager). O manager fica fora da rede `verax`, não alcança o Postgres nem a API; o indexer não tem rota para fora;
  - limites: indexer com `mem_limit` 3g, heap de 1500m (`-Xms` e `-Xmx`) travado (`bootstrap.memory_lock`, com `ulimit memlock` ilimitado, sem capability) e `cpus` 1,5; manager com 1536m e `cpus` 1,0; API com `cpu_shares` 2048; `cap_drop: [ALL]` em todos, com `cap_add` só no manager (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `KILL` e `SYS_CHROOT`) e nos jobs de certificado e segurança (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`); `pids_limit` 1024; log com o driver `local`. A soma dos limites dos contêineres que ficam no ar dá 5,97 GiB (o CI exige até 6);
  - os jobs de inicialização (`certs-init`, `security-init` e `manager-config`) ficam no perfil `setup`, como root, sem rede, com a raiz só leitura e `/tmp` em tmpfs; só o `start.sh` os roda;
  - a API e o worker entram na rede `wazuh-read` e montam o volume `certs-public` em `/etc/verax/wazuh` (só leitura), de onde leem a CA;
  - o filebeat do manager grava com o usuário `wazuh_filebeat` (só escrita em `wazuh-alerts-*`; revisão de segurança, abaixo), e a conexão do próprio manager com o indexer (`<indexer>` do `ossec.conf`) fica desligada: só o filebeat fala com o indexer.
- **Pacote do nó (`infra/node/`, revisar linha a linha):**
  - `start.sh up` (verax-node.service), nesta ordem: a guarda do metadata (`bin/metadata-guard.sh`: `-d 169.254.169.254 -j VERAX-METADATA` sem `-s`, com `RETURN` só para o IP do worker e a porta 53, numa transação só do `iptables-restore`; também roda antes do Docker, pelo `verax-metadata-guard.service`; revisões abaixo); `render` (no `standard`, `INDEXER_URL`, `INDEXER_AUTH=node`, `INDEXER_USERNAME=verax_api_read`, `INDEXER_PASSWORD` e `INDEXER_CA_FILE` no `api.env` e no `worker.env`, e as senhas do Wazuh em `wazuh-security.env` e `wazuh-manager.env`, cada contêiner só com as dele); as imagens que faltam (pelo digest); a pilha de hoje. No `lean`, o `render` escreve os mesmos arquivos de antes;
  - `start.sh wazuh-up` (verax-wazuh.service, só no `standard`, depois do verax-node): `certs-init`, `security-init`, indexer com `--wait`, `security-admin.sh`, `configure-indexer.sh`, `wazuh-apply.sh` (no W1, lista vazia), manager com `--wait` e `smoke-test.sh`; no fim, manager e indexer têm de receber `000` do servidor de metadados (no molde do `bootstrap-host.sh` do EC2), senão os dois param e o serviço falha;
  - as quatro senhas são conferidas antes de qualquer arquivo de ambiente ser escrito (formato que todos os componentes aceitam e diferentes entre si, `scripts/lib-passwords.sh`; faltando alguma, o erro aponta para o `install.sh`), a mesma checagem de "senhas distintas" que o `deploy.sh` do EC2 fazia, agora sobre as senhas reais;
  - `install.sh`: gera `wazuh-indexer-admin`, `wazuh-indexer-filebeat`, `wazuh-api` e `wazuh-indexer-read` em `/var/lib/verax/secrets` (0600, só na primeira vez) no formato do Wazuh; instala o `compose.wazuh.yaml`, a cópia de `infra/wazuh` em `/opt/verax/wazuh`, o `wazuh-apply.sh`, o `wazuh-alerts-cleanup.sh`, o `verax-wazuh.service` e o timer, só no `standard`; recusa o `standard` sem a pasta `wazuh/` no pacote;
  - `deploy.sh`: no `standard`, leva `infra/wazuh/scripts` e `infra/wazuh/config` no pacote;
  - `wazuh-apply.sh`: gera o `ossec.conf` do nó e os arquivos da AWS pelo job `manager-config` (no W1, sempre sem contas; a entrega das chaves vem no PR-V4);
  - `systemd/wazuh/verax-wazuh-alerts.timer` (05:00 UTC, sorteio de 30 min): apaga `logs/alerts/**/*.gz` do manager com mais de 7 dias;
  - `verax-wazuh.service`: `TimeoutStartSec` 2400 s: no `standard`, as esperas do `wazuh-up` somam até 25 min (indexer 10, manager 15), mais a primeira descarga das imagens; com 20 min, o systemd poderia matar a partida no meio de uma espera. O `verax-node.service` segue com 1200 s (a revisão de operação separou os dois serviços; abaixo);
  - `node.conf.example` e `docs/runbooks/no-verax.md`: o que o `standard` sobe e `SYNC_SOURCES=gcp,wazuh` nesse perfil.
- **Bundle do Wazuh (`infra/wazuh/`, revisar linha a linha):**
  - `ossec.conf`: `log_alert_level` 5, `alerts_log` no, `sca`, `syscollector` e detecção de vulnerabilidades desligados (menos ruído, nenhum feed da CTI, medidor só com os logs dos clientes); o `<remote>` fica, preso em `127.0.0.1` (ver desvios);
  - `opensearch.yml`: `bootstrap.memory_lock: true`;
  - `configure-indexer.sh`: template legado `verax-alertas` (`order` 1) em `wazuh-alerts-4.x-*` com 1 shard e 0 réplicas, por cima do template do Wazuh (3 shards); retenção padrão de 30 dias (`ism-retention.json`); SM com 7 dias (`sm-daily.json`); nenhuma cópia de snapshot para bucket no nó;
  - sem `kibanaserver`: `init-security.sh`, `internal_users.yml.tmpl`, `roles_mapping.yml` e `init-certs.sh` (sem o par do dashboard); `smoke-test.sh` ajustado (sem o dashboard; indexer sem porta no nó e só no endereço configurado no EC2);
  - `lib-passwords.sh` (formato, geração e conferência) e `security-admin.sh` (securityadmin) compartilhados entre o nó, o EC2 e o CI;
  - o EC2 legado também fica sem o dashboard (`docker-compose.yml`, `deploy.sh` e `bootstrap-host.sh`, que deixa de ler `indexer_dashboard` do segredo); `README.md` reescrito com a seção "Nó de cliente": como ler os alertas sem o dashboard, trocar senhas, restaurar e testar.
- **CI (`.github/workflows/iac.yml`, revisar linha a linha):**
  - job "Pacote do nó": Compose válida nos dois perfis (com os arquivos de ambiente do Wazuh), memória do indexer e do manager com a soma dos limites até 6 GiB, guarda do metadata sem `-s` (o salto para a cadeia não filtra a origem), endurecimento com a exceção de `read_only` só para `wazuh.indexer` e `wazuh.manager` (os jobs de inicialização seguem só leitura) e as redes do `standard`;
  - job do Wazuh: paridade das imagens entre os dois Compose (o Dependabot só atualiza `infra/wazuh`), gatilho do teste de ponta a ponta também por `infra/node`, e o `ci-test.sh` sobe o perfil do nó (timeout de 40 min), com a atualização 4.14.8 → 4.14.9 do manager sobre os mesmos volumes: o código dos módulos da imagem nova não pode ficar escondido pelo volume `manager-wodles`, e o marcador do módulo da AWS tem de continuar lá.
- **Auditoria do commit `6ae9ef3` (fechamento):** ele já cobria toda a lista do plano. O que faltava ou estava errado, achado rodando o `ci-test.sh` localmente:
  - `smoke-test.sh` ainda esperava os mapeamentos `kibana_server` e `manage_wazuh_index`, que o `roles_mapping.yml` já não tem: toda partida do nó no `standard` e o `ci-test.sh` falhariam nessa verificação (a primeira execução parou exatamente nela, com tudo o mais do smoke test ok). Corrigido;
  - `configure-indexer.sh`, na segunda partida (política de retenção já existente), chamava `change_policy` nos padrões `wazuh-alerts-*,wazuh-monitoring-*,wazuh-statistics-*` mesmo sem nenhum índice casando, e a API do ISM recusa isso com 400 ("no documents to get"): num nó novo, sem alerta de nível 5 e sem os índices de inventário que o EC2 tinha, a segunda `start.sh up` falharia (a segunda execução parou aí, na rotação das senhas). Agora o `change_policy` só roda quando `_cat/indices` lista algum índice dos padrões; sem índice, não há o que mudar;
  - no `ci-test.sh`, duas verificações novas do perfil do nó, nunca executadas, tinham a expectativa errada: a lista de capabilities do manager (o Docker a guarda com o prefixo `CAP_`, em ordem alfabética) e os sockets em escuta do manager (a API escuta também em IPv6, e o DNS interno do Docker escuta em `127.0.0.11`). As duas agora normalizam o que o Docker devolve: capabilities sem prefixo e ordenadas; fora do loopback, só a porta 55000 (IPv4 e IPv6), e o remoted em `127.0.0.1:1514`;
  - o `TimeoutStartSec` do `verax-node.service` (acima);
  - este registro.
- **Dependências:** nenhuma. Nenhuma ferramenta nova no CI.
- **Testes:**
  - shellcheck `-x -S style` (imagem `koalaman/shellcheck`, v0.11) em todos os scripts de `infra/node/bin` e `infra/wazuh/scripts`: limpo;
  - as checagens do job "Pacote do nó" do `iac.yml`, reproduzidas num contêiner Linux com o Compose v5.7: Compose válida no `lean` e no `standard`; o `lean` sem o arquivo de memória idêntico ao `lean` com ele; memória do `standard` (aplicação e Wazuh, soma de 5,97 GiB); guarda; endurecimento nos dois perfis; redes (indexer só na `wazuh`, manager em `wazuh` e `wazuh-egress`, API e worker em `verax` e `wazuh`, worker no IP fixo); paridade das imagens; e a Compose do EC2 com senhas fictícias. No `lean`, a lista de serviços e os arquivos de ambiente são os de antes;
  - `wazuh-remoted -t` da imagem 4.14.9: sem o bloco `<remote>`, "Remoted connection is not configured" e saída 1; com o bloco preso ao loopback, ok;
  - `ci-test.sh` completo, num runner Linux local sobre o Docker Desktop (projeto `verax-wazuh-ci`, apagado com os volumes no fim): as quatro primeiras execuções acharam os defeitos acima, um por vez; a quinta passou inteira, 104 verificações em 4 min 26 s: instalação nova sem contas, rotação das três senhas com duas contas AWS (as antigas recusadas), filebeat com TLS verificado, acesso como a API e o worker (nome do serviço e CA do volume público; outro nome recusado), contas AWS (um bucket por fonte, ExternalId fora do `ossec.conf` e do ambiente, profiles só do root no diretório em memória, só leitura no manager), retenção de 30 dias ligada ao índice novo, 1 shard e 0 réplicas, snapshot e restauração, certificados por volume, limites e capabilities, heap travado (`mlockall`), redes, `ossec.conf` do nó, só a API fora do loopback, limpeza dos alertas antigos e a atualização 4.14.8 → 4.14.9 (4 arquivos dos módulos mudaram; nenhum escondido pelo volume; marcador mantido). Uso sem carga: indexer com 1,9 GiB dos 3, manager com 325 MiB dos 1,5 GiB;
  - `prettier --check docs infra .github`: limpo; actionlint 1.7.12 (o do `security.yml`, checksum conferido) com shellcheck nos workflows: limpo;
  - `test-rules.sh` não rodou: as regras não mudaram (o `ci-test.sh` confere a instalação delas).
- **Desvios do plano:**
  - o bloco `<remote>` fica, com `local_ip` 127.0.0.1: sem ele, o `wazuh-remoted` 4.14.9 recusa a configuração e o `wazuh-control` não sobe nenhum daemon (conferido acima). O efeito pedido vale: o remoted escuta só no loopback do contêiner, o `authd` fica desligado, e o `ci-test.sh` confere que só a API (55000) e o loopback (1514) escutam;
  - `SYS_CHROOT` além das seis capabilities do plano: os daemons do manager fazem `chroot` em `/var/ossec`. Conferido na imagem 4.14.9: com as seis do plano e sem `SYS_CHROOT`, o analysisd para em "Unable to chroot to directory '/var/ossec'" e nenhum daemon sobe; com as sete, o manager fica saudável no `ci-test.sh`;
  - o heap do indexer vai fixo em `OPENSEARCH_JAVA_OPTS` (1500m), sem a variável `INDEXER_HEAP` do EC2: o nó tem um perfil só, e o ensaio decide se sobe para 2 GiB;
  - o padrão de `ALERT_RETENTION_DAYS` do `configure-indexer.sh` passou de 90 para 30 (D-6); o Terraform do EC2 passa o dele e não muda.
- **Definição de pronto:** itens do plano ✔ · testes (shellcheck, Compose nos dois perfis, checagens do CI, ci-test) ✔ · nenhuma dependência ✔ · regras de segurança ✔ (nenhuma senha em log ou argumento, TLS obrigatório, usuários de demonstração fora, dados fictícios) · **aceite:** depende da homologação no ar.
- **O que testar manualmente (nó da Verax, `lean`, no próximo deploy):** `systemctl status verax-metadata-guard` (ativa, `exited`, antes do Docker); `sudo iptables -S DOCKER-USER` (o salto `-d 169.254.169.254/32 -j VERAX-METADATA` antes do `RETURN` do Docker, sem regra com `-s`); `journalctl -u verax-node` sem `env file /run/verax/bootstrap.env not found`; `sudo systemctl stop verax-metadata-guard` recusado; e um `sudo reboot`: a guarda antes do Docker e o nó de volta.
- **O que testar manualmente (nó de homologação, com `NODE_PROFILE=standard` e `SYNC_SOURCES=gcp,wazuh` no `node.conf`):**
  - `deploy.sh` e `start.sh up` do zero e de novo, sem efeito duplicado (a segunda partida reaplica a segurança do indexer e não recria o que não mudou);
  - `journalctl -u verax-node` e `-u verax-wazuh` sem erro do Compose na lista das imagens; `start.sh bootstrap` e, depois, `sudo systemctl restart verax-wazuh` sem reclamar do `bootstrap.env`;
  - `sudo systemctl stop verax-wazuh` (ou uma falha dele) e `sudo systemctl restart verax-node`: o `verax-wazuh` volta (drop-in com `Wants`); `sudo systemctl restart verax-metadata-guard` recusado;
  - o smoke test passa, e o fim da partida diz que manager e indexer não alcançam o servidor de metadados (`000`);
  - `sudo reboot`: o nó volta sozinho (`systemctl status verax-node` e `docker compose ps` com as variáveis `COMPOSE_*` do README);
  - 24 h de `docker stats` dentro dos limites (portão da e2-standard-2);
  - a tarefa `wazuh` do worker concluindo no journal e `INDEXER_AUTH=node` no ambiente da API e do worker (aceite do PR-W2);
  - o `verax-wazuh-alerts.timer` em `systemctl list-timers`.
- **Riscos e pendências:**
  - 2 vCPU contra as 4 que a documentação do Docker do Wazuh pede; plano B e2-standard-4;
  - o volume dos wodles numa atualização: o `ci-test.sh` cobre 4.14.8 → 4.14.9; quando o Dependabot subir a versão, `UPGRADE_FROM` passa a ser a que estava em produção;
  - sem o dashboard, a operação lê os alertas pelo produto ou pelo `curl` na VM (README);
  - um nó instalado como `lean` e trocado para `standard` precisa do `install.sh` de novo (as senhas do Wazuh nascem lá); sem elas, o `start.sh` para antes de escrever qualquer arquivo, dizendo qual falta e apontando para o `install.sh`;
  - o Dependabot não cobre `infra/node/compose.wazuh.yaml`: a atualização do `infra/wazuh` chega com o passo de paridade vermelho até o outro arquivo acompanhar no mesmo PR;
  - a primeira partida do `standard` demora mais (descarga de cerca de 5 GB de imagens, mais os healthchecks).
- **Revisões (duas rodadas independentes, segurança e operação), aplicadas no fechamento:**
  - **S1 (médio), manager e API na mesma rede L2:** um manager comprometido (ele processa CloudTrail, GuardDuty e WAF como root) chegaria a `http://api:3000` por dentro, fora do Cloudflare, e forjaria o `X-Forwarded-For` em que a API confia (`TRUST_PROXY_HOPS=1`), vencendo o limite de login por IP e falseando o IP da auditoria. **Corrigido:** duas redes internas, `wazuh` (indexer e manager) e `wazuh-read` (`172.30.56.0/24`: indexer, API e worker); o SAN do indexer não muda (o nome `wazuh.indexer` vale nas duas). O `iac.yml` passa a exigir que a API e o `wazuh.manager` não dividam rede nenhuma (conferido que a asserção fica vermelha com a API de volta na `wazuh`), e o `ci-test.sh` confere que o manager não alcança o indexer pelo endereço da `wazuh-read` (000) e alcança pela `wazuh` (401). Desvio deliberado do desenho da seção 2.1 do plano (uma rede só): endurecimento. O worker entra na `wazuh` só quando precisar do manager (PR-V6).
  - **S2 (médio), o manager com a senha do admin do indexer:** o filebeat só precisa escrever em `wazuh-alerts-*`, e com o admin um manager comprometido apagaria o que já indexou (`DELETE /wazuh-alerts-*`). **Corrigido:** usuário `wazuh_filebeat` com papel próprio (`roles-verax.yml`), conferido contra o que o filebeat 7.10.2 da imagem faz de verdade: `GET /` (`cluster:monitor/main`), `PUT /_template/wazuh` a cada partida (`indices:admin/template/put`), `GET` e `PUT` do pipeline do módulo (`cluster:admin/ingest/pipeline/get|put`), a entrada do `_bulk` (`indices:data/write/bulk`, que o plugin confere no cluster) e, em `wazuh-alerts-*`, `create_index` (o índice do dia e, num índice que já existe, o mapeamento dinâmico), `indices:data/write/bulk*` (o `bulk[s]` por shard) e `indices:data/write/index` (cada item do `_bulk` é conferido pela ação dele). Num indexer de ensaio, com papéis descartáveis criados pela API de segurança, cada uma dessas foi tirada e o `_bulk` passou a ser recusado com o nome dela: nada sobra e nada falta. O `indices:admin/template/get` sugerido não é usado (o filebeat consulta `_cat/templates`, recebe 403 e ignora, porque grava o template de qualquer jeito). Quarta senha (`wazuh-indexer-filebeat`) gerada pelo `install.sh` e conferida pelo `start.sh`; `INDEXER_USERNAME: wazuh_filebeat` nos dois Compose; o `security-init` recebe as três senhas que transforma em hash e o manager só a do filebeat e a da API dele: a do admin não chega a nenhum contêiner que fica no ar (o `ci-test.sh` confere no ambiente do manager). Complemento: a conexão do próprio manager com o indexer (`<indexer>` do `ossec.conf`) passou a `enabled: no`; na 4.14.9 só a detecção de vulnerabilidades (desligada) a honra: o harvester de inventário sobe de qualquer jeito e tenta criar os 13 templates `wazuh-states-inventory-*` com a credencial do keystore, a do filebeat, e falha (`IndexerConnector initialization failed`, um aviso por índice a cada partida, igual com `yes` e com `no`, conferido num ensaio), sem indexar nada (inventário e FIM desligados). O `ci-test.sh` passa a exigir que essa tentativa falhe e que nenhum índice `wazuh-states-*` exista: se um dia passar, o usuário do filebeat ganhou permissão demais. Outro achado do ensaio: o filebeat só abre a conexão com o indexer quando tem o que enviar, então o template e o pipeline só existem depois do primeiro alerta de nível 5 (o teste os confere depois do alerta injetado). O smoke test confere o usuário novo (grava pelo `_bulk` num índice novo, instala template; ler, apagar índice, apagar documentos, apagar o template do Wazuh, outros índices, índice de segurança, cluster, configuração de segurança e snapshots recusados), e o `ci-test.sh` prova o caminho inteiro: um alerta posto no `alerts.json` chega ao índice do dia pelo filebeat, com o template e o pipeline instalados por ele. No EC2 legado, o segredo ganha o campo `indexer_filebeat` (módulo `wazuh` do Terraform; numa instância antiga, aumentar `password_version`), e o `bootstrap-host.sh` o lê.
  - **S3 (baixo), instante sem guarda entre o `-F` e o `DROP`:** **corrigido** com uma transação só do `iptables-restore --noflush` (esvaziar e preencher a cadeia num commit), em `bin/metadata-guard.sh`. Teste novo, `infra/node/tests/metadata-guard-test.sh` (no CI com `sudo unshare -n`, num espaço de nomes de rede próprio): antes do Docker, reaplicada, regra antiga removida, regra estranha varrida junto e nenhum `-F`/`-A` solto no script (a guarda antiga, regra a regra, falha nessa verificação; conferido).
  - **S4 (baixo), o Docker restaura os contêineres antes da guarda num reboot abrupto:** **corrigido** com o `verax-metadata-guard.service` (oneshot, `Before=docker.service`, `RequiredBy=docker.service`: sem a guarda, o Docker não sobe), que cria a `DOCKER-USER` se ainda não existe (o Docker, ao subir, só acrescenta o `RETURN` dele e o salto do FORWARD); o `verax-node.service` o exige, e o `start.sh up` só reafirma as regras.
  - **S5 (baixo), teste de atualização só nos `wodles`:** **corrigido**: o `ci-test.sh` percorre `wodles`, `integrations`, `active-response/bin` e `agentless` (mesma mecânica de `permanent` e `exclusion` da imagem, arquivos de estado `*.db` fora).
  - **O1 (médio), uma falha do Wazuh derruba o verax-node e o backup:** **corrigido** com o `verax-wazuh.service` (`Requires`/`After=verax-node.service`, `start.sh wazuh-up`, `TimeoutStartSec=2400`, `TimeoutStopSec=180`, instalado e habilitado só no `standard`); o `verax-node.service` volta a 1200 s e ganha `TimeoutStopSec=180` (o `down` para o manager e o indexer, 60 s cada); o `verax-backup.service` passa a `Wants=` (o backup roda e falha sozinho, com o motivo no journal, em vez de "dependency failed"); o timer de limpeza dos alertas fica `After=verax-wazuh.service`. `systemctl restart verax-node` reinicia os dois (o `Requires` propaga o restart); o `install.sh` habilita e sobe o `verax-wazuh` depois do `verax-node`.
  - **O2 (médio), `compose pull` a cada partida:** **corrigido**: toda imagem é fixada pelo digest, então o `start.sh` só baixa a que falta (`docker image inspect` antes do `pull`); o `up` olha só as imagens da aplicação, e o `wazuh-up`, as do Wazuh. A partida não depende do Docker Hub. A primeira versão disso não funcionava no nó (a lista das imagens não saía por falta do `bootstrap.env`, e o erro passava em silêncio): corrigido na revisão final, abaixo.
  - **O3 (baixo), `restart: unless-stopped` nos dois contêineres do Wazuh:** a troca por `on-failure` foi **recusada**: num reboot abrupto o Docker 27 restaura os contêineres que estavam rodando com código de saída 255 (`daemon/daemon.go`, `restore`: sem tarefa no containerd, `ces.ExitCode = 255`), e `on-failure` reinicia tudo que saiu com código diferente de zero, então o efeito pedido ("o start.sh os sobe na ordem") não aconteceria; e `unless-stopped` é o que mantém parado, mesmo depois de um reboot, um manager que a conferência do metadata parou. A brecha de segurança desse instante é fechada pela guarda antes do Docker (S4). O que fica: a pasta `/run/verax/wazuh-aws` criada pelo bind antes do `start.sh` nasce vazia (nada a vazar) e o `start.sh` a põe em 0700 antes de gerar os profiles; e a memória: o `iac.yml` passa a exigir também que a soma dos limites dos contêineres no ar mais o maior job de inicialização (`security-init`, 512 MiB) caiba em 6,5 GiB (6,47 hoje; a VM tem 7,76 GiB), porque esse job coincide com a pilha inteira num reinício do `verax-wazuh` ou num reboot abrupto (conferido que a asserção fica vermelha com o job a 1 GiB).
  - **O4 (baixo), sem `stop_grace_period`:** **corrigido**: 60 s no indexer e no manager (o `ci-test.sh` confere o `StopTimeout`), e os `TimeoutStopSec` acima.
  - **O5 (baixo), `cat` cego nos arquivos das senhas:** **corrigido**: `wazuh_passwords` confere os quatro arquivos no começo do `render` (antes de qualquer arquivo de ambiente) e diz qual falta, apontando para o `install.sh`.
  - **O6 (baixo), dois ids do manager numa recriação:** **corrigido**: `--filter status=running` e `head -n 1` no `wazuh-alerts-cleanup.sh`.
  - Sem mudança, como as revisões já apontavam: o comentário da unidade sobre as esperas (10 e 15 min) e a tag `4.14.9` do manager apontando para um digest mais novo (o Dependabot propõe).
  - **Testes das revisões:** shellcheck `-x -S style` limpo em `infra/node/bin`, `infra/node/tests` e `infra/wazuh/scripts`; `terraform fmt -check` no módulo `wazuh`; as checagens do job "Pacote do nó" reproduzidas num contêiner Linux com o Compose v5.7 (Compose válida nos dois perfis, `lean` idêntico com e sem o arquivo de memória, memória do `standard` com a soma dos jobs, guarda, endurecimento, redes com a asserção nova, paridade das imagens, Compose do EC2 com e sem a quarta senha); o `compose.yaml` do `lean` byte a byte igual ao da `main`; o teste da guarda num contêiner Debian 12 com `NET_ADMIN` (iptables 1.8.9 nft, o do nó): 12 verificações; `prettier --check docs infra .github` e actionlint 1.7.12 limpos; `ci-test.sh` num runner Linux sobre o Docker Desktop (projeto próprio, apagado com os volumes no fim), com a máquina abaixo dos 7 GB livres pedidos para o teste inteiro como está: rodou com um override só do heap do indexer (768 MiB, limite de 1,5 GiB), que faz falhar de propósito uma única verificação (os 3 GiB do indexer); as outras 146 passaram em 8 min 41 s, entre elas as novas: os dois smoke tests (36 verificações cada, com o `wazuh_filebeat` gravando pelo `_bulk` e recusado em tudo o mais), as quatro senhas antigas recusadas, o filebeat com o usuário novo (e a senha do admin fora do ambiente do manager), o alerta de ponta a ponta no índice do dia com o template e o pipeline instalados pelo filebeat, o harvester do manager recusado e nenhum `wazuh-states-*`, o manager sem alcançar a `wazuh-read` (000) e alcançando a `wazuh` (401), os 60 s de parada e a atualização 4.14.8 → 4.14.9 nos quatro volumes (wodles 4 arquivos e active-response/bin 13 mudaram; nada escondido). Uso sem carga nesse ensaio: indexer 1,18 GiB, manager 330 MiB. O teste completo, com os limites reais, roda no CI a cada PR que mexe em `infra/wazuh` ou `infra/node`.
- **Revisão final (commit `fc7d6fd`), seis achados:**
  - **1 (médio), o `pull_images` nunca funcionava no nó:** o `config --images` com o perfil `setup` lê o serviço `bootstrap`, cujo `env_file` `/run/verax/bootstrap.env` só existia durante o `start.sh bootstrap`; o Compose recusava o projeto (`env file /run/verax/bootstrap.env not found`), a substituição de processo (`done < <(...)`) engolia o código de saída, nada era pré-baixado e a linha de erro ia para o journal a cada `up` e `wazuh-up` (o `compose up` baixava as imagens que faltavam por conta própria, por isso o nó subia). O CI não via porque criava um `bootstrap.env` que o nó não tinha. **Corrigido:** o `render` escreve o `bootstrap.env` vazio (o `start.sh bootstrap` o preenche só durante a execução e o deixa vazio de novo, em vez de apagá-lo: o `wazuh-up` e o próximo `up` leem o projeto inteiro); o `pull_images` lê a lista numa atribuição própria (`images=$(compose ... config --images) || return 1`), e um erro do Compose para a partida com o motivo no journal. O `compose.yaml` segue byte a byte o da `main`. No CI, os arquivos de `/run/verax` passam a ser os que o `render` escreve, extraídos do próprio `start.sh` (a lista fixa, com o `bootstrap`, saiu), e o `config --images` de cada perfil tem de dar exatamente as imagens esperadas; e um teste novo, `infra/node/tests/start-test.sh`, carrega o `start.sh` de verdade (node.conf de teste; Compose, Docker e cofre simulados) e confere os arquivos do `render` nos dois perfis, o `bootstrap.env` vazio antes e depois do `bootstrap`, o `pull_images` baixando só a imagem que falta e devolvendo 1 quando o Compose falha. Contra o `start.sh` de `fc7d6fd`, 6 das 21 verificações falham; a Compose 5.7 recusa o `config --images` sem o arquivo (reproduzido num contêiner).
  - **2 (baixo-médio), `systemctl restart`/`stop verax-metadata-guard` reiniciaria/pararia o Docker:** pelo `RequiredBy=docker.service`, um stop ou restart manual da guarda se propaga ao Docker e, por ele, ao nó e ao Wazuh. **Corrigido** com `RefuseManualStop=yes` e `RefuseManualStart=yes` na unidade: ela só entra como dependência (no boot e no restart do `verax-node`), e a reaplicação das regras é o `start.sh up`. O trade-off fica: a guarda falhando, o Docker não sobe (nenhum contêiner sem a guarda); dito no runbook e na ARQUITETURA. O CI confere as duas linhas, e um passo novo roda `systemd-analyze verify` nas unidades e nos timers.
  - **3 (baixo), o restart do `verax-node` não trazia o `verax-wazuh` de volta de `failed` ou `inactive`:** o `Requires` do `verax-wazuh` só propaga o restart enquanto ele está no ar. **Corrigido** com o drop-in `infra/node/systemd/wazuh/verax-node.service.d/wazuh.conf` (`[Unit]`, `Wants=verax-wazuh.service`), que o `install.sh` instala só no `standard` em `/etc/systemd/system/verax-node.service.d/` (o `verax-node.service` do `lean` não muda): `start` e `restart` do `verax-node` sobem o `verax-wazuh`, o `After=` dele mantém a ordem e `Wants` não propaga falha. O CI confere o conteúdo do drop-in, o `Requires`/`After` do `verax-wazuh`, que o `verax-node.service` não cita o `verax-wazuh` fora de comentário, que o `install.sh` o instala dentro do bloco do `standard`, e o `systemd-analyze verify` com o drop-in no lugar (conferido que ele é lido: uma chave inválida posta nele aparece no aviso). README do Wazuh, runbook, `verax-wazuh.service` e `install.sh` ajustados.
  - **4 (baixo), o `ci-test.sh` exigia ao menos um `IndexerConnector initialization failed`:** detalhe da 4.14.9; o número agora só fica registrado na saída. Sentinelas mantidas: nenhum `IndexerConnector initialized successfully` e nenhum índice `wazuh-states-*`.
  - **5 (baixo, opcional), `indices:admin/template/put` e `cluster:admin/ingest/pipeline/put` no cluster inteiro para o `wazuh_filebeat`:** alternativa avaliada e **não aplicada**. O `filebeat.yml` do manager não é nosso: a imagem 4.14.9 o guarda na lista de exclusão (`/var/ossec/data_tmp/exclusion/etc/filebeat/filebeat.yml`, com `setup.template.json.enabled: true` e `setup.template.overwrite: true`), o `0-wazuh-init` o recopia para o volume `/etc/filebeat` a cada partida e o `1-config-filebeat` o edita com `sed -i` (hosts, usuário, senha e TLS). Um arquivo próprio montado só leitura quebra a cópia e o `sed` (o init falha e o manager não sobe); montado com escrita, é sobrescrito. Ficaria fora do contido: substituir o init da imagem e ainda instalar o `wazuh-template.json` e o pipeline do módulo pelo admin (o `pipeline/put` continuaria necessário, ou o pipeline teria de ser extraído da imagem a cada deploy). E sem o `ci-test.sh` nesta máquina (abaixo) não há como provar que os alertas seguiriam indexando. Risco residual, documentado no `roles-verax.yml`: as duas escritas valem para qualquer template legado e qualquer pipeline (o plugin de segurança não as restringe por nome); um manager comprometido reescreveria o template `verax-alertas` (shards e réplicas dos índices novos) ou o pipeline dos alertas, nunca os dados já indexados (leitura e remoção seguem negadas).
  - **6 (docs):** o "Pedido" e o "O que testar manualmente" do nó da Verax, acima; `docs/ARQUITETURA.md` (os serviços do systemd valem para os dois perfis; a guarda e o `Wants`); `infra/wazuh/README.md` (mecanismo do pull; restart do nó e guarda); `docs/runbooks/no-verax.md` (guarda sem stop/restart, o Docker não sobe sem ela, o que conferir); e o cabeçalho do `ci-test.sh` (faixas livres com a `172.30.56.0/24`).
  - **Testes da revisão final:** shellcheck `-x -S style` (v0.11) limpo em `infra/node/bin`, `infra/node/tests` e `infra/wazuh/scripts`; `start-test.sh` em Git Bash e em Linux (bash 5.3): 21 verificações; o job "Pacote do nó" reproduzido num contêiner com a Compose 5.7 (prova do defeito; Compose válida nos dois perfis com a lista do `render`; `config --images` por perfil; memória; guarda; drop-in; endurecimento; redes; paridade das imagens); `metadata-guard-test.sh` num Debian 12 com `NET_ADMIN` (iptables 1.8.9 nft, 12 verificações); `systemd-analyze verify` (systemd 252) limpo nas unidades, nos timers e no drop-in, com um `docker.service` simulado (falha com o script do `ExecStart` ausente, conferido); `prettier --check docs infra .github` e actionlint 1.7.12 limpos. O `ci-test.sh` do Wazuh **não rodou** nesta máquina: não havia os 7 GB livres (outros contêineres no ar); ele roda no CI do PR, que mexe em `infra/wazuh` e `infra/node`.
- **Mesclagem da `main` com o PR-V1 (cofre de credenciais):** o `compose()` do `start.sh` soma o `compose.wazuh.yaml` no standard (menos com `--base`) e o `compose.vault.yaml` com `CREDENTIALS_VAULT=true` em toda chamada (o `COMPOSE_FILE` do `wazuh-up` também), e a guarda segue em `bin/metadata-guard.sh` (o `vault-test.sh` ganhou o `iptables-restore` simulado e o `-D` que falha); no `iac.yml`, o `check()` ganhou o `ulimits.core` da API e do worker e roda nas quatro combinações (lean e standard, com e sem o cofre), e o `config --quiet` e a checagem da montagem do cofre valem também para standard com o cofre.

## Correção: a limpeza do registro das imagens do nó nunca apagava nada ⚠️ altera `infra/`

- **Problema:** `infra/gcp/envs/verax/images.tf` (o registro das imagens do nó da Verax, já aplicado) juntava `immutable_tags = true` com a política DELETE de 30 dias. Com tags imutáveis, o Artifact Registry não apaga nenhuma versão com tag (documentação das políticas de limpeza: _"If a repository has immutable tags enabled, tagged artifacts can't be deleted"_), e o workflow `Imagens do nó` põe a tag do commit em toda imagem: a política nunca apagava nada, e o registro guardava todas as versões, para além dos 0,5 GB do nível gratuito. É o mesmo achado da revisão do PR #51 no registro do plano de controle.
- **Decisão:** `immutable_tags = false`, com o motivo no arquivo. A tag mutável não muda o risco: o nó instala sempre pelo digest conferido contra a atestação de origem (`infra/node/bin/deploy.sh`), nunca pela tag, que só serve para achar o digest do commit. **`keep_count = 3`** (era 10), como no plano de controle: a versão no ar e duas para voltar com `deploy.sh <commit anterior>`, mais tudo o que tem menos de 30 dias (a versão que casa com as duas políticas fica; a contagem é por imagem, API e migrations). Voltar mais do que isso não é um caminho do nó: as migrations rodam a cada partida e só andam para a frente, e uma versão apagada não se republica (o environment `imagens` só aceita a `main`); o caminho é reverter o commit na `main`, que publica uma imagem nova e atestada. O roteiro (`docs/runbooks/no-verax.md`) diz isso.
- **É uma atualização no lugar, não uma recriação:** no provider google 8.9.0 (`resource_artifact_registry_repository.go`), só `location`, `repository_id`, `format`, `mode`, `kms_key_name`, `remote_repository_config` e `project` têm `ForceNew`; `docker_config` e `cleanup_policies` não, e a mudança entra no `updateMask` como `dockerConfig`. O `gcloud artifacts repositories update` tem `--immutable-tags`: o Google deixa trocar num registro existente. O próximo `plan` de `envs/verax` termina em `Plan: 0 to add, 1 to change, 0 to destroy.` (GUIA, passo 5): `~ immutable_tags = true -> false` e o bloco `manter-recentes` saindo e voltando com `keep_count = 3`, porque `cleanup_policies` é um conjunto. Nenhuma imagem sai no `apply`: a limpeza roda num job do serviço, mais ou menos uma vez por dia.
- **Teste novo** (`envs/verax/tests/imagens.tftest.hcl`, provider simulado, 2 casos): a regra (tags imutáveis nunca junto com uma política DELETE que alcança versões com tag), as tags mutáveis, a política DELETE de 30 dias sem dry run e com qualquer estado de tag, a KEEP com 3 versões de cada imagem e sem prefixo, os campos que recriariam o registro com os valores do registro no ar (lugar, nome, formato, modo, chave e remoto) e o prefixo das imagens da saída. Mutações conferidas: `immutable_tags = true`, `keep_count = 10`, DELETE só sem tag, dry run ligado e outro `repository_id`; cada uma derruba o caso certo. O simulado não aplica os padrões do provider nem pede recriação: quem confere o `update in-place` de verdade é o `plan` contra o estado real.
- **Achado do Codex no PR (P1), aplicado:** a limpeza podia apagar a versão que o nó roda. O workflow `Imagens do nó` publica a cada push na `main`, sem esperar o deploy: um nó que fica mais de 30 dias numa versão, com 3 publicações mais novas, perderia as próprias imagens, e a partida seguinte (`start.sh up` faz `compose pull`, que falha com a imagem apagada) pararia o nó. Correção: o `deploy.sh` grava a tag `no-<vm>` nas imagens que instala (a tag sai da versão anterior; se a gravação falhar, o nó já está instalado e o erro mostra o comando para gravá-la à mão) e valida o nome da VM, que entra na tag; o registro ganha a política KEEP `manter-no-ar` (`tag_state = TAGGED`, `tag_prefixes = ["no-"]`; as tags dos commits são hexadecimais e nunca começam assim). Uma versão que casa com uma KEEP e com a DELETE fica. O teste confere as duas KEEP pelo id (o provider guarda as políticas como conjunto), a `manter-no-ar` sem outro filtro, e, num caso novo (`deploy_marca_a_versao_no_ar`), que o `deploy.sh` grava a tag que a política procura. Mutações conferidas: prefixo `n`, `tag_state = ANY`, a política removida e o `deploy.sh` gravando outra tag; cada uma derruba um caso. Na versão já no ar, a tag é gravada à mão logo depois do `apply` (GUIA).
- **Documentação:** `infra/gcp/GUIA.md` (o que o próximo `plan` do nó da Verax mostra e por quê, a retenção junto do custo, e a quirk conhecida do serviço, hashicorp/terraform-provider-google#14846, se o `plan` seguinte insistir em `+ docker_config { + immutable_tags = false }`) e `docs/runbooks/no-verax.md` (voltar uma versão).
- **Dependências:** nenhuma. Provider e lock sem mudança.
- **Testes:** `terraform fmt -check -recursive infra/gcp`, `init -backend=false -lockfile=readonly` e `validate` em `envs/verax`; `terraform test` em `envs/verax`, 6 casos (3 novos); tflint 0.65.0 (`infra/gcp`, recursivo) e checkov 3.4.0 (`infra`: 761 checagens do Terraform aprovadas, 0 falhas), os do CI; `npx prettier --check docs infra` limpo. Nada foi aplicado.
- **Definição de pronto:** critérios ✔ · testes ✔ · lint ✔ · nenhuma dependência ✔ · regras de segurança ✔ (nenhum dado real; o nó continua instalando só por digest atestado).
- **O que testar manualmente (responsável, em `envs/verax`):** `terraform plan` (GUIA, passo 5) com `0 to add, 1 to change, 0 to destroy`, só o registro, em `update in-place`; `apply`; o `plan` seguinte em `No changes.`. Depois de um dia, `gcloud artifacts docker images list REGISTRO/api --include-tags` (e `/migrate`) não mostra mais versão com mais de 30 dias fora das 3 mais recentes.
- **Riscos:** uma versão fora das 3 mais recentes, com mais de 30 dias e sem a tag `no-` deixa de existir: um `deploy.sh` com esse commit para na conferência da imagem, e o caminho é reverter na `main`. O registro pode ficar acima do nível gratuito até o job de limpeza rodar.

## Primeiro administrador do cliente criado junto com o cadastro ⚠️ altera `auth/` e `common/audit`

- **Pedido:** "Criar o primeiro usuário de cada cliente a partir do administrativo da Verax" (04/11/2026). Antes, `POST /v1/tenants` criava só a empresa, e o primeiro `admin_cliente` exigia selecionar o cliente no seletor e usar Usuários. Agora o cadastro do cliente cria o primeiro administrador na mesma requisição.
- **Como funciona:** em Clientes → Novo cliente, o formulário ganhou o bloco "Primeiro administrador" (nome e e-mail). A API cria o cliente e, na mesma transação do `AuditInterceptor`, a conta como `admin_cliente` do cliente novo, ativa, com `mustChangePassword` e a senha temporária gerada e gravada pelo mesmo caminho de Usuários (`provisionUser` + `setTemporaryPassword`: hash scrypt do Better Auth, conta `credential`, validade de 72 h). A senha aparece uma vez na resposta (e no painel, no `TemporaryPasswordNotice`, com o botão de copiar); `GET /tenants/:id` e Usuários nunca a devolvem. E-mail já usado em qualquer cliente: 409 com a mesma mensagem genérica de Usuários, e o cliente não é criado (a transação é desfeita). No primeiro login, a pessoa troca a senha e cadastra o MFA, como qualquer conta.
- **Contrato (`packages/shared/src/tenants.ts`):** `tenantCreateSchema` ganhou `firstAdmin: { name (1–120), email (até 254) }`, obrigatório e estrito (papel, cliente e senha não vêm do corpo); `tenantUpdateSchema` não o aceita (os dois derivam de `tenantFieldsSchema`, os dados cadastrais). A resposta do `POST /v1/tenants` passou a ser `tenantCreatedSchema`: `{ tenant, firstAdmin: { id, name, email, temporaryPassword, expiresAt } }`.
- **API:**
  - `tenants.service.ts`: `create` cria o cliente, chama `UsersService.provision(tenantId, { ...firstAdmin, role: 'admin_cliente' })` e descreve dois registros na trilha do cliente novo: `tenant.create` e `user.create` (estado novo sem senha, com a limpeza de sempre). `TenantsModule` importa `UsersModule`, que passou a exportar o service;
  - `users.service.ts`: o miolo de `create` virou `provision(tenantId, input)` (unicidade do e-mail, conta `invited`, senha temporária, leitura por `forTenant`), usado pelos dois cadastros; `POST /users` responde como antes;
  - ⚠️ `auth/user-provisioning.ts`: `provisionUser` passou a gravar a conta na transação da requisição quando há uma (`requestContext.tx`), com o `generateId` do Better Auth; fora dela (seed, bootstrap do nó, testes), continua pelo adaptador interno da biblioteca. Sem isso, o adaptador gravaria pelo cliente base, fora da transação, e a chave estrangeira para o cliente ainda não confirmado falharia. Efeito em `POST /users`: a conta agora é desfeita junto se a requisição falhar (antes sobrava uma conta `invited`, sem senha);
  - ⚠️ `common/audit`: `AuditContext.also(details)` registra um segundo recurso na mesma requisição; o `AuditInterceptor` grava o principal e os adicionais no mesmo commit da alteração e, na falha, só a tentativa principal (`RequestStore.additionalAudit`).
- **Painel:** `tenants-page.tsx` (bloco do primeiro administrador só no cadastro; depois de criar, o aviso da senha temporária no lugar do formulário, com cópia e "Concluir"; a edição não muda), `admin-api.ts` (`useCreateTenant` com `tenantCreatedSchema` e `gcTime: 0`, como em Usuários), mock `admin.ts` (cria o administrador no cliente novo e recusa e-mail repetido), texto do tour do seletor de cliente, testes da tela e o e2e de acessibilidade do formulário e do aviso.
- **Documentação:** `docs/runbooks/onboarding-cliente.md` (seção 4, passos 4 e 5: o caminho manual, com a senha repassada por canal seguro) e `docs/ARQUITETURA.md` (fase 3).
- **Dependências:** nenhuma.
- **Testes:**
  - `packages/shared` (176): primeiro administrador obrigatório, nome e e-mail válidos, papel, cliente e senha recusados, fora da alteração; a resposta do cadastro exige a senha temporária e nada a mais;
  - API (69 arquivos, 920 testes, banco real, já com os cinco da revisão independente abaixo): `tenants.test.ts` ganhou o bloco "primeiro administrador do cliente": a conta nasce `admin_cliente` do cliente novo, ativa, com `mustChangePassword`, só o hash no banco (conta `credential`), e-mail normalizado e validade igual à da resposta; `GET /tenants/:id` não traz a senha; os dois registros de auditoria (`tenant.create` e `user.create`, com ator, cliente e estado novo) sem a senha, e o log capturado (`log-capture`) sem ela; o login com a temporária só alcança a troca de senha (`PASSWORD_CHANGE_REQUIRED`), a troca leva ao MFA (`MFA_REQUIRED`) e a temporária deixa de valer; **A/B:** com senha própria e MFA, o administrador novo lista só a si mesmo em Usuários, recebe 404 para um usuário do outro cliente e 403 em listar, ler, criar e alterar clientes (nada criado); e-mail já usado em outro cliente: 409 genérico sem citar o cliente, nenhum cliente criado, a conta existente intocada e só a tentativa (`failure`, 409) na auditoria; `firstAdmin` no PATCH é 400; CNPJ repetido também não cria a conta; as recusas 400 (sem administrador, e-mail inválido, papel ou senha no administrador) não criam nada. A suíte de permissões (admin_cliente, analista e leitura com 403 em todas as rotas) continua, com o corpo novo;
  - painel: 251 testes (`admin-pages.test.tsx`: validação dos campos do administrador, o aviso com a senha no formato da API, foco no título, cópia para a área de transferência, "Concluir" fecha e o cliente entra na lista, reabrir não traz a senha; a edição não mostra o bloco; o mock recusa e-mail repetido com 409 e cria o administrador) e o e2e `pages.mock.spec.ts` (43, com o formulário e o aviso sem violação de acessibilidade); `pnpm typecheck`, eslint e prettier limpos.
- **Decisões onde o pedido deixava margem:**
  - `expiresAt` entrou em `firstAdmin` junto com a senha (o pedido citava só `temporaryPassword`): é o que o `TemporaryPasswordNotice` mostra ("vale até") e o que `userCreatedSchema` já devolve;
  - o papel é fixo (`admin_cliente`) e não vem do corpo; o e-mail do administrador pode ser o mesmo do contato de escalonamento (são cadastros diferentes);
  - dois registros de auditoria em vez de um só com os dois estados: a trilha do cliente mostra "criou cliente" e "criou usuário" como qualquer outra conta criada, e o filtro por área (`resourceType`) encontra o usuário.
- **Fase 3:** este PR é o caminho manual, do nó da Verax (Clientes → Novo cliente, senha repassada por canal seguro). Nos nós de clientes, o primeiro administrador é criado pelo bootstrap do nó no provisionamento (CP-10), com o e-mail do checkout.
- **Definição de pronto:** critérios ✔ · testes, com o negativo A/B ✔ · lint e tipos ✔ · nenhuma dependência ✔ · regras de segurança ✔ (senha só na resposta; auditoria e log sem ela; autorização na API; nenhum dado real) · **aceite:** depende do responsável.
- **Teste manual:** no nó da Verax, depois do deploy, Clientes → Novo cliente com um e-mail de teste; copiar a senha, entrar com ela em outra janela, trocar a senha, cadastrar o MFA e conferir que Usuários lista só esse administrador e que Clientes dá "sem permissão".
- **Riscos:** a mensagem de e-mail repetido confirma que o e-mail existe na plataforma (a mesma escolha de Usuários, só para `admin_verax`); sem e-mail, a entrega da senha depende do canal escolhido pela equipe.
- **Revisão independente** (três apontamentos baixos, com testes novos; cada um conferido por mutação: desfeita a correção, o teste falha):
  - **registro adicional em trilha errada:** `AuditContext.also` sem `tenantId` caía na trilha do ator (nenhuma, para `admin_verax`), e não na do principal, então os dois registros de uma mesma requisição podiam ficar em trilhas diferentes. O `AuditInterceptor` passa a dar ao adicional o cliente do principal (o do escopo, marcado por `scoped()`) quando ele não informa um (`inheritTenant`, em `audit-request.ts`); `null` informado continua valendo como operação global. Teste em `audit.test.ts`, com `admin_verax` e cliente selecionado, pela sonda nova `POST /v1/widgets-probe/scoped/pair` (só nos testes): os dois registros na trilha do cliente, com o mesmo ator e request id; com `extraGlobal`, o adicional fora dela;
  - **hooks do Better Auth fora do caminho transacional:** `provisionUser` grava direto pelo Prisma dentro da requisição, sem o `createWithHooks` da biblioteca, então um `databaseHooks.user.create` ou `account.create` futuro rodaria no seed e no bootstrap, mas não em `POST /users` nem em `POST /tenants`. O invariante está no comentário da função e no teste novo `user-provisioning.test.ts`, que junta os hooks de onde o Better Auth os junta ao subir (a configuração e o `init` de cada plugin) e falha apontando o arquivo se um desses aparecer (a lista interna não fica no `$context`; os plugins em uso têm `init` puro);
  - **corrida de e-mail repetido:** o apontamento previa 500 quando duas requisições criam o mesmo e-mail ao mesmo tempo; não acontecia: o filtro global já traduz o `P2002` em 409 (`all-exceptions.filter.ts`), mas com a mensagem genérica de conflito, diferente da checagem prévia. `UsersService.provision` agora traduz o `P2002` da gravação para a mesma mensagem ("Já existe um usuário com este e-mail"). Teste (no mesmo arquivo): outra conta é confirmada entre a checagem e a gravação (`provisionUser` interceptado uma vez), em `POST /users` e em `POST /tenants`: 409 com a mensagem, a conta vencedora intocada e sem conta de senha, nenhum cliente criado e só a tentativa (`failure`, 409) na auditoria.

## Fase 2, pedido de 04/11/2026: Cloudflare Turnstile no login e no "esqueci minha senha" ⚠️ altera o módulo `auth`, `infra/` e `.github/`

- **Pedido:** o desafio do Cloudflare Turnstile nos dois formulários públicos do painel (entrar com e-mail e senha, e o pedido de redefinição de senha), conferido na API antes da senha, com o pacote do nó e o Terraform preparados para ligá-lo sem tocar no nó da Verax até o responsável decidir. Nada foi aplicado nem ligado: o nó da Verax sobe igual.
- **API (módulo `auth`, revisar linha a linha):**
  - **Ambiente** (`env.schema.ts`): `TURNSTILE_SECRET_KEY` e `TURNSTILE_SITE_KEY` opcionais, mas só as duas juntas (uma sem a outra deixaria o painel sem login; a recusa aponta a chave presente, sem mostrar valor); a chave do site é conferida pelo formato (`^[0-9]x[0-9A-Za-z_-]{20,40}$`, que aceita as reais `0x...` e as de teste da Cloudflare); `TURNSTILE_SITEVERIFY_URL` com o endpoint oficial como padrão e só alterável fora de produção (o servidor falso dos testes).
  - **Verificador** (`auth/turnstile.ts`): POST em JSON ao `siteverify` com `secret`, `response` e `remoteip` (o IP que o `AuthController` já calcula), 5 s de limite (`AbortSignal.timeout`), resposta validada com zod (`success`, `error-codes`, `challenge_ts`, `hostname`; o resto descartado). Sem token: `required`; token acima de 2048 caracteres: `failed` sem ir à rede; `success: false`: `failed` (só os `error-codes` no log); erro HTTP, JSON fora do formato, rede ou tempo esgotado: `unavailable`. A chave e o token nunca saem: nem no log, nem na mensagem.
  - **Hook `before` do Better Auth** (`auth.factory.ts`): em `/sign-in/email` e `/request-password-reset`, com a chave secreta definida, lê o header `x-turnstile-token` e confere **antes** de reservar a tentativa de login e de olhar a senha. Recusas: 400 `TURNSTILE_REQUIRED` ("Conclua a verificação de segurança e tente de novo"), 400 `TURNSTILE_FAILED` ("A verificação de segurança não foi aceita. Tente de novo") e, com o `siteverify` fora do ar, 503 `TURNSTILE_UNAVAILABLE` com a mensagem genérica da API (fecha, não abre). Cada recusa entra na trilha (`denied` nos 400, `failure` no 503), sem o token. Sem a chave secreta, nenhuma conferência; em produção, aviso na partida (`Turnstile desligado`). O limite por IP, o bloqueio por conta e o MFA seguem iguais.
  - **Configuração pública** (`auth/client-config.controller.ts`): `GET /v1/auth/client-config` → `{ turnstileSiteKey: string | null }`, sem sessão, com `Cache-Control: public, max-age=300`; registrado antes do `AuthController`, cujo `*path` o pegaria. Schema em `packages/shared` (`authClientConfigSchema`). O meta-teste das rotas públicas passa a listá-lo.
  - **CORS:** `x-turnstile-token` entra nos headers permitidos (sem isso o navegador nem manda o login).
- **Painel (`apps/web`):**
  - `features/auth/turnstile.ts`: carrega `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` uma vez (sem pacote do npm; `onload` próprio), desenha o widget no modo gerenciado com `turnstile.render` (tema `light`/`dark` do painel, redesenhado quando o tema muda; `language: pt-br`, o código que a Cloudflare usa; `size: flexible`; `response-field: false`; `action` `login` ou `password-reset`), acompanha token, expiração e erro, e `reset()` depois de um envio recusado (cada token vale uma vez). `turnstile-widget.tsx`: o contêiner (`data-turnstile`), "Carregando verificação…" (`role="status"`) até o widget aparecer e o aviso (`role="alert"`) quando ele não carrega ou a Cloudflare bloqueia.
  - `features/auth/client-config.ts`: `useAuthClientConfig()` lê a chave do site; sem ela (ou com a chamada falhando), os formulários são os de sempre. Com ela, o botão de enviar só liga com o token; o token vai no header `X-Turnstile-Token` (`ApiClient.post` ganhou `headers` a mais). Mensagem própria para `TURNSTILE_REQUIRED`/`TURNSTILE_FAILED`; no "esqueci a senha", essa recusa aparece como erro (as outras recusas 4xx continuam virando a mensagem de "enviado", que não revela o e-mail).
  - **CSP** (`build-guards.ts`, a mesma do `vite preview` e do Firebase Hosting): `script-src 'self' https://challenges.cloudflare.com` e `frame-src https://challenges.cloudflare.com`; nenhuma outra origem externa.
  - **Mock:** `GET /v1/auth/client-config` devolve a chave de `localStorage['verax.mock.turnstile']` (só com formato válido; sem ela, `null`) e, com a chave, o login e o pedido de redefinição exigem o header, como a API. A demonstração pública segue sem o desafio.
- **Pacote do nó (`infra/node/`, revisar linha a linha):**
  - `start.sh`: a chave do site no `node.conf` (`TURNSTILE_SITE_KEY`) é o interruptor. Sem a linha, o cofre nem é lido e o `api.env` sai idêntico ao de hoje (o nó da Verax). Com ela, a chave secreta vem do cofre `<prefixo>-turnstile-secret-key` com o padrão do token do túnel: cofre sem valor (`NOT_FOUND`, código 3) → sobe sem o desafio e avisa; qualquer outro erro → a partida para; as duas chaves entram no `api.env` só juntas. Subcomando `render` (só monta os arquivos de ambiente), para o teste.
  - `install.sh`: valida a linha opcional pelo mesmo formato da API. `node.conf.example` documenta.
  - **Teste novo** (`infra/node/tests/start-test.sh`): roda o `start.sh render` numa raiz temporária com o `gcloud` simulado (um cofre por arquivo) e confere o `api.env` byte a byte: sem a chave do site, igual ao de antes e sem nenhuma chamada ao cofre do Turnstile; cofre vazio, igual ao de antes com o aviso; as duas chaves, as duas linhas; sem permissão no cofre ou valor com quebra de linha, a partida para sem escrever o `api.env`.
- **Terraform (`infra/gcp/`, revisar linha a linha):** variável `turnstile_secret` do módulo (padrão `false`) cria o cofre `turnstile-secret-key` e o `secretAccessor` da VM; `envs/homolog-sp` liga (`true`); `envs/verax` não muda (o `plan` fica zero; o teste do nó da Verax confere que os cofres continuam só SMTP e túnel). Testes do módulo: cofre ligado (nome, região e permissão) e desligado por padrão.
- **CI (`.github/workflows/iac.yml`, revisar linha a linha):** o job do pacote do nó passa o shellcheck também em `infra/node/tests/*.sh` e roda o `start-test.sh`.
- **Documentação:** `docs/ARQUITETURA.md` ("Proteções do login"), `docs/runbooks/no-verax.md` (como ligar: cofre pelo Terraform, widget Managed com o hostname `veraxsistemas.com.br`, `gcloud secrets versions add`, chave do site no `node.conf`, reinício; e dois problemas comuns), `infra/gcp/GUIA.md` (passo 7 e a tabela), `.env.example`.
- **Arquivos:** `apps/api/src/auth/{turnstile.ts,turnstile.test.ts,client-config.controller.ts,auth.factory.ts,auth.module.ts}`, `apps/api/src/app.setup.ts`, `apps/api/src/common/config/{env.schema.ts,load-config.test.ts}`, `apps/api/test/{auth-turnstile.test.ts,auth-login.test.ts,auth-protections.test.ts,route-contracts.test.ts,support/create-app.ts}`, `packages/shared/src/session.ts`, `apps/web/src/features/auth/{turnstile.ts,turnstile-widget.tsx,client-config.ts,auth-api.ts}`, `apps/web/src/pages/{login-page.tsx,forgot-password-page.tsx,auth-pages.test.tsx}`, `apps/web/src/lib/{api-client.ts,api-client.test.ts}`, `apps/web/src/{build-guards.ts,build-guards.test.ts}`, `apps/web/src/mocks/{auth-handlers.ts,handlers.ts}`, `apps/web/e2e/turnstile.mock.spec.ts`, `infra/node/{bin/start.sh,bin/install.sh,node.conf.example,tests/start-test.sh}`, `infra/gcp/modules/node/{secrets.tf,variables.tf,tests/perfis.tftest.hcl,tests/lean_verax.tftest.hcl}`, `infra/gcp/envs/homolog-sp/main.tf`, `infra/gcp/GUIA.md`, `.github/workflows/iac.yml`, `.env.example`, `docs/ARQUITETURA.md`, `docs/runbooks/no-verax.md`.
- **Dependências:** nenhuma (o script do Turnstile vem da Cloudflare em tempo de execução, só com a chave do site).
- **Testes:**
  - API, banco real (`auth-turnstile.test.ts`, com um `siteverify` falso em 127.0.0.1): configuração pública com a chave e o cache, sem a secreta; login sem token → 400 seis vezes seguidas sem gastar tentativa nem falar com a Cloudflare, e depois a senha certa entra; token recusado → 400 genérico, sem sessão, com a chamada ao `siteverify` conferida (chave, token e IP em JSON) e a recusa na trilha sem o token; token aceito → senha errada conta tentativa, cadastro do MFA e o desafio do código no login seguinte; `siteverify` com 500 ou fora do formato → 503 genérico (`failure` na trilha); sem resposta → 5 s e 503; token acima do limite e token no corpo nem vão à rede; pedido de redefinição com as mesmas regras (sem e-mail nas recusas, e-mail com o token); as outras rotas não pedem token; nem a chave nem o token no log. Sem o Turnstile (`auth-login.test.ts`): configuração `null` e login sem token. CORS com o header. Unitários: verificador (`turnstile.test.ts`, 9 casos) e ambiente (`load-config.test.ts`, 4 casos).
  - Painel, unitários (`auth-pages.test.tsx`, com um dublê do objeto global do widget): sem chave nada aparece; com chave, o widget segue o tema (`dark` da preferência; trocado, redesenha) e o idioma, e o token vai no header; senha errada reinicia o widget e o envio seguinte leva outro token; recusa da API com mensagem própria; chave que bloqueia mostra o aviso e desliga o envio; script sem carregar mostra "Carregando verificação…" e desliga o envio; "esqueci a senha" com o token no header e a recusa do Turnstile como erro (não como "enviado"). `api-client.test.ts` (headers a mais), `build-guards.test.ts` (CSP).
  - Painel, e2e no modo mock com o widget de verdade (`turnstile.mock.spec.ts`, carrega `challenges.cloudflare.com`): chave de teste que sempre passa → widget visível, sem violação de acessibilidade, header `x-turnstile-token` no login e no pedido de redefinição (conferido na requisição e pelo mock, que recusa sem ele); chave que sempre bloqueia → aviso e botão desligado; tema escuro e o foco do teclado chegando ao widget. O widget fica numa shadow root fechada: o teste vê o elemento que a hospeda.
  - Infra: `start-test.sh` (5 cenários), shellcheck (Docker) nos três scripts, `terraform fmt`, `validate` e `test` no módulo (18) e nos dois ambientes (3 + 3), tflint.
  - Checks: `pnpm typecheck`, `eslint .`, `prettier --check`, `pnpm --filter @verax/web test`, suíte da API com o banco real.
- **Decisões onde o pedido deixava margem:**
  - o token só vai no header (um campo no corpo é ignorado): o `AuthController` já fecha os campos do Better Auth, e o header dispensa mexer nos schemas da biblioteca;
  - as duas chaves andam juntas na API (uma sem a outra é recusada na partida) e no `start.sh` (só entram juntas no `api.env`);
  - no nó, a chave do site no `node.conf` é o interruptor, e não a existência do cofre: um cofre que não existe responde `PERMISSION_DENIED` (e não `NOT_FOUND`) para uma conta sem permissão no projeto, o que pararia a partida do nó da Verax no próximo deploy. Sem a linha, o cofre nem é lido;
  - a chave do site aceita as de teste da Cloudflare (`1x…`, `2x…`, `3x…`), para desenvolvimento e e2e;
  - o `hostname` do `siteverify` é comparado com o do `WEB_ORIGIN` só com chave de site real (`0x…`); com as chaves de teste da Cloudflare ele é fictício e a conferência não se aplica (revisão de 04/11, abaixo).
- **Desvios do pedido:** nenhum. O "harness" do `start.sh` não existia; foi criado (`infra/node/tests/start-test.sh`), no estilo do `startup-test.sh`.
- **Definição de pronto:** aceite do código ✔ · testes (API com banco real, unitários, e2e com o widget de verdade, infra) ✔ · lint, tipos e Prettier ✔ · nenhuma dependência ✔ · regras de segurança ✔ (chave e token fora do log e da auditoria; entrada externa validada com zod; TLS de sempre; só chaves de teste documentadas pela Cloudflare no código) · **aceite:** depende de ligar na homologação.
- **O que o responsável precisa fazer para ligar (nada foi ligado):** na homologação, aplicar o Terraform (o cofre já entra), criar o widget Managed no Cloudflare com o hostname `veraxsistemas.com.br`, gravar a chave secreta no cofre `verax-homolog-turnstile-secret-key`, pôr `TURNSTILE_SITE_KEY` no `node.conf` e reiniciar; entrar e sair do painel, conferir o widget nos dois temas e o console do navegador sem violação de CSP; conferir no journal da API que não aparece `Turnstile desligado`. No nó da Verax, o mesmo caminho com `turnstile_secret = true` em `envs/verax/main.tf` (o `plan` mostra só o cofre e a permissão) e o cofre `verax-node-turnstile-secret-key`. Roteiro em `docs/runbooks/no-verax.md`.
- **Riscos e pendências:**
  - a CSP de produção libera só `script-src` e `frame-src` para a Cloudflare, como a documentação pede. Sondada na revisão, no build de produção com essa CSP: o widget aparece nos dois temas e nenhuma violação vem do Turnstile. A única `securitypolicyviolation` do console é a detecção de `Function` do zod v4 (`unsafe-eval`), que já existe na `main` e não afeta o painel: na homologação, "console sem violação de CSP" quer dizer "nenhuma além dessa". O e2e roda sobre o `vite dev`, que não manda a CSP;
  - build de demonstração/mock: o service worker do MSW tem um `connect-src` próprio que bloqueia o passthrough de `challenges.cloudflare.com`; com `verax.mock.turnstile` definido, o widget não carrega nesse build. Só afeta a demonstração (que segue sem o desafio); o e2e roda sobre o `vite dev --mode mock`, e produção não tem o MSW;
  - o e2e do Turnstile precisa de internet (carrega o script e o iframe de `challenges.cloudflare.com`); as chaves de teste da Cloudflare não contam no painel dela;
  - com o Turnstile ligado e o `siteverify` fora do ar, ninguém entra (503) até ele voltar: decisão de fechar, não abrir;
  - o painel só sabe da chave do site pela API: trocar a chave no nó vale em até 5 minutos (cache) ou num recarregamento.
- **Revisão independente de 04/11/2026 (duas lentes: segurança e painel), aplicada no mesmo PR:**
  - **S1, `action` e `hostname` do `siteverify`:** a resposta traz a `action` do widget que gerou o token; a API passou a exigir a da rota (`TURNSTILE_ACTIONS`: `/sign-in/email` → `login`, `/request-password-reset` → `password-reset`, as mesmas strings do painel). `action` diferente → 400 `TURNSTILE_FAILED`, com `reason: 'action-mismatch'` no log (sem o token); ausente na resposta, aceita. Com chave de site real (`0x…`), o `hostname` precisa ser o do `WEB_ORIGIN` (`hostname-mismatch`; ausente também recusa); com as chaves de teste, não se aplica. Testes: unitários (`turnstile.test.ts`: action igual, ausente e trocada; hostname com chave de teste e com chave no formato real) e de integração (`auth-turnstile.test.ts`: o `siteverify` falso devolve a `action` que o teste manda, token do login no pedido de redefinição e vice-versa, 400 sem gastar tentativa e com a recusa na trilha; `auth-turnstile-hostname.test.ts`: app com chave no formato real, hostname do `WEB_ORIGIN` entra, outro site, subdomínio ou sem hostname é 400).
  - **S2, redirecionamento do `siteverify`:** o `fetch` leva `redirect: 'error'` (a chave secreta vai no corpo e não deve seguir para outro endereço); um 3xx cai no `catch` → 503 genérico. Teste de integração com o `siteverify` falso respondendo 307 (o destino nunca é chamado) e unitário.
  - **S3, `GET /v1/auth/client-config` sem limite por IP:** sem mudança no código; registrado em `docs/ARQUITETURA.md`: a rota devolve um valor público constante lido da configuração em memória, com `Cache-Control: public, max-age=300`.
  - **W1, estado de erro do widget era definitivo:** depois de um erro, a Cloudflare tenta de novo sozinha; o `callback` do token agora volta o estado a `ready` e o aviso some. Teste unitário do hook (`features/auth/turnstile.test.tsx`).
  - **W2, "esqueci a senha" depois do envio:** o hook continuava com a chave mesmo com o formulário fora da tela (o widget ficava num `div` solto e era redesenhado a cada troca de tema). A tela passa `null` depois do envio: o widget é removido e o observador do tema desligado. Teste em `auth-pages.test.tsx` (`remove` chamado; trocar o tema não redesenha).
  - **W3, sem prazo para o script da Cloudflare:** `TURNSTILE_SCRIPT_TIMEOUT_MS` (15 s); passado, a carga rejeita, o script sai da página, a tela mostra o aviso e a carga seguinte tenta de novo (o erro atrasado da primeira não a derruba). Testes com relógio falso (`loadTurnstile` e o hook).
  - **W4, `infra/gcp/GUIA.md`, passo 7:** a linha do cofre do Turnstile ganhou o comentário "só com `turnstile_secret = true`" (o `envs/verax` continua `false`).
  - A sondagem da CSP de produção e a ressalva do build de demonstração estão em "Riscos e pendências".
- **Mesclagem da `main` com o cofre de credenciais (PR-V1, #47):** os dois interruptores do nó seguem independentes e desligados por padrão (sem `CREDENTIALS_VAULT=true` nem `TURNSTILE_SITE_KEY`, os arquivos de ambiente saem como na `main`). `env.schema.ts` com as variáveis e as checagens dos dois; no `start.sh`, a chave secreta do Turnstile é lida antes do cofre (uma falha nela para a partida antes de as chaves do worker irem para a memória) e o `api.env` leva as chaves do Turnstile e depois as do cofre; `install.sh`, `node.conf.example` e o runbook com os dois blocos (no runbook, o cofre antes da seção do Turnstile).
- **Mesclagem da `main` com o Wazuh no nó (PR-W1, #53):** o `start.sh` fica com os subcomandos dos dois (`wazuh-up`, `wazuh-down` e `render`), e o `api.env` leva as variáveis do indexer (standard), o tópico do sink, as do Turnstile e as do cofre, nessa ordem; o Turnstile só mexe no `api.env`. O `start-test.sh` virou duas partes: a do PR-W1 (os dois perfis, `bootstrap` e `pull_images`) e, num subshell com raiz e gcloud próprios, os cenários do Turnstile com o `start.sh render` e o `api.env` byte a byte (os três do tópico do sink saíram dessa parte, porque a do PR-W1 já os cobre); no `iac.yml`, os passos ficam onde o PR-W1 os pôs, com o Turnstile na descrição do `start-test.sh`.

## Informação comercial fora do repositório público ⚠️ altera `infra/`

- **Pedido:** o repositório continua público, mas sem informação comercial na árvore: preço dos planos, custo por cliente, margens, impostos, cupons, metas e caminhos do estudo de mercado (04/11/2026). O preço está sendo refeito (ambiente configurável, preço por componente; o site mostra só o "a partir de"), e valores no repositório ficariam velhos de qualquer forma.
- **O que saiu:**
  - `docs/ARQUITETURA.md`, seção "Custo estimado por nó", agora "Custo por nó": a tabela por plano (preço de cada plano, custo do nó, total e folga), as premissas de câmbio e de preço da nuvem, o desconto de uso contínuo, o plano B, a homologação parada e a pilha na AWS, todos com valores. Ficaram os recursos que pesam em cada perfil e os links para a calculadora da Google Cloud, os preços do S3 e a calculadora da AWS. O preço do certificado do Cloudflare de mais níveis (o motivo de a API ficar em `api-<cliente>`) virou "pago à parte";
  - `infra/gcp/GUIA.md`: o custo da homologação ligada e parada (é o de um nó de cliente) virou a lista do que é cobrado, com a calculadora; o cupom da Stripe saiu (os passos citam "cupons, se houver", com os termos fora do repositório), e os preços continuam só pelos `lookup_key`; o nome do arquivo do plano da fase 3 virou "documento interno";
  - `infra/gcp/envs/homolog-sp/variables.tf`: a mesma estimativa, na descrição de `monthly_budget` (só o texto; o padrão não mudou);
  - `infra/cloudformation/README.md` e `GUIA-NO.md`: o custo na conta AWS do cliente e o da pilha do nó na AWS viraram links para os preços e a calculadora da AWS;
  - este arquivo: só a linha com o custo da homologação ligada (riscos do PR-04'), com o valor trocado por "valor fora do repositório público". O resto do registro não mudou.
- **O que ficou, de propósito:** o custo e o orçamento da infraestrutura da própria Verax (nó `lean` e plano de controle, no GUIA, no `ARQUITETURA.md` e nos `.tf`), que não é preço nem custo de cliente; os limites de cada plano (contas, usuários, GiB e histórico), que o código aplica (`packages/shared/src/plans.ts`); os `lookup_key` da Stripe, que o plano de controle usa; preços de nuvem citados como motivo de decisões antigas neste registro e no comentário do checkov do template do nó na AWS.
- **Preço no código:** nenhum valor na `main`. O plano de controle só conhece os `lookup_key` (`STRIPE_PRICE_LOOKUP_ESSENCIAL` e `STRIPE_PRICE_LOOKUP_PROFISSIONAL`, em `env.schema.ts` e em `infra/gcp/envs/control-plane/run.tf`), e não há script de catálogo da Stripe na `main`. O catálogo vai para um arquivo lido em tempo de execução, num PR próprio.
- **Histórico do git:** não foi reescrito (decisão do responsável). Os valores antigos continuam nos commits anteriores.
- **Dependências:** nenhuma.
- **Testes:** só documentação e a descrição de uma variável do Terraform. `terraform fmt -check -recursive infra/gcp` e `validate` em `envs/homolog-sp`; Prettier limpo; nova busca por `R$`, `US$`, margem, desconto de uso contínuo, cupom e o caminho do estudo, sem nada comercial.
- **Definição de pronto:** nada comercial na árvore ✔ · informação de operação mantida ✔ · nenhuma dependência ✔ · regras de segurança ✔ · **aceite:** o responsável aprova o texto.

## Licença proprietária: código-fonte disponível, todos os direitos reservados

- **Pedido:** uma licença explícita para o repositório público: o código fica aberto só para leitura, revisão de segurança e auditoria por clientes e pesquisadores; usar, copiar, modificar, distribuir, sublicenciar, executar para terceiros ou oferecer como serviço depende de contrato escrito (04/11/2026).
- **Arquivos:** `LICENSE` (novo, em português, com a tradução em inglês só como referência), `README.md` (seção "Licença"), `package.json` da raiz (`"license"` de `UNLICENSED` para `SEE LICENSE IN LICENSE`) e dos quatro workspaces (`apps/api`, `apps/control-plane`, `apps/web`, `packages/shared`, que não tinham o campo). O `"private": true` continua em todos.
- **Titular:** "Verax Sistemas", CNPJ 34.282.636/0001-95, como no rodapé do site. A razão social não aparece no site: conferir no cartão do CNPJ e trocar no `LICENSE` se for diferente.
- **O que o `LICENSE` diz:** titularidade (Leis 9.609/1998 e 9.610/1998); a finalidade da publicação; o que vale sem contrato (ler, analisar e executar localmente, isolado e fora de produção, só para avaliar a segurança; citar trechos em relatórios), com a ressalva do fork dentro do GitHub pelos Termos de Serviço dele; o que é proibido sem contrato; nenhum direito de marca; divulgação responsável pelo `SECURITY.md`; os componentes de terceiros seguem as licenças deles (dependências do pnpm, imagens do Wazuh em GPLv2 e do Prowler em Apache-2.0, providers do Terraform), sem redistribuição por este repositório, e a parte derivada de arquivo de terceiro segue a licença original; sem garantia; limitação de responsabilidade; o contrato prevalece; violação encerra as permissões; lei brasileira e foro do domicílio da Titular; o português prevalece sobre a tradução.
- **CI:** nenhuma política de licença a ajustar. O Dependency Review só tem `fail-on-severity`, sem `allow-licenses` nem `deny-licenses`; o Trivy roda com `vuln,secret,misconfig` (sem `license`); o OSV-Scanner não olha licença. `pnpm install --frozen-lockfile` passa sem mudar o lockfile (o campo não entra nele).
- **Revisão jurídica, obrigatória antes de vender o modo self-hosted:** o `LICENSE` foi escrito sem advogado e vale como está até a revisão. Pontos para ela:
  - a razão social da Titular e o foro;
  - arquivos baseados no Wazuh, que é GPLv2: `infra/wazuh/config/manager/rules/verax_aws_rules.xml` (regras do ruleset do Wazuh sobrescritas, com o resto de cada regra igual ao original), `infra/wazuh/config/manager/ossec.conf` e `infra/wazuh/config/indexer/opensearch.yml` (a partir dos arquivos do single-node do wazuh-docker), `infra/wazuh/docker-compose.yml` e `infra/node/compose.wazuh.yaml` (a partir do compose do single-node). Decidir se precisam do aviso da GPLv2 (ou da licença do arquivo de origem) e se podem ficar sob este `LICENSE`;
  - o modo self-hosted: o pacote do nó instala as imagens do Wazuh (GPLv2) na máquina do cliente, e o contrato precisa tratar disso;
  - contribuições de fora (pull requests): não há cessão de direitos nem acordo de contribuição;
  - `elkjs` (EPL-2.0), que chega à imagem das migrations pelo CLI do Prisma (`@prisma/studio-core`); as outras dependências de produção têm licenças permissivas (MIT, Apache-2.0, ISC, BSD, BlueOak, 0BSD, Unlicense, MIT-0 e PSF-2.0, por `pnpm -r licenses list --prod`);
  - o alcance da execução local liberada no item 3(b).
- **Dependências:** nenhuma.
- **Testes:** `pnpm install --frozen-lockfile --offline` sem mudança; Prettier limpo; gitleaks pelo hook.
- **Definição de pronto:** `LICENSE` e seção no README ✔ · campo nos cinco `package.json` ✔ · CI sem política afetada ✔ · nenhuma dependência ✔ · regras de segurança ✔ · **aceite:** depende do responsável e da revisão jurídica.
