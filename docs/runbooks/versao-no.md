# Versão do nó: imagens públicas e manifesto assinado

Preparação do modo próprio (o nó na nuvem do cliente, fase 3, SH-02). Um nó fora da GCP da Verax precisa de duas
coisas que o nó da Verax não precisa: baixar as imagens **sem login em registro nenhum** e saber, **sem o `gh` e sem
acesso à Verax**, que a versão que vai instalar foi publicada pela Verax. Este roteiro cobre as duas peças e o que o
responsável faz uma vez só.

**O nó da Verax não muda.** Ele continua com o `deploy.sh`: imagens do Artifact Registry, pelo digest conferido com
`gh attestation verify` (`docs/runbooks/no-verax.md`). Tudo aqui é acréscimo.

## Como funciona

1. **Imagens no GHCR, com o mesmo digest.** O workflow `Imagens do nó` publica a API e as migrations no Artifact
   Registry, como antes, e depois um segundo job (`ghcr`, o único com `packages: write`) copia as duas para
   `ghcr.io/williandotdev/verax-control/api` e `/migrate`, com a tag do commit:
   - a cópia é pelo digest, com `docker buildx imagetools create --prefer-index=false`, que copia o manifesto byte a
     byte (o padrão, `--prefer-index=true`, embrulharia uma imagem de plataforma única num índice novo, com outro
     digest). O job lê o digest no GHCR e para se for diferente do Artifact Registry;
   - a atestação de origem vale para o digest, onde quer que a imagem esteja. A cópia ganha mais uma atestação, com o
     nome do GHCR, guardada também no próprio registro: dá para conferir com `--bundle-from-oci`, sem a API do GitHub;
   - se o job do GHCR falhar, o Artifact Registry e o nó da Verax não são afetados.
2. **Imagens de terceiros pela origem.** Wazuh (GPLv2), PostgreSQL e cloudflared **não** são copiados pela Verax: o
   nó os baixa do registro de origem (Docker Hub), pelo digest já fixado em `infra/node/compose*.yaml`. Assim a Verax
   não redistribui imagem de terceiro. Sem login, o Docker Hub aceita 100 pulls a cada 6 horas por IP; uma instalação
   baixa 4 imagens de terceiros.
3. **Manifesto assinado por versão.** O workflow `Versão do nó` (disparo manual, environment `release` com aprovação)
   promove um commit da `main` a uma versão `node-vX.Y.Z`:
   - confere que as duas imagens do commit descem do GHCR sem login e que cada digest tem a atestação do workflow
     `Imagens do nó`, na `main`, nesse commit, num executor do GitHub (as opções do `deploy.sh`);
   - monta o pacote do nó do commit (`scripts/node-release.sh package`): `infra/node` sem os testes, mais a
     configuração e os scripts do Wazuh, igual byte a byte em qualquer máquina (dá para refazer e comparar);
   - escreve o `manifest.json` e só então pede o token da GCP e assina no Cloud KMS. A assinatura só vale se fechar
     com as chaves do próprio pacote e com as da `main`;
   - cria a tag no commit e o release com `verax-node.tar.gz`, `manifest.json` e `manifest.json.sig`.
4. **O nó confere no host.** `infra/node/bin/verify-release.sh manifest.json manifest.json.sig` usa só o `openssl`,
   com as chaves públicas do pacote **já instalado** (`keys/release-*.pem`). Nunca com as do pacote novo: quem
   trocasse o pacote trocaria a chave junto.

### O manifesto (`schema: 1`)

| Campo              | Conteúdo                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `kind`             | Sempre `verax-node-release`                                                                               |
| `version`          | O commit (40 hexadecimais), o mesmo `--version` do `install.sh`                                           |
| `release`          | A tag, `node-vX.Y.Z`                                                                                      |
| `releasedAt`       | Hora da promoção (UTC)                                                                                    |
| `package`          | `url` do `verax-node.tar.gz` no release e o `sha256` dele                                                 |
| `images`           | `api` e `migrate`, no GHCR, pelo digest                                                                   |
| `thirdPartyImages` | As imagens de terceiros exatamente como os compose do pacote as fixam (nome, tag e digest), sem repetição |
| `notes`            | O endereço do release                                                                                     |

A assinatura é ECDSA P-256 com SHA-256 sobre os bytes exatos do arquivo, no formato DER que o Cloud KMS devolve. Os
campos do atualizador (`minUpgradeFrom`, `migrations`, `channel`) e o hash do painel entram com o SH-06 e o CP-09;
enquanto não existirem, um manifesto sem `migrations` não permite volta automática.

## Uma vez só (responsável)

### 1. Tornar públicos os pacotes do GHCR

