#!/bin/bash
# Testes do entrypoint do executor Terraform (CP-07), sem nuvem e sem Terraform de verdade: o Terraform falso
# (fake-terraform.sh) responde com o plano em JSON de cada cenário, e o servidor falso (fake-gcp.py) faz o papel do
# servidor de metadados (o token da conta do Job) e do Cloud Storage (o result.json e o outputs.json em runs/).
#
# O entrypoint de produção não é alterado: o teste roda uma cópia com só os valores de produção trocados (o binário do
# Terraform, as pastas, os dois endereços do Google e o `--proto '=https'` do envio) e confere, antes de tudo, que no
# arquivo de produção esses valores são os de produção.
#
# Uso (CI: o runner ubuntu-24.04 tem bash, curl, jq e python3): bash infra/control-plane/terraform/tests/entrypoint-test.sh
set -euo pipefail
export LC_ALL=C

here=$(cd "$(dirname "$0")" && pwd)
entrypoint=$here/../entrypoint.sh
fails=0
passes=0

ok() {
  passes=$((passes + 1))
  printf 'ok   %s\n' "$1"
}
fail() {
  fails=$((fails + 1))
  printf 'FALHA %s\n' "$1"
}
check() { # <descrição> <comando...>
  local description=$1
  shift
  if "$@"; then ok "$description"; else fail "$description"; fi
}

# --- Os valores de produção no arquivo de produção -------------------------------------------------------------------
production_lines=(
  'readonly terraform_bin=/bin/terraform'
  'readonly tenant_root=/opt/verax/infra/gcp/envs/tenant'
  'readonly cli_config=/opt/verax/terraform.rc'
  'readonly metadata_token_url=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
  'readonly storage_upload_url=https://storage.googleapis.com/upload/storage/v1/b'
  'readonly work_parent=/tmp'
)
for line in "${production_lines[@]}"; do
  check "produção: $line" grep -qxF "$line" "$entrypoint"
done
check 'produção: o envio ao bucket só por HTTPS' test "$(grep -c -- "--proto '=https'" "$entrypoint")" -eq 1
check 'produção: o token só pelo servidor de metadados, em HTTP local' test "$(grep -c -- "--proto '=http'" "$entrypoint")" -eq 1
check 'produção: bash -p (sem BASH_ENV nem funções do ambiente)' test "$(head -n 1 "$entrypoint")" = '#!/bin/bash -p'
check 'produção: nada de eval nem source' bash -c "! grep -nE '(^|[^[:alnum:]_])(eval|source)[[:space:]]' '$entrypoint'"

