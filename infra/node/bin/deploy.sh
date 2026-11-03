#!/bin/bash
# Instala ou atualiza o nó a partir do computador de quem opera (gcloud e gh logados), na raiz do repositório:
#   infra/node/bin/deploy.sh <commit> <node.conf> [vm] [zona]
#
# 1. Pega no registro o digest das imagens da API e das migrations publicadas para o commit.
# 2. Confere, na API do GitHub, a atestação de origem de cada digest: precisa ter sido gerada pelo workflow
#    `Imagens do nó` deste repositório, na `main`, a partir desse mesmo commit. Uma imagem gravada no registro por
#    outro caminho (outra identidade com escrita no projeto, por exemplo) não tem essa atestação e para aqui.
# 3. Copia o pacote para a VM (pelo IAP, sem porta aberta) e instala pelo digest conferido: a VM nunca confia em tag.
set -euo pipefail

commit=${1:-}
config=${2:-}
vm=${3:-verax-node}
zone=${4:-us-east1-b}
repo=williandotdev/verax-control
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo 'Uso: deploy.sh <commit (40 hexadecimais)> <node.conf> [vm] [zona]' >&2; exit 2; }
[[ -f $config ]] || { echo "Configuração não encontrada: $config" >&2; exit 2; }
images=$(sed -n 's/^IMAGES_REPOSITORY=//p' "$config")
[[ $images =~ ^[a-z0-9-]+-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9-]+$ ]] || { echo 'IMAGES_REPOSITORY inválido no node.conf.' >&2; exit 2; }

verified_digest() { # <imagem>
  local digest
  digest=$(gcloud artifacts docker images describe "$images/$1:$commit" --format='value(image_summary.digest)')
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Imagem $1 da versão $commit não encontrada." >&2; return 1; }
  # Atestações do repositório para o digest; vale a que diz: este repositório, o workflow das imagens, a main e o
  # commit pedido. O GitHub só deixa gravar atestação neste repositório um job dele, com a identidade do job.
  local matches
  matches=$(gh api "repos/$repo/attestations/$digest" --jq "
    [.attestations[].bundle.dsseEnvelope.payload | @base64d | fromjson
      | select(.subject | any(.digest.sha256 == \"${digest#sha256:}\"))
      | .predicate.buildDefinition
      | select(.externalParameters.workflow.repository == \"https://github.com/$repo\"
          and .externalParameters.workflow.path == \".github/workflows/imagens.yml\"
          and .externalParameters.workflow.ref == \"refs/heads/main\"
          and (.resolvedDependencies | any(.digest.gitCommit == \"$commit\")))]
    | length")
  [[ $matches -ge 1 ]] || { echo "Imagem $1 ($digest) sem atestação do workflow Imagens do nó na main para $commit." >&2; return 1; }
  printf '%s' "$digest"
}

echo "== Conferindo as imagens da versão $commit"
api_digest=$(verified_digest api)
migrate_digest=$(verified_digest migrate)
echo "API: $api_digest"
echo "Migrations: $migrate_digest"

on_vm() { gcloud compute ssh "$vm" --zone "$zone" --tunnel-through-iap -- "$@"; }
echo "== Copiando o pacote para $vm"
on_vm 'rm -rf ~/verax-node'
gcloud compute scp --recurse infra/node "$vm:~/verax-node" --zone "$zone" --tunnel-through-iap
gcloud compute scp "$config" "$vm:~/verax-node/node.conf" --zone "$zone" --tunnel-through-iap

echo "== Instalando"
on_vm "sudo bash verax-node/bin/install.sh --version $commit --api-digest $api_digest --migrate-digest $migrate_digest --config verax-node/node.conf"
