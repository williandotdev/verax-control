# Publicação do painel (Firebase Hosting)

O painel é estático e fica no Firebase Hosting do projeto `verax-control-prod` (GCP, organização da Verax). Cada
destino é um site do Firebase com o próprio domínio. A publicação é automática a cada merge na `main` que mexa no
painel (workflow `Painel`), e também pode ser disparada à mão.

| Destino                | Domínio                                  | Modo                                                            |
| ---------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| Demonstração comercial | `control.veraxsistemas.com.br`           | `demo`: dados fictícios simulados no navegador, sem nenhuma API |
| SOC da própria Verax   | `verax.control.veraxsistemas.com.br`     | produção, API em `api.verax.control.veraxsistemas.com.br`       |
| Cada cliente           | `<cliente>.control.veraxsistemas.com.br` | produção, API em `api.<cliente>.control.veraxsistemas.com.br`   |

## Segurança

- **Login sem chave.** O GitHub Actions entra na GCP por Workload Identity Federation, como a conta
  `painel-deployer@verax-control-prod`. Ela só pode ser usada por jobs deste repositório no environment `painel`, e
  esse environment só aceita a `main`. A conta só tem `firebasehosting.admin` no projeto `verax-control-prod`; não
  alcança o Verax OS nem o site.
- **Sem dependência nova.** A publicação usa a API REST do Firebase Hosting (`scripts/firebase-hosting-deploy.mjs`),
  sem `firebase-tools`.
- **Cabeçalhos.** CSP, HSTS, anti-iframe e afins são gerados no build a partir da mesma função dos testes e2e
  (`apps/web/src/hosting.ts`), e o workflow confere a CSP e o HSTS no site publicado.
- **Demonstração.** O build `demo` não conecta em nenhuma API: a CSP só permite a própria origem, e uma faixa avisa,
  em toda tela, que os dados são fictícios.

## Configuração (variáveis do environment `painel` no GitHub)

| Variável           | Valor                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| `GCP_PROJECT`      | `verax-control-prod`                                                         |
| `GCP_DEPLOY_SA`    | `painel-deployer@verax-control-prod.iam.gserviceaccount.com`                 |
| `GCP_WIF_PROVIDER` | provedor `github-provider` do pool `github-pool` (projeto `verax-os-shared`) |
| `PAINEL_SITES`     | lista JSON dos sites (abaixo)                                                |

```json
[
  { "site": "verax-control-demo", "dominio": "control.veraxsistemas.com.br", "modo": "demo" },
  {
    "site": "verax-control-verax",
    "dominio": "verax.control.veraxsistemas.com.br",
    "api": "https://api.verax.control.veraxsistemas.com.br"
  }
]
```

A lista fica fora do código porque os nomes de cliente não entram no repositório. Os logs do Actions deste repositório
são públicos e mostram os sites publicados; o domínio já é público de qualquer forma (DNS e certificados).

## Acrescentar um site (novo cliente)

1. Crie o site no Firebase (nome `verax-control-<cliente>`) com a conta de administrador:
   `POST https://firebasehosting.googleapis.com/v1beta1/projects/verax-control-prod/sites?siteId=verax-control-<cliente>`.
2. Acrescente a entrada em `PAINEL_SITES` e rode o workflow `Painel` (Actions → Painel → Run workflow).
3. Conecte o domínio próprio, criado na API de domínios do site (`customDomains`). Ela devolve os registros de DNS. No
   Cloudflare, crie esses registros com o proxy **desligado** ("DNS only"): o Firebase emite e renova o certificado.
4. Confira: `curl -sI https://<cliente>.control.veraxsistemas.com.br/` deve mostrar `content-security-policy` com a
   API do cliente.
