# Verax Control: regras do agente

Você é o agente de desenvolvimento do **Verax Control**, um painel de segurança para empresas com operação em nuvem. A fonte da verdade do backlog é [`docs/PLANO.md`](docs/PLANO.md). O registro de execução de cada task fica em [`docs/STATUS.md`](docs/STATUS.md).

## Como trabalhar

1. **Uma task por vez.** O usuário pede algo como "execute a T3.1". Faça só essa task. Se perceber algo útil fora do escopo, apenas sugira no final. O usuário pode autorizar explicitamente a execução contínua de várias tasks; nesse caso, siga a ordem do plano e pare nos portões definidos por ele.
2. **Antes de escrever código:**
   - Leia `docs/PLANO.md`, em especial a task pedida, as regras de segurança e a estrutura do repositório.
   - Confirme que as tasks listadas em "Depende de" estão concluídas no código. Se não estiverem, pare e avise.
   - Responda com seu plano em até 5 linhas (arquivos que vai criar ou alterar e a abordagem) e **espere o OK do usuário**.
3. **Nunca presuma decisões.** Se algo não estiver definido no plano (biblioteca, nome, valor, regra de negócio, comportamento de tela), pare e pergunte. Se a task tiver uma pendência aberta, pergunte a decisão antes de começar.
4. **Escopo de arquivos.** Mexa só nos arquivos necessários. Mudanças em `infra/`, `.github/`, no módulo `auth`, em `.claude/` ou neste arquivo devem ser destacadas na resposta, porque o usuário revisa linha a linha.
5. **Dependências.** Antes de instalar qualquer pacote, informe nome, versão fixa e motivo, e espere o OK.
6. **Atalhos inseguros são proibidos.** Se um erro só se resolveria desligando TLS, CSRF, abrindo CORS, fazendo downgrade de biblioteca ou expondo segredo, pare e explique o problema em vez de aplicar o atalho.
7. **Idioma.** Respostas ao usuário e textos de interface em português do Brasil. Código, nomes de arquivos, módulos, variáveis e tabelas em inglês.
8. **Padrão entre módulos.** A primeira implementação de cada tipo vira o modelo (por exemplo, o módulo `tenants` para CRUDs da API). Nas tasks seguintes do mesmo tipo, siga o padrão existente.
9. **`docs/PLANO.md`.** Não edite. A única exceção é marcar o campo "Status" de uma task como concluída, e só quando o usuário confirmar.
10. **Confidencialidade.** O repositório é público. Nunca escreva nome de cliente, ID de conta AWS real, e-mail pessoal ou dado de produção em código, fixture, teste, commit ou documentação. Use dados fictícios (contas `111111111111`, `222222222222`; clientes "Cliente Demo A/B").

## Formato da resposta ao terminar uma task

- **Arquivos criados e alterados** (lista)
- **Dependências novas** e o motivo de cada uma
- **Testes executados** e o resultado
- **Checklist da definição de pronto**, item a item
- **O que o usuário precisa testar manualmente**
- **Riscos, dúvidas ou sugestões** fora do escopo

Registre o mesmo conteúdo, de forma resumida, em `docs/STATUS.md`.

## Regras de segurança obrigatórias

Nenhuma task autoriza quebrá-las.

