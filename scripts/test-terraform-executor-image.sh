#!/usr/bin/env bash
# Testa a imagem do executor Terraform (CP-07) como o Job `cp-terraform` a roda: raiz só leitura, sem capabilities,
# sem ganho de privilégio, usuário sem privilégio e, aqui, SEM REDE NENHUMA. Confere:
# - o Terraform é o 1.17.1 e roda como o usuário `executor` (uid 10001), sem conseguir escrever na raiz;
# - o provider vem do espelho da imagem: sem rede, o `init` do envs/tenant passa com o lock só leitura, e os testes do
#   envs/tenant (provider simulado) rodam dentro da imagem, com o módulo do nó e os arquivos de infra/node que ele lê;
# - a imagem não leva os testes, nem estado, plano, variável ou chave privada;
# - o entrypoint recusa sem as variáveis, com argumento ou com uma variável que mudaria o Terraform (TF_LOG), sempre com
#   o código 2 e sem chamar o Terraform.
# Uso: scripts/test-terraform-executor-image.sh [imagem]   (padrão: verax-terraform-executor:teste). Precisa de Docker.
set -euo pipefail

image=${1:-verax-terraform-executor:teste}
root=$(cd "$(dirname "$0")/.." && pwd)
tenant=/opt/verax/infra/gcp/envs/tenant

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

# O /tmp aceita execução: o `init` abre o provider espelhado ali (TF_DATA_DIR), como no Cloud Run.
hardened=(--rm --network none --read-only --tmpfs '/tmp:rw,exec,nosuid,size=512m' --cap-drop ALL
  --security-opt no-new-privileges:true)

sh_in() { # <comando sh>
  docker run "${hardened[@]}" --entrypoint /bin/sh "$image" -c "$1"
}

expect 'Terraform 1.17.1' 'Terraform v1\.17\.1' "$(sh_in 'terraform version | head -n 1')"
expect 'roda como o usuário executor (10001)' '10001' "$(sh_in 'id -u')"
expect 'a raiz não aceita escrita' 'recusado' "$(sh_in 'touch /opt/verax/x 2>/dev/null && echo escreveu || echo recusado')"
expect 'bash, curl e jq presentes' 'ok' "$(sh_in 'command -v bash >/dev/null && command -v curl >/dev/null && command -v jq >/dev/null && echo ok')"
expect 'sem testes, estado, plano, variáveis nem chave privada na imagem' '' \
  "$(sh_in 'find /opt/verax \( -name tests -o -name "*.tfstate*" -o -name "*.tfplan" -o -name "*.tfvars" -o -name "*.key" -o -name ".terraform" \) -print; find /opt/verax -name "*.pem" ! -path "/opt/verax/infra/node/keys/release-*.pem" -print')"
expect 'o que o módulo lê de infra/node está na imagem' 'ok' \
  "$(sh_in 'test -s /opt/verax/infra/node/bin/boot-install.sh && test -s /opt/verax/infra/node/bin/verify-release.sh && ls /opt/verax/infra/node/keys/release-*.pem >/dev/null && echo ok')"

# Sem rede: o init só passa com o provider do espelho, e os testes do tenant rodam com o módulo da imagem. Os testes e o
# `control_plane.tf` do envs/nodes-platform (um teste do tenant confere o contrato com ele) entram só aqui, só leitura.
offline=$(docker run "${hardened[@]}" --entrypoint /bin/sh \
  -v "$root/infra/gcp/envs/tenant/tests:$tenant/tests:ro" \
  -v "$root/infra/gcp/envs/nodes-platform/control_plane.tf:/opt/verax/infra/gcp/envs/nodes-platform/control_plane.tf:ro" \
  -e TF_CLI_CONFIG_FILE=/opt/verax/terraform.rc -e TF_DATA_DIR=/tmp/terraform-data -e HOME=/tmp \
  -e TF_IN_AUTOMATION=1 -e CHECKPOINT_DISABLE=1 "$image" -c \
  "terraform -chdir=$tenant init -backend=false -lockfile=readonly -input=false -no-color >/tmp/init.log 2>&1 || { cat /tmp/init.log; exit 1; }
   terraform -chdir=$tenant test -no-color 2>&1 | tail -n 1" 2>&1 || true)
expect 'sem rede: init pelo espelho e os testes do envs/tenant dentro da imagem' 'Success! [0-9]+ passed, 0 failed\.' "$offline"

# O entrypoint recusa antes de qualquer Terraform (código 2).
code=0
docker run "${hardened[@]}" "$image" >/dev/null 2>&1 || code=$?
expect 'sem variáveis: recusado com 2' '2' "$code"
code=0
docker run "${hardened[@]}" "$image" --qualquer >/dev/null 2>&1 || code=$?
expect 'com argumento: recusado com 2' '2' "$code"
code=0
out=$(docker run "${hardened[@]}" -e TF_LOG=TRACE "$image" 2>&1) || code=$?
expect 'com TF_LOG no ambiente: recusado com 2' '2' "$code"
expect 'com TF_LOG no ambiente: a saída cita a variável' '.*TF_LOG.*' "$(tr '\n' ' ' <<<"$out")"

if ((failures > 0)); then
  printf '%d verificação(ões) falharam\n' "$failures"
  exit 1
fi
echo 'imagem do executor Terraform conferida'
