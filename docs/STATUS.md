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
| shadcn/ui           | Componentes no padrão shadcn/ui escritos no repositório sobre `radix-ui`, sem rodar o CLI                     | O `init` do CLI instala pacotes fora da lista aprovada e baixa código da internet direto para o repo; os componentes são os mesmos padrões, revisados linha a linha                                                             |

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