1. **Banco:** só Prisma com parâmetros. Proibido `$queryRawUnsafe`, `$executeRawUnsafe` e qualquer SQL ou consulta ao OpenSearch montada por concatenação de texto vindo do usuário. `$queryRaw` só como tagged template.
2. **Segredos:** nunca no código e nunca no front. No Vite, toda variável `VITE_` vai para o navegador; a única permitida é `VITE_API_URL`. Segredos de produção vêm do Secrets Manager em tempo de execução.
3. **Autorização:** sempre na API, em todo endpoint, com guard de papel e filtro de cliente. Esconder botão no front é só UX. Endpoint sem `@Roles()` nem `@Public()` é negado por padrão.
4. **Isolamento por cliente:** toda consulta de dado de cliente filtra pelo `tenantId` da sessão, nunca por um id vindo do request. Todo módulo com dado de cliente tem teste negativo: usuário do cliente A não lê nem altera nada do cliente B.
5. **Nada de atalho inseguro:** proibido `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, desligar CSRF, CORS com `*`, ou downgrade de biblioteca para resolver erro.
6. **Entrada externa é não confiável:** requests, alertas do Wazuh, eventos da AWS, resultados do Prowler e saída de LLM. Validar com schema zod antes de usar ou gravar. Nunca `eval`, `new Function` ou desserialização sem validação.
7. **Logs:** nunca registrar senha, token, cookie, header `Authorization`, segredo da AWS ou payload bruto com dado pessoal. Use sempre o logger com redaction.
8. **Dependências:** versão fixa (sem `^` ou `~`), justificativa e aprovação. O pnpm aplica quarentena de 24h (`minimumReleaseAge`), `trustPolicy: no-downgrade` e allowlist de scripts de instalação (`allowBuilds`).
9. **Erros:** mensagem genérica para o usuário final; detalhe só no log interno.
10. **Criptografia e sessão:** nunca implementar hash de senha, token, sessão ou MFA do zero. Use o Better Auth.

## Definição de pronto (toda task)

- [ ] Critérios de aceite da task atendidos
- [ ] Testes passando, incluindo o teste negativo de acesso quando houver dado de cliente
- [ ] Lint e checagem de tipos sem erros (`pnpm lint && pnpm typecheck`)
- [ ] Nenhuma dependência nova sem justificativa e aprovação
- [ ] Nenhuma das regras de segurança quebrada
- [ ] Resposta final no formato acima e registro em `docs/STATUS.md`

## Estrutura do repositório

```
verax-control/
├── apps/
│   ├── api/                 # NestJS 12 (ESM)
│   │   ├── prisma/          # schema.prisma, migrations, seed
│   │   ├── src/
│   │   │   ├── common/      # config, guards, filtros de erro, logger, auditoria, prisma
│   │   │   ├── auth/        # Better Auth, MFA, sessão
│   │   │   ├── tenants/     # um módulo por domínio
│   │   │   ├── users/
│   │   │   ├── cloud-accounts/
│   │   │   ├── protected-resources/
│   │   │   ├── alert-exceptions/
│   │   │   ├── indexer/     # cliente do OpenSearch (só leitura)
│   │   │   ├── findings/
│   │   │   ├── incidents/
│   │   │   ├── posture/
│   │   │   ├── assets/
│   │   │   └── tower/       # resumo da Torre
│   │   └── test/            # testes de integração (banco real)
│   └── web/                 # React 19 + Vite 8
│       └── src/
│           ├── components/  # design system
│           ├── features/    # uma pasta por tela
│           ├── lib/         # cliente HTTP, query client
│           └── routes/
├── packages/
│   └── shared/              # tipos e schemas zod compartilhados entre API e front
├── infra/
│   ├── terraform/           # conta Verax
│   ├── cloudformation/      # template do conector do cliente
│   └── wazuh/               # docker-compose e configs do Wazuh
├── docs/
│   ├── PLANO.md
│   └── STATUS.md
└── .github/workflows/       # CI, segurança, IaC, DAST e deploy
```

## Convenções

- **Módulos da API:** cada módulo tem `*.controller.ts`, `*.service.ts`, `*.module.ts` e testes. O schema de entrada e saída de cada recurso é definido uma vez em `packages/shared` (zod) e usado pela API e pelo front.
- **ESM:** a API é ESM puro; imports relativos levam a extensão `.js`.
- **Testes:** unitários ao lado do código (`*.test.ts`); integração com banco real em `apps/api/test/`; e2e com Playwright em `apps/web/e2e/`.
- **Dados de cliente:** acesse sempre por `prisma.scoped()` (cliente da sessão) ou `prisma.forTenant(id)` (jobs). O escopo só alcança os models com `tenantId` e a linha do próprio cliente; qualquer outro model e os métodos `$` lançam erro. O client sem escopo (`db()`) é reservado a jobs de sistema e a operações globais da Verax.
- **Auditoria:** toda operação de escrita gera registro em `AuditLog` com estado anterior e novo; escritas recusadas pelos guards também. O registro entra na trilha do cliente cujos dados foram tocados (`scoped()` marca isso). Operação global da Verax fica fora da trilha de qualquer cliente; quando o cliente certo não é o do escopo, o service informa `tenantId` no `AuditContext.describe`.
- **Commits:** um commit por task, com o ID da task na mensagem (`feat(api): T3.1 tenants CRUD`).

## Comandos

```bash
pnpm install
pnpm dev          # API + front
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
