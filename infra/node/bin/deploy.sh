#!/bin/bash
# Instala ou atualiza o nó a partir do computador de quem opera (gcloud e gh logados), na raiz do repositório:
#   infra/node/bin/deploy.sh <commit> <node.conf> [vm] [zona]
#
# 1. Pega no registro o digest das imagens da API e das migrations publicadas para o commit.
# 2. Confere a atestação de origem de cada digest com `gh attestation verify`: a assinatura (Sigstore) e a identidade
#    de quem assinou, que precisa ser o workflow `Imagens do nó` deste repositório, na `main`, nesse mesmo commit, num
#    executor do GitHub. Uma imagem gravada no registro por outro caminho não passa.
# 3. Copia o pacote para a VM (pelo IAP, sem porta aberta) e instala pelo digest conferido: a VM nunca confia em tag.
#
# A conexão é um túnel do IAP até a porta 22 com o OpenSSH desta máquina, com uma chave criada só para esta execução
# (registrada no OS Login por 1 hora e removida no fim). Não usa o `gcloud compute ssh`: no Windows ele abre o PuTTY
# numa janela, e a execução fica parada esperando. A chave do servidor fica em ~/.ssh/known_hosts_<vm>: a primeira
# conexão a registra, e as seguintes a conferem.
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
project=$(sed -n 's/^VERAX_GCP_PROJECT=//p' "$config" | tr -d '\r')
[[ $project =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo 'VERAX_GCP_PROJECT inválido no node.conf.' >&2; exit 2; }
# Perfil do nó: no standard, o pacote leva também o Wazuh (a configuração e os scripts de infra/wazuh, que o install.sh
# instala em /opt/verax/wazuh). O install.sh confere o valor.
profile=$(sed -n 's/^NODE_PROFILE=//p' "$config" | tr -d '\r')

# O gh lê o manifesto da imagem no registro com as credenciais do Docker desta máquina. No Windows, o ajudante de
# credenciais do Docker Desktop fica fora do PATH do Git Bash.
docker_desktop_bin='/c/Program Files/Docker/Docker/resources/bin'
if [[ -d $docker_desktop_bin ]]; then PATH="$PATH:$docker_desktop_bin"; fi
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

echo "== Conectando a $vm pelo IAP"
work=$(mktemp -d)
tunnel_pid=''
cleanup() {
  if [[ -n $tunnel_pid ]]; then kill "$tunnel_pid" 2>/dev/null || true; fi
  if [[ -f $work/key.pub ]]; then
    gcloud compute os-login ssh-keys remove --key-file "$work/key.pub" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -C "verax-deploy-$commit" -f "$work/key"
gcloud compute os-login ssh-keys add --key-file "$work/key.pub" --ttl 1h >/dev/null
user=$(gcloud compute os-login describe-profile --format='value(posixAccounts[0].username)')
[[ -n $user ]] || { echo 'Sem usuário do OS Login para esta conta.' >&2; exit 1; }

PYTHONUNBUFFERED=1 gcloud compute start-iap-tunnel "$vm" 22 --local-host-port=localhost:0 --zone "$zone" --project "$project" \
  >"$work/tunnel.log" 2>&1 &
tunnel_pid=$!
port=''
for _ in $(seq 60); do
  port=$(sed -n 's/.*Listening on port \[\([0-9]*\)\].*/\1/p' "$work/tunnel.log")
  [[ -n $port ]] && break
  kill -0 "$tunnel_pid" 2>/dev/null || { cat "$work/tunnel.log" >&2; exit 1; }
  sleep 1
done
[[ -n $port ]] || { echo 'O túnel do IAP não abriu em 60 s.' >&2; cat "$work/tunnel.log" >&2; exit 1; }

ssh_opts=(-i "$work/key" -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=30
  -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$HOME/.ssh/known_hosts_$vm" -o HostKeyAlias="$vm")
on_vm() { ssh "${ssh_opts[@]}" -p "$port" "$user@localhost" "$@"; }
to_vm() { scp "${ssh_opts[@]}" -P "$port" -q "$@"; }

echo "== Copiando o pacote para $vm"
on_vm 'rm -rf ~/verax-node'
to_vm -r infra/node "$user@localhost:verax-node"
if [[ $profile == standard ]]; then
  on_vm 'mkdir -p verax-node/wazuh/config'
  to_vm -r infra/wazuh/scripts "$user@localhost:verax-node/wazuh/"
  to_vm -r infra/wazuh/config/indexer infra/wazuh/config/manager "$user@localhost:verax-node/wazuh/config/"
fi
to_vm "$config" "$user@localhost:verax-node/node.conf"

echo "== Instalando"
on_vm "sudo bash verax-node/bin/install.sh --version $commit --api-digest $api_digest --migrate-digest $migrate_digest --config verax-node/node.conf"
