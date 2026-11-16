# Publicação do painel (Firebase Hosting)

O painel é estático e fica no Firebase Hosting, um site por destino, cada um com o próprio domínio. Desde a
atualização da frota (decisão de 16/11/2026), há dois caminhos:

| Destino                | Domínio                                  | Quem publica                                                                     |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Demonstração comercial | `control.veraxsistemas.com.br`           | O workflow `Painel`, a cada merge na `main` que mexa no painel (modo `demo`)     |
| SOC da própria Verax   | `verax.control.veraxsistemas.com.br`     | A frota, junto com a célula da Verax (a canária, onda 0), pelo plano de controle |
| Cada cliente           | `<cliente>.control.veraxsistemas.com.br` | O provisionamento (o primeiro) e a frota, junto com o nó do cliente              |

**Por que a produção saiu do merge:** com o painel indo a todo site a cada merge, ele podia ficar à frente da API do
nó de cada destino, que só mudava com o `deploy.sh`. Agora o painel de produção é o **bundle da versão do nó**
(`panel-<commit>.tar.gz`, o build único do `apps/web`, montado pelo workflow `Versão do nó` e citado, com o SHA-256, no
manifesto assinado), e o plano de controle o publica num site só depois de o nó daquele destino estar de pé na mesma
versão (`docs/ARQUITETURA.md`, "Atualização da frota"). A lista dos sites sai do registro dos clientes e das células no
Firestore, e não mais de um secret.

## Segurança

- **Login sem chave.** O GitHub Actions entra na GCP por Workload Identity Federation, como a conta
  `painel-deployer@verax-control-prod`. Ela só pode ser usada por jobs deste repositório no environment `painel`, e
  esse environment só aceita a `main`. A conta só tem `firebasehosting.admin` no projeto `verax-control-prod`; não
  alcança o Verax OS nem o site.
- **Os sites de produção pelo plano de controle:** o `cp-worker` publica só nos projetos do pool do Firebase
  (`firebase_panel_projects`), com o bundle conferido pelo SHA-256 do manifesto assinado e a CSP de cada site com a API
  do próprio cliente (o marcador `{tenant}` da configuração-modelo trocado pelo subdomínio do site).
- **Sem dependência nova.** As duas publicações usam a API REST do Firebase Hosting
  (`scripts/firebase-hosting-deploy.mjs` e `apps/control-plane/src/provisioning/panel-publish.ts`), sem
  `firebase-tools`.
- **Cabeçalhos.** CSP, HSTS, anti-iframe e afins são gerados no build a partir da mesma função dos testes e2e
  (`apps/web/src/hosting.ts`), e o workflow confere a CSP e o HSTS na demonstração publicada.
- **Cache.** Tudo é revalidado a cada visita (`no-cache`), inclusive a raiz e as rotas da aplicação, que devolvem o
  `index.html`: depois de uma publicação, ninguém fica com um `index.html` velho apontando para arquivos que já não
  existem. Só `/assets/` (nomes com hash) tem cache de um ano.
- **Demonstração.** O build `demo` não conecta em nenhuma API: a CSP só permite a própria origem, e uma faixa avisa,
  em toda tela, que os dados são fictícios.

## Configuração (environment `painel` no GitHub)

| Nome               | Tipo     | Valor                                                                        |
| ------------------ | -------- | ---------------------------------------------------------------------------- |
| `GCP_DEPLOY_SA`    | variável | `painel-deployer@verax-control-prod.iam.gserviceaccount.com`                 |
| `GCP_WIF_PROVIDER` | variável | provedor `github-provider` do pool `github-pool` (projeto `verax-os-shared`) |

O site e o domínio da demonstração estão no próprio workflow (são públicos). O secret `PAINEL_SITES` deixou de ser
lido: apague-o do environment depois de o painel da equipe da Verax passar para a frota (abaixo).

## O painel da equipe da Verax na frota

O site de hoje (`verax-control-verax`) está no projeto do plano de controle (`verax-control-prod`), fora do alcance do
`cp-worker` de propósito (lá ficam também `conta.veraxsistemas.com.br` e a demonstração). Para ele andar com a célula:

1. Crie um site novo num projeto do pool (`firebase_panel_projects`), com a conta de administrador:
   `POST https://firebasehosting.googleapis.com/v1beta1/projects/PROJETO_DO_POOL/sites?siteId=SITE_DA_EQUIPE`.
2. Grave `staffPanel` no registro da célula (`docs/runbooks/celula.md`, "Na atualização da frota") com esse projeto,
   esse site e o subdomínio `verax`.
3. Promova uma versão para a frota (`docs/runbooks/console-do-responsavel.md`, "Versões do nó e da frota"): a onda 0
   publica o bundle no site novo. Confira em `https://SITE_DA_EQUIPE.web.app`.
4. Mude o domínio `verax.control.veraxsistemas.com.br` do site antigo para o novo (`customDomains`: apague no antigo,
   crie no novo e crie no Cloudflare, sem proxy, os registros que o Firebase pedir). Há alguns minutos sem o domínio
   enquanto o certificado sai.
5. Apague o secret `PAINEL_SITES` e, depois de conferir o domínio, o site antigo.

Até o passo 4, o site antigo fica na versão da última publicação do workflow (o merge não o atualiza mais).

## Um site novo (cliente)

O provisionamento cria o site do cliente no pool (`firebase.site`), publica o bundle da versão do nó, conecta o domínio
`<cliente>.control...` e cria os registros no Cloudflare (`docs/runbooks/provisionamento.md`). Daí em diante, o site
anda com o nó do cliente em cada rodada da frota. Nada a fazer à mão.

A API do cliente fica em `api-<cliente>.veraxsistemas.com.br`, um nível só abaixo do domínio, para caber no
certificado gratuito do Cloudflare (`docs/ARQUITETURA.md`).