O primeiro `Imagens do nó` depois do merge (um merge que mexa na API, ou Actions → Imagens do nó → Run workflow)
cria dois pacotes **privados** na sua conta: `verax-control/api` e `verax-control/migrate`. O GitHub não tem API para
mudar a visibilidade de um pacote; é pelo site, uma vez em cada um:

1. github.com → seu perfil → **Packages** → `verax-control/api`;
2. **Package settings** (à direita) → no fim, em **Danger Zone**, **Change visibility** → **Public**;
3. digite o nome do pacote e confirme (**I understand the consequences, change package visibility**);
4. repita com `verax-control/migrate`.

> **Não tem volta:** um pacote público não pode voltar a ser privado (documentação do GitHub). O código já é público,
> e a imagem não leva segredo (o CI passa o Trivy na imagem a cada PR), então a exposição a mais é quase nenhuma.

Na mesma página, em **Manage Actions access**, o repositório `verax-control` deve aparecer com acesso de escrita (o
GitHub concede sozinho ao pacote criado pelo workflow do repositório). Se o job `ghcr` falhar com `denied`, adicione o
repositório ali com **Add Repository** e rode o workflow de novo.

Conferir o pull anônimo, numa máquina sem login no GHCR:

```bash
docker logout ghcr.io
docker pull ghcr.io/williandotdev/verax-control/api:COMMIT
```

### 2. A chave de release (`infra/gcp/envs/release`)

Um ambiente próprio do Terraform, com estado próprio (prefixo `release` no bucket do estado): o chaveiro
`verax-release`, a chave `node-manifest` (ECDSA P-256, em software, protegida contra exclusão), a conta
`verax-release-signer`, que só assina (`roles/cloudkms.signer` na chave, nada no projeto), e uma federação de
identidade que só aceita o token do workflow `Versão do nó`, na `main`, por disparo manual, do environment `release`,
num executor do GitHub. **Use o projeto do nó da Verax** (o de `envs/verax`), nunca o do plano de controle, onde vai
ficar a chave das licenças: quem comprometer o plano de controle não assina uma versão do nó.

Com uma conta dona do projeto (ou com os papéis de administrar o Cloud KMS, contas de serviço, federação de identidade
e APIs):

```bash
cd infra/gcp/envs/release
cp terraform.tfvars.example terraform.tfvars   # project_id = o projeto do nó da Verax
terraform init -backend-config="bucket=BUCKET_DO_ESTADO"
terraform plan    # Plan: 12 to add, 0 to change, 0 to destroy.
terraform apply
terraform output -json github_environment
terraform output -raw release_public_key_file   # infra/node/keys/release-node-manifest-v1.pem
terraform output -raw release_public_key_pem
```

O `plan` só cria: as 5 APIs (se já estiverem ligadas, nada muda no projeto), o chaveiro, a chave, a conta, a
concessão na chave, o pool, o provedor e a concessão na conta. O chaveiro do Cloud KMS nunca se apaga (é assim no
serviço), e a chave tem `prevent_destroy`.

### 3. A pública no repositório

Grave a saída `release_public_key_pem` no arquivo de `release_public_key_file` e abra um PR só com ele:

```bash
terraform output -raw release_public_key_pem > ../../../node/keys/release-node-manifest-v1.pem
openssl pkey -pubin -in ../../../node/keys/release-node-manifest-v1.pem -noout -text | grep 'ASN1 OID: prime256v1'
```

É a pública: nada secreto. Só um commit da `main` que já tenha esse arquivo pode virar versão (o workflow para se a
assinatura não fechar com as chaves do pacote).

### 4. O environment `release` no GitHub

Settings → Environments → **New environment** → `release`:

- **Required reviewers:** você. Desmarque **Prevent self-review**, senão ninguém aprova o próprio disparo;
- **Deployment branches and tags:** **Selected branches and tags** → `main`;
- **Environment variables:** as três da saída `github_environment` (`GCP_RELEASE_WIF_PROVIDER`, `GCP_RELEASE_SA` e
  `RELEASE_KMS_KEY_VERSION`). Nenhum segredo.

Sem as três variáveis, o workflow para no primeiro passo e diz qual falta.

## Promover uma versão

1. Escolha o commit da `main`. O resumo do `Imagens do nó` daquele commit mostra os digests no Artifact Registry e no
   GHCR (os mesmos).
2. Actions → **Versão do nó** → **Run workflow**, na `main`: `commit` (40 hexadecimais) e `version` (`X.Y.Z`).
3. Aprove o job `assinar` quando o GitHub pedir.
4. No fim, o release `node-vX.Y.Z` tem o pacote, o manifesto e a assinatura, e as notas listam os digests e como
   conferir.