# --- Montagem ---------------------------------------------------------------------------------------------------------
root=$(mktemp -d)
state=$root/gcp
fake=$root/terraform
work_parent=$root/work
mkdir -p "$state" "$fake" "$work_parent" "$root/bin"
cleanup() {
  if [[ -n ${server_pid-} ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf -- "$root"
}
trap cleanup EXIT

# Um token falso com a cara de um de verdade, gerado aqui: não pode aparecer em saída nenhuma.
token="ya29.teste-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s' "$token" >"$state/token"
python3 -I "$here/fake-gcp.py" "$state" &
server_pid=$!
for _ in $(seq 1 50); do
  [[ -s $state/port ]] && break
  sleep 0.1
done
port=$(cat "$state/port")

install -m 0755 "$here/fake-terraform.sh" "$root/bin/terraform"
sed \
  -e "s|^readonly terraform_bin=.*|readonly terraform_bin=$root/bin/terraform|" \
  -e "s|^readonly tenant_root=.*|readonly tenant_root=$root/tenant|" \
  -e "s|^readonly cli_config=.*|readonly cli_config=$root/terraform.rc|" \
  -e "s|^readonly metadata_token_url=.*|readonly metadata_token_url=http://127.0.0.1:$port/token|" \
  -e "s|^readonly storage_upload_url=.*|readonly storage_upload_url=http://127.0.0.1:$port/upload/storage/v1/b|" \
  -e "s|^readonly work_parent=.*|readonly work_parent=$work_parent|" \
  -e "s|--proto '=https'|--proto '=http'|" \
  "$entrypoint" >"$root/entrypoint.sh"
chmod 0755 "$root/entrypoint.sh"
mkdir -p "$root/tenant"
check 'a cópia do teste troca só os valores de produção (7 linhas)' \
  test "$(diff "$entrypoint" "$root/entrypoint.sh" | grep -c '^>')" -eq 7

slug=cliente-demo-a
run_id=01JBTESTE0000000000000RVN1
execution=cp-terraform-abc12
admin='o'"'"'neil+ti@cliente-demo-a.example.com'
support=suporte@verax.example
# Um nome com o que um shell interpretaria (cifrão com parênteses e crase): tem de chegar ao Terraform como texto.
tenant_name="Ação & \"Filhos\" \$(touch /tmp/invadido) \`id\` Comércio Ltda."

# As variáveis de uma execução de provisionamento válida, como o cp-worker as manda (executor-env.ts) mais as fixas do Job.
base_env=(
  "PATH=/usr/bin:/bin"
  "HOME=/home/executor"
  "TFSTATE_BUCKET=projeto-exemplo-nos-tfstate"
  "NODES_PROJECT_ID=projeto-exemplo-nos"
  "NODES_REGION=southamerica-east1"
  "NODES_ZONE=southamerica-east1-b"
  "CP_WORKER_SA=cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
  "CLOUD_RUN_EXECUTION=$execution"
  "EXECUTOR_ACTION=apply"
  "RUN_KIND=provision"
  "RUN_ID=$run_id"
  "TENANT_SLUG=$slug"
  "PLAN=enterprise"
  "PLAN_MAX_CLOUD_ACCOUNTS=15"
  "PLAN_MAX_USERS=20"
  "PLAN_MONTHLY_GIB=60"
  "PLAN_HISTORY_DAYS=365"
  "NODE_VERSION=node-v1.2.3"
  "NODE_PACKAGE_SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  "WEB_ORIGIN=https://$slug.control.example.com"
  "API_ORIGIN=https://api-$slug.example.com"
  "MAIL_FROM=nao-responda@example.com"
  "SUBNET_CIDR=10.1.17.0/24"
  "BOOTSTRAP_ADMIN_EMAIL=$admin"
  "BOOTSTRAP_TENANT_NAME=$tenant_name"
  "BOOTSTRAP_SUPPORT_EMAIL=$support"
  "IMAGES_REPOSITORY=ghcr.io/williandotdev/verax-control"
  "FAKE_TERRAFORM_DIR=$fake"
)

# O plano do cenário: a conta de serviço do nó com estas ações (mais dois recursos comuns).
plan_with() { # <endereço da conta> <ações em JSON>
  jq -n --arg address "$1" --argjson actions "$2" '{
    format_version: "1.2",
    resource_changes: [
      {address: "module.node.google_compute_instance.node", change: {actions: ["create"]}},
      {address: $address, change: {actions: $actions}},
      {address: "google_secret_manager_secret_iam_member.worker_tunnel_token", change: {actions: ["no-op"]}}
    ]
  }' >"$fake/plan.json"
}

outputs_fixture() {
  jq -n '{
    name_prefix: {sensitive: false, type: "string", value: "vx-cliente-demo-a"},
    instance_name: {sensitive: false, type: "string", value: "vx-cliente-demo-a"},
    zone: {sensitive: false, type: "string", value: "southamerica-east1-b"},
    nat_ip: {sensitive: false, type: "string", value: "203.0.113.30"},
    service_account_email: {sensitive: false, type: "string", value: "vx-cliente-demo-a@projeto-exemplo-nos.iam.gserviceaccount.com"},
    service_account_unique_id: {sensitive: false, type: "string", value: "123456789012345678901"},
    secrets: {sensitive: false, type: ["map", "string"], value: {"cloudflare-tunnel-token": "vx-cliente-demo-a-cloudflare-tunnel-token"}},
    backups_bucket: {sensitive: false, type: "string", value: "projeto-exemplo-nos-vx-cliente-demo-a-backups"},
    uma_saida_nova: {sensitive: false, type: "string", value: "nao-deveria-sair"}
  }' >"$fake/outputs.json"
}

reset() {
  rm -rf -- "$state/uploads" "$state/requests.jsonl" "$state/fail-upload" "$fake"/calls "$fake"/env-plan "$fake"/fail-*
  printf '%s' "$token" >"$state/token"
  plan_with module.node.google_service_account.node '["create"]'
  outputs_fixture
}

