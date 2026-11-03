#!/bin/bash
# Instala ou atualiza o nó a partir do computador de quem opera (gcloud e gh logados), na raiz do repositório:
#   infra/node/bin/deploy.sh <commit> <node.conf> [vm] [zona]
#
# 1. Pega no registro o digest das imagens da API e das migrations publicadas para o commit.
# 2. Confere a atestação de origem de cada digest com `gh attestation verify`: a assinatura (Sigstore) e a identidade
#    de quem assinou, que precisa ser o workflow `Imagens do nó` deste repositório, na `main`, nesse mesmo commit, num
#    executor do GitHub. Uma imagem gravada no registro por outro caminho não passa.
# 3. Copia o pacote para a VM (pelo IAP, sem porta aberta) e instala pelo digest conferido: a VM nunca confia em tag.
set -euo pipefail

commit=${1:-}
config=${2:-}
vm=${3:-verax-node}
zone=${4:-us-east1-b}
repo=williandotdev/verax-control
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo 'Uso: deploy.sh <commit (40 hexadecimais)> <node.conf> [vm] [zona]' >&2; exit 2; }
[[ -f $config ]] || { echo "Configuração não encontrada: $config" >&2; exit 2; }
# O node.conf pode ter sido salvo no Windows (CRLF).
images=$(sed -n 's/^IMAGES_REPOSITORY=//p' "$config" | tr -d '\r')
[[ $images =~ ^[a-z0-9-]+-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9-]+$ ]] || { echo 'IMAGES_REPOSITORY inválido no node.conf.' >&2; exit 2; }

# O gh lê o manifesto da imagem no registro com as credenciais do Docker desta máquina.
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://${images%%/*}" >/dev/null

verified_digest() { # <imagem>
  local digest
  digest=$(gcloud artifacts docker images describe "$images/$1:$commit" --format='value(image_summary.digest)')
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Imagem $1 da versão $commit não encontrada." >&2; return 1; }
  gh attestation verify "oci://$images/$1@$digest" \
    --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/imagens.yml" \
    --source-ref refs/heads/main \
    --source-digest "$commit" \
    --predicate-type https://slsa.dev/provenance/v1 \
    --deny-self-hosted-runners >&2 ||
    { echo "Imagem $1 ($digest) sem atestação válida do workflow Imagens do nó na main para $commit." >&2; return 1; }
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
# Destino relativo à pasta pessoal: no Windows, o gcloud copia pelo pscp (SFTP), que não expande `~`.
gcloud compute scp --recurse infra/node "$vm:verax-node" --zone "$zone" --tunnel-through-iap
gcloud compute scp "$config" "$vm:verax-node/node.conf" --zone "$zone" --tunnel-through-iap

echo "== Instalando"
on_vm "sudo bash verax-node/bin/install.sh --version $commit --api-digest $api_digest --migrate-digest $migrate_digest --config verax-node/node.conf"
