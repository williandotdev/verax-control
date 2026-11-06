# Instalação na infraestrutura do cliente (contrato direto)

Pelo site, o Verax Control roda sempre na infraestrutura da Verax. Num **contrato direto**, o responsável pode cadastrar
o cliente com o ambiente na **infraestrutura do próprio cliente** (console, Clientes → Novo cliente → "Infraestrutura do
cliente"). Nesse caso o plano de controle da Verax não cria nada: nenhum nó, túnel, DNS, painel nem estado do Terraform
na Verax, e a Verax não recebe nem pede acesso à conta do cliente. Este é o guia que o cliente segue.

O console (detalhe do cliente → "Instalação na infraestrutura do cliente") mostra o que a Verax manda: a versão do nó
(`node-vX.Y.Z` e o commit), os endereços do release no GitHub (o manifesto `manifest.json`, a assinatura
`manifest.json.sig` e o pacote `verax-node.tar.gz` com o SHA-256), as imagens pelo digest, a **impressão digital da
chave que assinou** o manifesto e as linhas do plano no `node.conf` (o contrato). Nada disso é segredo; a impressão
digital vai por um canal do contrato (e-mail, documento assinado), fora do GitHub.

## O que muda em relação ao ambiente na Verax

|                  | Na infraestrutura da Verax                     | Na do cliente (este guia)                                                 |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Quem cria e paga | A Verax (provisionamento automático)           | O cliente, na conta dele                                                  |
| Painel e API     | `<slug>.control.veraxsistemas.com.br`, Verax   | Domínio do cliente, servido por ele                                       |
| Primeiro acesso  | E-mail "ambiente pronto" com link de uso único | Senha temporária no cofre do próprio cliente                              |
| Atualização      | A Verax                                        | O cliente, com cada versão conferida (abaixo)                             |
| Fim do contrato  | A Verax apaga tudo (D+30 e D+97)               | A Verax apaga só o cadastro dela; o **cliente apaga o ambiente** (abaixo) |

Hoje o pacote do nó roda numa VM Debian 12 da **Google Cloud**: ele usa o Secret Manager, os metadados da VM e a
conta de serviço da VM. Outra nuvem é sob consulta (o porte está desenhado, não feito).

## 1. Conferir a versão, antes de qualquer coisa

Com `VERSAO` igual à do console (ex.: `node-v1.2.3`), numa máquina com `git`, `curl` e `openssl`:

```bash
git clone --depth 1 --branch "$VERSAO" https://github.com/williandotdev/verax-control.git
cd verax-control
base="https://github.com/williandotdev/verax-control/releases/download/$VERSAO"
curl -fsSLO "$base/manifest.json" && curl -fsSLO "$base/manifest.json.sig"
# A impressão digital da chave tem de ser a que a Verax mandou pelo contrato:
openssl pkey -pubin -in infra/node/keys/release-node-manifest-v1.pem -outform DER | openssl dgst -sha256
bash infra/node/bin/verify-release.sh manifest.json manifest.json.sig infra/node/keys   # tem de dizer OK
```

Só depois do `OK`, leia do **mesmo** `manifest.json` o commit (`version`), o `package.sha256` e as imagens (`images` e
`thirdPartyImages`): são os valores do console. Um manifesto que não fecha com a chave é recusado; não instale. O formato
do manifesto e como ele é assinado estão em `docs/runbooks/versao-no.md`. Para as versões seguintes, confira sempre com
as chaves da versão **já instalada** (o clone da versão anterior), nunca com as da versão nova.

## 2. A infraestrutura no projeto do cliente

O nó é o módulo `infra/gcp/modules/node` (perfil `standard`, com o Wazuh) com a instalação sem operador do PR-N7, o
mesmo dos nós na Verax, aplicado pelo cliente no projeto dele. O passo a passo é o de `infra/gcp/GUIA.md`, "O projeto
dos nós e o nó de cada cliente", com estas diferenças:

1. **`envs/nodes-platform`** no projeto do cliente **sem** `control_plane_project_id`: só as APIs e o bucket do estado
   (nenhuma permissão para contas da Verax).
2. **`envs/tenant`** no mesmo projeto, com:
   - `slug`: o subdomínio do contrato (os recursos nascem como `vx-<slug>`);
   - `node_version` e `node_package_sha256`: a versão e o SHA-256 do passo 1;
   - `web_origin` e `api_origin`: o painel e a API **no domínio do cliente**, no mesmo domínio registrável (os cookies
     são `SameSite=strict`), ex.: `https://soc.cliente.com.br` e `https://api-soc.cliente.com.br`;
   - `plan` e `plan_*`: as linhas do console (`PLAN=enterprise` e os limites do contrato);
   - `bootstrap_tenant_name`, `bootstrap_admin_email`: a razão social e o e-mail do administrador;
     `bootstrap_support_email`: o e-mail da conta de suporte que o contrato prevê (a senha dela fica no cofre do
     cliente, e só sai de lá se o cliente quiser dar acesso de suporte);
   - `control_plane_sa`: uma conta de serviço `cp-worker` **do projeto do cliente**, criada por ele sem nenhum papel
     (o módulo dá a ela, só nos cofres deste nó, a leitura da senha temporária e a gravação do token do túnel). Nunca
     a conta da Verax;
   - `images_repository`: o padrão (`ghcr.io/williandotdev/verax-control`, público, sem login);
   - o resto como no `terraform.tfvars.example` (a faixa da rede `subnet_cidr`, o remetente `mail_from` e, se quiser
     e-mail no nó, o SMTP do próprio cliente).
3. **Agentes do Wazuh nas instâncias ainda não têm suporte na infraestrutura do cliente:** o `envs/tenant` não liga
   a entrada deles (o `wazuh_agents` e as faixas de origem do módulo), e o console recusa um contrato no cliente com
   agentes. O nó do cliente coleta pelas contas de nuvem conectadas no painel (AWS, GCP e Cloudflare), sem agentes.

## 3. Túnel, painel e primeiro acesso

1. **A API:** um túnel do Cloudflare na conta do cliente, com o nome de `api_origin` apontando para `http://api:3000`.
   Grave o token em até 60 minutos depois do `apply` (a instalação espera por ele):
   `printf '%s' "$TOKEN" | gcloud secrets versions add vx-<slug>-cloudflare-tunnel-token --data-file=-`.
2. **O painel:** o build de um destino só, a partir do clone da versão, `VITE_API_URL=<api_origin> pnpm --filter
@verax/web build` (como o workflow `Painel` faz), servido em `web_origin` com os cabeçalhos de segurança de
   `firebaseHostingConfig` (`apps/web/src/hosting.ts`: CSP com a API, HSTS, anti-iframe). No Firebase Hosting do
   próprio cliente, é o `firebase.json` que essa função gera; em outro servidor estático, os mesmos cabeçalhos.
3. **Pronto:** espere `verax/ready` nos atributos de convidado da VM (até cerca de 40 minutos; o diagnóstico sem SSH
   está no GUIA, "Aceite da instalação sem operador", passo 4).
4. **Primeiro acesso:** a senha temporária do administrador está no cofre do cliente. Leia uma vez e destrua a versão:
   `gcloud secrets versions access latest --secret vx-<slug>-admin-bootstrap` e depois
   `gcloud secrets versions destroy <versão> --secret vx-<slug>-admin-bootstrap`. No primeiro login, o painel pede uma
   senha nova e o MFA. A Verax nunca vê essa senha.

## 4. Atualizar

Uma versão nova não se instala sozinha num nó que já existe. A Verax avisa a versão nova; o cliente confere o manifesto
dela como no passo 1 (com as chaves da versão instalada), faz um backup (`backup.sh`, que o nó já roda todo dia) e roda
na VM o `install.sh` do pacote novo conferido, com o commit e os digests do manifesto
(`--version`, `--api-digest`, `--migrate-digest`, `--release`). O atualizador automático com volta (SH-06) está
desenhado, não feito.

## 5. Desinstalar (fim do contrato)

No fim do contrato, a Verax só registra o fim e apaga o cadastro dela (o e-mail do administrador, em D+30, com o
registro de exclusão por e-mail ao administrador). **O ambiente é do cliente, e quem apaga é ele**: o disco, os
snapshots, o bucket de backups e os cofres ficam até ele apagar. Antes, exporte o que quiser guardar (os backups do
banco estão no bucket `<projeto>-vx-<slug>-backups`). Depois, a mesma sequência do GUIA ("Aceite da instalação sem
operador", passo 7): `deletion_protection = false` e `apply`, `state rm` do disco e do IP do NAT, o bucket esvaziado,
`terraform destroy` e o disco e o IP apagados à mão; por fim, o túnel no Cloudflare e o site do painel.