| Erro no job                                      | O que fazer                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `... não desce sem login` ou `Sem token anônimo` | O pacote ainda é privado (passo 1) ou o `Imagens do nó` não publicou esse commit no GHCR (rode o workflow, que publica o commit da `main`). |
| `sem atestação válida do workflow Imagens do nó` | A imagem no GHCR não veio do `Imagens do nó` na `main` nesse commit. Não promova; investigue quem gravou a tag.                             |
| `não fecha com as chaves do pacote`              | O commit não tem a pública da chave em uso (passo 3) ou `RELEASE_KMS_KEY_VERSION` aponta para outra versão.                                 |
| `o Cloud KMS assinou com outra versão da chave`  | `RELEASE_KMS_KEY_VERSION` diferente da versão que respondeu. Confira a saída `github_environment`.                                          |
| `A tag node-vX.Y.Z já existe`                    | Versões não se reaproveitam: escolha outro número.                                                                                          |
| Falha só no job `publicar` (rede, API do GitHub) | **Re-run failed jobs**: ele aceita a tag que ele mesmo criou no mesmo commit.                                                               |

## Conferir uma versão à mão (auditoria, também para o cliente)

Num clone do repositório, num commit em que você confia (as chaves são as de lá, nunca as do pacote baixado):

```bash
gh release download node-vX.Y.Z --repo williandotdev/verax-control --dir /tmp/versao
bash infra/node/bin/verify-release.sh /tmp/versao/manifest.json /tmp/versao/manifest.json.sig infra/node/keys
sha256sum /tmp/versao/verax-node.tar.gz && jq -r .package.sha256 /tmp/versao/manifest.json   # iguais
# O pacote se refaz do commit, byte a byte:
bash scripts/node-release.sh package "$(jq -r .version /tmp/versao/manifest.json)" /tmp/refeito.tar.gz
sha256sum /tmp/refeito.tar.gz
# A origem das imagens (com --bundle-from-oci, sem a API do GitHub):
gh attestation verify "oci://$(jq -r .images.api /tmp/versao/manifest.json)" --repo williandotdev/verax-control \
  --signer-workflow williandotdev/verax-control/.github/workflows/imagens.yml --source-ref refs/heads/main \
  --source-digest "$(jq -r .version /tmp/versao/manifest.json)" --deny-self-hosted-runners
```

## Como o nó na nuvem do cliente vai usar (SH-05 e SH-06, a fazer)

- **Instalação (SH-05):** o instalador clona a tag, confere o manifesto com as chaves dessa tag e o SHA-256 do pacote,
  e o `node.conf` leva `IMAGES_REPOSITORY=ghcr.io/williandotdev/verax-control`: o `install.sh` já monta
  `$IMAGES_REPOSITORY/api@<digest>`. Falta ele pular o `gcloud auth configure-docker` quando o registro é o
  `ghcr.io` (ajuste do PR-N7, proposta do modo próprio, seção 5.2).
- **Atualização (SH-06):** o par manifesto e assinatura chega pela renovação da licença. O host instala o verificador
  e as chaves do pacote em `/opt/verax`, confere a assinatura com eles, recusa uma `version` mais antiga que a
  instalada (sem pedido explícito de voltar), baixa o pacote e confere o SHA-256, puxa as imagens pelo digest (Verax
  no GHCR, terceiros na origem, tudo sem login) e roda o `install.sh` com os digests do manifesto.
- **Gerenciado:** o nó da Verax e os nós de clientes na GCP da Verax continuam no Artifact Registry e no `deploy.sh`.
  O manifesto também serve a eles (o mesmo digest), quando o CP-09 passar a guardá-lo no bucket de releases.

## Troca e revogação da chave

O Cloud KMS não faz rotação automática de chave assimétrica. A troca é planejada:

1. Crie a versão nova e grave a pública no repositório (PR):

   ```bash
   gcloud kms keys versions create --key node-manifest --keyring verax-release --location us-east1 --project PROJETO
   gcloud kms keys versions get-public-key 2 --key node-manifest --keyring verax-release --location us-east1 \
     --project PROJETO --output-file infra/node/keys/release-node-manifest-v2.pem
   ```

2. Publique pelo menos uma versão, ainda assinada com a v1, cujo pacote leve as duas públicas. Os nós passam a
   confiar nas duas.
3. `release_key_version = 2` no `terraform.tfvars`, `terraform apply` e a variável `RELEASE_KMS_KEY_VERSION` nova no
   environment.
4. Numa versão seguinte, tire `release-node-manifest-v1.pem` do repositório e desative a v1
   (`gcloud kms keys versions disable 1 ...`).

**Chave comprometida:** desative a versão na hora (`gcloud kms keys versions disable`). Os nós só aceitam as chaves
que já têm: se não houver outra pública fixada no pacote instalado, eles não aceitam mais nenhuma versão até uma
reinstalação ou uma troca de pacote assistida. Por isso a recomendação (ainda não feita) é fixar desde já uma segunda
versão da chave, criada e logo desativada, como reserva.
