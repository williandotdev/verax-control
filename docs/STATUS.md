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
  - no WAF e no GuardDuty, a conta de cada alerta vem do `sts:GetCallerIdentity` com o papel assumido, ou seja, a conta do cliente (o que a T5.2 usa para atribuir o alerta);
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
