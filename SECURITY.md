# Política de segurança

O Verax Control é um painel de segurança; levamos a sério qualquer problema no próprio produto.

## Como reportar uma vulnerabilidade

**Não abra issue pública.** Use o reporte privado do GitHub:
[Security → Report a vulnerability](https://github.com/williandotdev/verax-control/security/advisories/new).

Inclua, se possível:

- descrição do problema e impacto esperado
- passos para reproduzir ou prova de conceito
- versão ou commit afetado

Respondemos em até 5 dias úteis e combinamos com você o prazo de correção e de divulgação.

## Escopo

Estão no escopo: a API (`apps/api`), o front (`apps/web`), os pacotes compartilhados, os templates de infraestrutura (`infra/`) e os workflows do GitHub Actions.

Áreas de maior interesse: autenticação e MFA, isolamento de dados entre clientes, permissões por papel, exposição de segredos e o template do conector AWS do cliente.

## Fora do escopo

- Ataques de negação de serviço volumétricos
- Engenharia social contra a equipe
- Vulnerabilidades em dependências já reportadas publicamente e sem exploração demonstrada no produto

## Práticas adotadas

- Varredura automática em todo PR: Semgrep, CodeQL, Gitleaks, Trivy, OSV-Scanner e Dependency Review
- Dependências com versão fixa, quarentena de 24h para versões novas e checagem de provenance
- Actions do CI fixadas por SHA, com permissões mínimas
- Secret scanning com push protection