status=0
output=''
run_entrypoint() { # <variáveis a mais ou trocadas...> (o último valor de cada nome vale)
  status=0
  output=$(env -i "${base_env[@]}" "$@" "$root/entrypoint.sh" 2>&1) || status=$?
}

uploaded() { # <arquivo>
  cat "$state/uploads/runs__${slug}__${run_id}__${execution}__$1" 2>/dev/null
}
result_is() { # <status> <código>
  [[ $(uploaded result.json | jq -r '"\(.status) \(.code)"') == "$1 $2" ]]
}
called() { # <subcomando>
  grep -q "^$1 " "$fake/calls" 2>/dev/null
}
no_secrets_in_output() {
  [[ $output != *"$token"* && $output != *"$admin"* && $output != *"$support"* && $output != *"Filhos"* &&
    $output != *neil* ]]
}
# A saída cita o nome da variável e não o valor (valores curtos, como "A", podem coincidir com o texto e não contam).
names_not_value() { # <saída> <nome> <valor>
  [[ $1 == *"$2"* ]] || return 1
  ((${#3} < 6)) || [[ $1 != *"$3"* ]]
}
# Numa falha do Terraform, a linha de erro aparece e o valor da variável (o e-mail do admin), não.
error_line_only() { # <saída>
  [[ $1 == *"Error: Invalid value for variable"* && $1 != *neil* ]]
}
no_work_left() {
  [[ -z $(find "$work_parent" -mindepth 1 -maxdepth 1 2>/dev/null) ]]
}

# --- 1. Provisionamento normal ----------------------------------------------------------------------------------------
reset
run_entrypoint
check 'apply: sai com 0' test "$status" -eq 0
check 'apply: init com o bucket e o prefixo do cliente, sem baixar nada (lock só leitura)' \
  grep -qxF "init -no-color -input=false -lockfile=readonly -backend-config=bucket=projeto-exemplo-nos-tfstate -backend-config=prefix=tenants/$slug" "$fake/calls"
check 'apply: plan com -out, show -json, apply do plano salvo e output -json, nessa ordem' \
  test "$(cut -d' ' -f1 "$fake/calls" | tr '\n' ' ')" = 'init plan show apply output '
check 'apply: o apply usa o plano salvo (o que foi conferido)' grep -qE '^apply -no-color -input=false -lock-timeout=5m .*/tfplan$' "$fake/calls"
check 'apply: o plan não é de destruição' bash -c "! grep -q -- '-destroy' '$fake/calls'"
expected_vars=(
  "TF_VAR_project_id=projeto-exemplo-nos" "TF_VAR_region=southamerica-east1" "TF_VAR_zone=southamerica-east1-b"
  "TF_VAR_slug=$slug" "TF_VAR_plan=enterprise" "TF_VAR_plan_max_cloud_accounts=15" "TF_VAR_plan_max_users=20"
  "TF_VAR_plan_monthly_gib=60" "TF_VAR_plan_history_days=365" "TF_VAR_node_version=node-v1.2.3"
  "TF_VAR_node_package_sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  "TF_VAR_web_origin=https://$slug.control.example.com" "TF_VAR_api_origin=https://api-$slug.example.com"
  "TF_VAR_mail_from=nao-responda@example.com" "TF_VAR_subnet_cidr=10.1.17.0/24"
  "TF_VAR_bootstrap_admin_email=$admin" "TF_VAR_bootstrap_tenant_name=$tenant_name"
  "TF_VAR_bootstrap_support_email=$support"
  "TF_VAR_control_plane_sa=cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
  "TF_VAR_images_repository=ghcr.io/williandotdev/verax-control"
)
missing=0
for var in "${expected_vars[@]}"; do grep -qxF "$var" "$fake/env-plan" || missing=1; done
check 'apply: cada variável chega ao Terraform como TF_VAR_*, byte a byte (o nome com cifrão, parênteses e crase)' \
  test "$missing" -eq 0
check 'apply: só as TF_VAR_* conhecidas e as do executor (nada de TF_LOG nem TF_CLI_ARGS)' \
  test "$(grep -vcE '^TF_(VAR_[a-z0-9_]+|IN_AUTOMATION|INPUT|CLI_CONFIG_FILE|DATA_DIR)=' "$fake/env-plan")" -eq 0
check 'apply: nada do nome do cliente foi executado' test ! -e /tmp/invadido
check 'apply: result.json succeeded/apply_done' result_is succeeded apply_done
check 'apply: outputs.json só com as saídas da lista, com os valores' \
  test "$(uploaded outputs.json | jq -c 'keys')" = '["backups_bucket","instance_name","name_prefix","nat_ip","secrets","service_account_email","service_account_unique_id","zone"]'
check 'apply: outputs.json com o valor de cada saída (não o envelope do terraform output)' \
  test "$(uploaded outputs.json | jq -r '.nat_ip')" = '203.0.113.30'
check 'apply: o envio leva o token só no cabeçalho, ao caminho runs/<slug>/<runId>/<execução>/' \
  test "$(jq -r 'select(.method == "POST") | "\(.authorization) \(.name) \(.uploadType)"' "$state/requests.jsonl" | sort -u)" = \
  "Bearer $token runs/$slug/$run_id/$execution/outputs.json media
Bearer $token runs/$slug/$run_id/$execution/result.json media"
check 'apply: o token pedido uma vez, com Metadata-Flavor' \
  test "$(jq -r 'select(.method == "GET") | "\(.path) \(.flavor)"' "$state/requests.jsonl")" = '/token Google'
check 'apply: a saída tem o resumo do plano' grep -q 'plano: ' <<<"$output"
check 'apply: nenhum token, e-mail ou nome do cliente na saída (o plano e o apply do Terraform não vão ao log)' no_secrets_in_output
check 'apply: a pasta de trabalho (com o plano e o token) foi apagada' no_work_left

# --- 2. A conta de serviço do nó --------------------------------------------------------------------------------------
sa=module.node.google_service_account.node
for case in "$sa|[\"delete\",\"create\"]" "$sa|[\"create\",\"delete\"]" "$sa|[\"delete\"]" "$sa|[\"forget\"]" \
  "${sa}[0]|[\"delete\",\"create\"]" "${sa}[\"x\"]|[\"delete\"]"; do
  IFS='|' read -r address actions <<<"$case"
  reset
  plan_with "$address" "$actions"
  run_entrypoint
  check "conta do nó $address $actions: recusado com 3, sem apply" bash -c "test $status -eq 3 && ! grep -q '^apply ' '$fake/calls'"
  check "conta do nó $address $actions: result.json refused/node_sa_replacement" result_is refused node_sa_replacement
  check "conta do nó $address $actions: nenhum outputs.json" test -z "$(uploaded outputs.json)"
done
for actions in '["update"]' '["no-op"]' '["read"]'; do
  reset
  plan_with "$sa" "$actions"
  run_entrypoint
  check "conta do nó $actions: aplicado" bash -c "test $status -eq 0 && grep -q '^apply ' '$fake/calls'"
done
reset
plan_with "module.outro.google_service_account.node" '["delete","create"]'
run_entrypoint
check 'outra conta de serviço recriada (não a do nó): aplicado' test "$status" -eq 0

# A exclusão do cliente (CP-11) pode apagar a conta: o apply da Exclusão 1 e o destroy.
reset
plan_with "$sa" '["delete","create"]'
run_entrypoint RUN_KIND=delete
check 'RUN_KIND=delete: a conta recriada não é recusada' test "$status" -eq 0
reset
plan_with "$sa" '["delete"]'
run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
check 'destroy na exclusão: plan -destroy e apply, sem output' \
  bash -c "test $status -eq 0 && grep -q -- '^plan .*-destroy' '$fake/calls' && ! grep -q '^output ' '$fake/calls'"
check 'destroy na exclusão: result.json succeeded/destroy_done' result_is succeeded destroy_done
reset
run_entrypoint EXECUTOR_ACTION=destroy
check 'destroy fora da exclusão: recusado antes de qualquer terraform' bash -c "test $status -eq 3 && test ! -e '$fake/calls'"
check 'destroy fora da exclusão: result.json refused/action_refused' result_is refused action_refused

# Um plano que não dá para ler não passa.
reset
jq -n '{resource_changes: []}' >"$fake/plan.json"
run_entrypoint
check 'plano sem format_version: recusado (plan_unreadable), sem apply' \
  bash -c "test $status -eq 3 && ! grep -q '^apply ' '$fake/calls'"
check 'plano sem format_version: result.json refused/plan_unreadable' result_is refused plan_unreadable
reset
printf 'não é json' >"$fake/plan.json"
run_entrypoint
check 'plano que não é JSON: recusado sem apply' bash -c "test $status -eq 3 && ! grep -q '^apply ' '$fake/calls'"

# --- 3. Variáveis fora do formato: recusadas antes do terraform, sem o valor na saída ---------------------------------
long_name=$(printf 'a%.0s' $(seq 1 201))
bad_values=(
  "EXECUTOR_ACTION=plan"
  "RUN_KIND=manual"
  "PLAN=interno"
  "PLAN_HISTORY_DAYS=29"
  "PLAN_MAX_USERS=1001"
  "PLAN_MAX_USERS=007"
  "PLAN_MONTHLY_GIB="
  "NODE_VERSION=v1.2.3"
  "NODE_VERSION=node-v1.2.3
x"
  "NODE_PACKAGE_SHA256=0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
  "WEB_ORIGIN=https://cliente-demo-a.control.example.com/"
  "WEB_ORIGIN=https://cliente-demo-a.control.example.com:8443"
  "WEB_ORIGIN=http://cliente-demo-a.control.example.com"
  "WEB_ORIGIN=https://cliente-demo-a.control.example.com
https://outro.example.com"
  "MAIL_FROM=nao-responda@example.com
x"
  "API_ORIGIN=https://cliente-demo-a.control.example.com"
  "API_ORIGIN=https://API-cliente.example.com"
  "MAIL_FROM=o'neil@example.com"
  "MAIL_FROM=Verax <nao-responda@example.com>"
  "SUBNET_CIDR=10.08.0.0/24"
  "SUBNET_CIDR=10.256.0.0/24"
  "SUBNET_CIDR=192.168.0.0/24"
  "BOOTSTRAP_ADMIN_EMAIL=admin@cliente
.example.com"
  "BOOTSTRAP_ADMIN_EMAIL=.admin@cliente.example.com"
  "BOOTSTRAP_ADMIN_EMAIL=admin@@cliente.example.com"
  "BOOTSTRAP_SUPPORT_EMAIL=O'Neil+TI@Cliente-Demo-A.example.com"
  "BOOTSTRAP_TENANT_NAME= Cliente"
  "BOOTSTRAP_TENANT_NAME=Cliente "
  "BOOTSTRAP_TENANT_NAME=Cliente
Demo"
  "BOOTSTRAP_TENANT_NAME=Cliente$(printf '\t')Demo"
  "BOOTSTRAP_TENANT_NAME=$long_name"
  "BOOTSTRAP_TENANT_NAME=A"
  "IMAGES_REPOSITORY=docker.io/williandotdev/verax-control"
  "IMAGES_REPOSITORY=ghcr.io/williandotdev/verax-control/api"
  "CP_WORKER_SA=cp-public@projeto-exemplo-cp.iam.gserviceaccount.com"
  "NODES_ZONE=us-east1-b"
)
for assignment in "${bad_values[@]}"; do
  name=${assignment%%=*}
  value=${assignment#*=}
  reset
  run_entrypoint "$assignment"
  label="$name fora do formato ($(printf '%q' "$value" | cut -c1-40))"
  check "$label: sai com 2, sem terraform" bash -c "test $status -eq 2 && test ! -e '$fake/calls'"
  check "$label: result.json invalid/input_invalid" result_is invalid input_invalid
  check "$label: a saída cita a variável e não o valor" names_not_value "$output" "$name" "$value"
done
reset
run_entrypoint PLAN=enterprise PLAN_MAX_CLOUD_ACCOUNTS=
check 'enterprise sem um dos quatro limites: recusado' test "$status" -eq 2
reset
run_entrypoint PLAN=profissional PLAN_MAX_CLOUD_ACCOUNTS= PLAN_MAX_USERS= PLAN_MONTHLY_GIB= PLAN_HISTORY_DAYS=
check 'profissional sem limites: aplicado (o nó usa os do plano)' test "$status" -eq 0
reset
run_entrypoint "BOOTSTRAP_TENANT_NAME=$(printf 'ã%.0s' $(seq 1 200))"
check 'nome com 200 caracteres acentuados (400 bytes): aceito' test "$status" -eq 0
reset
run_entrypoint IMAGES_REPOSITORY=us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control
check 'Artifact Registry do projeto da Verax: aceito' test "$status" -eq 0

# --- 4. Nada muda o executor por fora --------------------------------------------------------------------------------
for assignment in TF_LOG=TRACE TF_CLI_ARGS_apply=-target=x TF_VAR_deletion_protection=false \
  GOOGLE_APPLICATION_CREDENTIALS=/tmp/x.json GOOGLE_OAUTH_ACCESS_TOKEN=ya29.x GODEBUG=x509ignoreCN=1 \
  GCE_METADATA_HOST=203.0.113.9 https_proxy=http://203.0.113.9:3128 NO_PROXY=x CURL_CA_BUNDLE=/tmp/ca.pem \
  SSL_CERT_FILE=/tmp/ca.pem LD_PRELOAD=/tmp/x.so BASH_ENV=/tmp/x.sh CLOUDSDK_CORE_PROJECT=x; do
  reset
  run_entrypoint "$assignment"
  check "${assignment%%=*} no ambiente: recusado (2) antes de tudo, sem terraform e sem resultado" \
    bash -c "test $status -eq 2 && test ! -e '$fake/calls' && test ! -e '$state/requests.jsonl'"
done
reset
status=0
output=$(env -i "${base_env[@]}" "$root/entrypoint.sh" --qualquer 2>&1) || status=$?
check 'argumento na linha de comando: recusado (2) sem terraform' bash -c "test $status -eq 2 && test ! -e '$fake/calls'"
reset
run_entrypoint RUN_ID=01jbteste0000000000000rvn1
check 'endereço do resultado fora do formato: sai com 2 sem gravar nada' \
  bash -c "test $status -eq 2 && test ! -e '$state/requests.jsonl' && test ! -e '$fake/calls'"
reset
run_entrypoint TENANT_SLUG=
check 'slug ausente: sai com 2 sem gravar nada' bash -c "test $status -eq 2 && test ! -e '$state/requests.jsonl'"
reset
run_entrypoint TENANT_SLUG=cl--iente
check 'slug com hífen na 3.ª e na 4.ª posições (parte do endereço): sai com 2 sem gravar nada' \
  bash -c "test $status -eq 2 && test ! -e '$state/requests.jsonl' && test ! -e '$fake/calls'"

# --- 5. Falhas do Terraform e do bucket -------------------------------------------------------------------------------
for stage in init plan apply; do
  reset
  touch "$fake/fail-$stage"
  run_entrypoint
  check "terraform $stage falha: sai com 4 (o cp-worker repete uma vez)" test "$status" -eq 4
  check "terraform $stage falha: result.json failed/terraform_${stage}_failed" result_is failed "terraform_${stage}_failed"
  check "terraform $stage falha: só a linha Error na saída, nunca o valor da variável" \
    error_line_only "$output"
done
reset
touch "$fake/fail-output"
run_entrypoint
check 'terraform output falha: sai com 4' test "$status" -eq 4
check 'terraform output falha: result.json failed/terraform_output_failed' result_is failed terraform_output_failed
reset
jq -n '{nat_ip: {sensitive: true, type: "string", value: "203.0.113.30"}}' >"$fake/outputs.json"
run_entrypoint
check 'uma saída sensível: sai com 4' test "$status" -eq 4
check 'uma saída sensível: nada vai para o outputs.json' test -z "$(uploaded outputs.json)"
reset
touch "$state/fail-upload"
run_entrypoint
check 'o bucket recusa o envio: sai com 5' test "$status" -eq 5
reset
printf 'token com espaço' >"$state/token"
run_entrypoint
check 'token fora do formato no servidor de metadados: nada é enviado (5)' \
  bash -c "test $status -eq 5 && ! grep -q '\"POST\"' '$state/requests.jsonl'"
check 'a pasta de trabalho é apagada também nas falhas' no_work_left

printf '\n%d ok, %d falhas\n' "$passes" "$fails"
((fails == 0))
