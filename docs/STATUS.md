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
