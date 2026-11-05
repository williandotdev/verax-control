# Verax Control

Painel de segurança para empresas com operação em nuvem. O Wazuh (open source) e coletores próprios fazem a coleta e a detecção, a API transforma alertas em decisões e o painel mostra, em português claro, se está tudo bem e o que o gestor precisa decidir.

## Estrutura

```
apps/api         API NestJS (auth, RBAC, isolamento por cliente)
apps/web         Front React + Vite
packages/shared  Tipos e schemas compartilhados
infra/           Terraform, CloudFormation e Wazuh
docs/            PLANO.md (backlog) e STATUS.md (execução)
```

## Requisitos

- Node.js 24 (`.nvmrc`)
- pnpm 11
- Docker (PostgreSQL local)

## Primeira execução

```bash
pnpm install          # instala dependências e os hooks do git
pnpm setup:env        # cria o .env com segredos aleatórios (nunca versionado)
docker compose up -d  # PostgreSQL 18 local, só em 127.0.0.1
pnpm db:deploy        # aplica as migrations no banco de desenvolvimento
```

## Comandos

```bash
pnpm dev        # API + front em modo desenvolvimento
pnpm build
pnpm test       # inclui testes de integração com o banco verax_test (precisa do docker compose)
pnpm lint
pnpm typecheck
pnpm db:migrate # cria uma migration nova a partir do schema.prisma (desenvolvimento)
pnpm db:seed    # admin Verax e dois clientes fictícios (credenciais em SEED_ADMIN_* no .env)
pnpm --filter @verax/web dev:mock   # painel sem a API, com dados fictícios: abre no login (acesso de demonstração na tela);
                                    # localStorage verax.mock.role = papel, verax.mock.session = 'logged-in' já entra
pnpm --filter @verax/web test:e2e   # testes de navegador (Playwright + axe)
```

## Segurança

Veja [SECURITY.md](SECURITY.md) para reportar vulnerabilidades.

## Licença

O código é público para leitura, revisão de segurança e auditoria, mas não é de código aberto: todos os direitos são
reservados à Verax Sistemas. Usar, copiar, modificar, distribuir, executar para terceiros ou oferecer como serviço
depende de contrato escrito. Os termos completos estão em [LICENSE](LICENSE); os componentes de terceiros seguem as
licenças próprias deles.
