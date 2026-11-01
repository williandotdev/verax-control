# Verax Control

Painel de segurança para empresas com operação em nuvem. Ferramentas open source (Wazuh, Prowler) fazem a coleta e a detecção, a API transforma alertas em decisões e o painel mostra, em português claro, se está tudo bem e o que o gestor precisa decidir.

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
```

## Comandos

```bash
pnpm dev        # API + front em modo desenvolvimento
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## Segurança

Veja [SECURITY.md](SECURITY.md) para reportar vulnerabilidades.
