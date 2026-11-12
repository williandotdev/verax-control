# Imagem do executor Terraform do plano de controle (fase 3, CP-07): o Job `cp-terraform` do Cloud Run, que aplica o
# `infra/gcp/envs/tenant` de um cliente por execução (entrypoint.sh). Contexto: a raiz do repositório, com a lista de
# permissão de `Dockerfile.dockerignore` (só o ambiente do tenant, o módulo do nó, as partes de `infra/node` que o
# módulo lê no `plan` e os arquivos desta pasta).
#
# - Base: a imagem oficial `hashicorp/terraform:1.17.1` pelo digest do índice (conferido em 05/11/2026 no Docker Hub
#   com `docker buildx imagetools inspect`; o binário da imagem linux/amd64 tem o mesmo SHA-256 do binário do zip
#   oficial `terraform_1.17.1_linux_amd64.zip` de releases.hashicorp.com, cujo SHA-256 está no SHA256SUMS da HashiCorp
#   e fixado no `iac.yml`). O mesmo Terraform do CI.
# - Providers: o `google` do `.terraform.lock.hcl` do envs/tenant, espelhado no build (`terraform providers mirror`
#   confere os hashes do lock) e servido só pelo espelho (terraform.rc): nada é baixado em execução. Um PR do
#   Dependabot que suba o lock sobe o espelho junto, no build seguinte.
# - O `bash`, o `curl` e o `jq` do próprio Alpine da imagem base (o ramo dela, só correções; o Trivy do CI confere):
#   o entrypoint confere as variáveis com o `bash`, lê o plano em JSON com o `jq` e grava o resultado no bucket com o
#   `curl`. Saem o `git` e o `openssh` da imagem base (o envs/tenant só usa módulo local), e o resto recebe as
#   correções do mesmo ramo (`apk upgrade`). Nada mais é instalado.
# - Roda como usuário sem privilégio, com a raiz só leitura no teste do CI (o Terraform escreve só em /tmp).

ARG TERRAFORM_IMAGE=hashicorp/terraform:1.17.1@sha256:a5d5a5a892c98f60fcbfa81eac2a40fc19e7b3fa7719bccae10ff6111d22524a

FROM ${TERRAFORM_IMAGE} AS providers
WORKDIR /src
COPY infra/gcp/envs/tenant/ envs/tenant/
COPY infra/gcp/modules/node/ modules/node/
# O `init` (sem backend) baixa o provider e confere os hashes do lock; o `mirror` copia o mesmo para o espelho.
RUN terraform -chdir=envs/tenant init -backend=false -lockfile=readonly -input=false -no-color >/dev/null \
  && terraform -chdir=envs/tenant providers mirror -platform=linux_amd64 /providers

FROM ${TERRAFORM_IMAGE}
RUN apk del --no-cache git openssh \
  && apk upgrade --no-cache \
  && apk add --no-cache bash curl jq \
  && adduser -D -H -u 10001 -s /sbin/nologin executor
COPY --from=providers /providers /opt/verax/providers
COPY infra/gcp/envs/tenant/ /opt/verax/infra/gcp/envs/tenant/
# O cliente da célula (CE-07): o mesmo provider, com o mesmo lock (um teste da imagem confere o init pelo espelho).
COPY infra/gcp/envs/cell-tenant/ /opt/verax/infra/gcp/envs/cell-tenant/
COPY infra/gcp/modules/node/ /opt/verax/infra/gcp/modules/node/
COPY infra/node/bin/boot-install.sh infra/node/bin/verify-release.sh /opt/verax/infra/node/bin/
COPY infra/node/keys/ /opt/verax/infra/node/keys/
COPY infra/control-plane/terraform/terraform.rc /opt/verax/terraform.rc
COPY --chmod=0555 infra/control-plane/terraform/entrypoint.sh /opt/verax/entrypoint.sh
USER executor
WORKDIR /tmp
ENTRYPOINT ["/opt/verax/entrypoint.sh"]
