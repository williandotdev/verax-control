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
  'readonly cell_tenant_root=/opt/verax/infra/gcp/envs/cell-tenant'
  'readonly cli_config=/opt/verax/terraform.rc'
  'readonly metadata_token_url=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
  'readonly storage_upload_url=https://storage.googleapis.com/upload/storage/v1/b'
  'readonly storage_api_url=https://storage.googleapis.com/storage/v1/b'
  'readonly compute_url=https://compute.googleapis.com/compute/v1'
  'readonly secretmanager_url=https://secretmanager.googleapis.com/v1'
  'readonly work_parent=/tmp'
)
for line in "${production_lines[@]}"; do
  check "produção: $line" grep -qxF "$line" "$entrypoint"
done
check 'produção: toda chamada às APIs do Google só por HTTPS (uma função só)' \
  test "$(grep -c -- "--proto '=https'" "$entrypoint")" -eq 1
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
  -e "s|^readonly cell_tenant_root=.*|readonly cell_tenant_root=$root/cell-tenant|" \
  -e "s|^readonly cli_config=.*|readonly cli_config=$root/terraform.rc|" \
  -e "s|^readonly metadata_token_url=.*|readonly metadata_token_url=http://127.0.0.1:$port/token|" \
  -e "s|^readonly storage_upload_url=.*|readonly storage_upload_url=http://127.0.0.1:$port/upload/storage/v1/b|" \
  -e "s|^readonly storage_api_url=.*|readonly storage_api_url=http://127.0.0.1:$port/storage/v1/b|" \
  -e "s|^readonly compute_url=.*|readonly compute_url=http://127.0.0.1:$port/compute/v1|" \
  -e "s|^readonly secretmanager_url=.*|readonly secretmanager_url=http://127.0.0.1:$port/secretmanager/v1|" \
  -e "s|^readonly work_parent=.*|readonly work_parent=$work_parent|" \
  -e "s|--proto '=https'|--proto '=http'|" \
  "$entrypoint" >"$root/entrypoint.sh"
chmod 0755 "$root/entrypoint.sh"
mkdir -p "$root/tenant" "$root/cell-tenant"
check 'a cópia do teste troca só os valores de produção (11 linhas)' \
  test "$(diff "$entrypoint" "$root/entrypoint.sh" | grep -c '^>')" -eq 11

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
  # Sem o e-mail do nó, o cp-worker manda as três vazias (executor-env.ts).
  "SMTP_HOST="
  "SMTP_PORT="
  "SMTP_USER="
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
  rm -rf -- "$state/uploads" "$state/requests.jsonl" "$state/fail-upload" "$state/fail-api" "$state/cloud.json" \
    "$fake"/calls "$fake"/env-plan "$fake"/env-init "$fake"/state "$fake"/fail-*
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
  "TF_VAR_smtp_host=" "TF_VAR_smtp_port=" "TF_VAR_smtp_user="
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

# A ação amarrada ao tipo (CP-11): apply só no provisionamento, destroy só na Exclusão 1, purge só na Exclusão 2.
for pair in apply:delete apply:crypto_destroy destroy:provision destroy:resume destroy:crypto_destroy purge:provision \
  purge:resume purge:delete; do
  reset
  plan_with "$sa" '["delete"]'
  run_entrypoint "EXECUTOR_ACTION=${pair%%:*}" "RUN_KIND=${pair#*:}"
  check "$pair: recusado (action_refused) antes de qualquer terraform" \
    bash -c "test $status -eq 3 && test ! -e '$fake/calls'"
  check "$pair: result.json refused/action_refused" result_is refused action_refused
done

# --- 2b. Exclusão 1 (destroy, RUN_KIND=delete) -----------------------------------------------------------------------
project=projeto-exemplo-nos
disk_source="https://www.googleapis.com/compute/v1/projects/$project/zones/southamerica-east1-b/disks/vx-$slug"
other_source="https://www.googleapis.com/compute/v1/projects/$project/zones/southamerica-east1-b/disks/vx-$slug-2"
kept_addresses=(
  'module.node.google_compute_disk.node'
  'module.node.google_compute_address.nat[0]'
  'module.node.google_storage_bucket.backups'
  'module.node.google_secret_manager_secret.node_written["credentials-key"]'
  'google_secret_manager_secret_iam_member.worker_credentials_key'
)
# O estado e o projeto de um cliente com tudo no ar, mais o de outro cliente (`<slug>-2`, mesmo prefixo) e um snapshot
# de um disco de mesmo nome em outra zona: nada disso pode ser apagado.
tenant_world() {
  printf '%s\n' 'module.node.google_compute_instance.node' 'module.node.google_service_account.node' \
    'module.node.google_secret_manager_secret_iam_member.node_written_adder["credentials-key"]' \
    "${kept_addresses[@]}" >"$fake/state"
  jq -n --arg slug "$slug" --arg source "$disk_source" --arg other "$other_source" --arg project "$project" '{
    pageSize: 2,
    instances: {("vx-" + $slug): {deletionProtection: true}, ("vx-" + $slug + "-2"): {deletionProtection: true}},
    disks: ["vx-" + $slug, "vx-" + $slug + "-2"],
    snapshots: [
      {name: ("vx-" + $slug + "-snap-1"), sourceDisk: $source},
      {name: ("vx-" + $slug + "-2-snap-1"), sourceDisk: $other},
      {name: ("vx-" + $slug + "-snap-2"), sourceDisk: $source},
      {name: ("vx-" + $slug + "-snap-zona"), sourceDisk: ($source | sub("southamerica-east1-b"; "southamerica-east1-c"))},
      {name: ("vx-" + $slug + "-snap-3"), sourceDisk: $source}
    ],
    addresses: ["vx-" + $slug + "-nat-ip", "vx-" + $slug + "-2-nat-ip"],
    secrets: ["vx-" + $slug + "-credentials-key", "vx-" + $slug + "-2-credentials-key"],
    buckets: {($project + "-vx-" + $slug + "-backups"): {objects: 0}, ($project + "-vx-" + $slug + "-2-backups"): {objects: 3}},
    objects: ["tenants/" + $slug + "/default.tfstate", "tenants/" + $slug + "-2/default.tfstate"]
  }' >"$state/cloud.json"
}
destroy_plan() { # <ações de um recurso a mais, em JSON> [endereço]
  jq -n --arg address "${2:-module.node.google_compute_instance.node}" --argjson actions "$1" '{
    format_version: "1.2",
    resource_changes: [
      {address: "module.node.google_service_account.node", change: {actions: ["delete"]}},
      {address: $address, change: {actions: $actions}}
    ]
  }' >"$fake/plan.json"
}
cloud() { jq -rc "$1" "$state/cloud.json"; }
api_calls() { jq -r 'select(.query != null) | "\(.method) \(.path)"' "$state/requests.jsonl" 2>/dev/null; }

reset
tenant_world
destroy_plan '["delete"]'
run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
check 'destroy: sai com 0' test "$status" -eq 0
check 'destroy: result.json succeeded/destroy_done' result_is succeeded destroy_done
check 'destroy: init, state list, os cinco state rm, plan -destroy, show e apply, nessa ordem (sem output)' \
  test "$(cut -d' ' -f1,2 "$fake/calls" | tr '\n' '|')" = \
  'init -no-color|state list|state rm|state rm|state rm|state rm|state rm|plan -no-color|show -json|apply -no-color|'
removed=0
for address in "${kept_addresses[@]}"; do grep -qxF "state rm -lock-timeout=5m $address" "$fake/calls" && removed=$((removed + 1)); done
check 'destroy: exatamente os endereços da lista saem do estado' test "$removed" -eq 5
check 'destroy: o resto fica no estado para o destroy (a conta do nó, a VM, a permissão da VM no cofre)' \
  test "$(wc -l <"$fake/state")" -eq 3
check 'destroy: plan com -destroy' grep -q -- '^plan .*-destroy' "$fake/calls"
check 'destroy: a proteção da VM sai pela API antes do plan' \
  test "$(api_calls | head -n 1)" = "POST /compute/v1/projects/$project/zones/southamerica-east1-b/instances/vx-$slug/setDeletionProtection"
check 'destroy: o disco do cliente apagado, o do outro cliente não' test "$(cloud '.disks')" = "[\"vx-$slug-2\"]"
check 'destroy: só os snapshots do disco do cliente (de todas as páginas), nem o do outro, nem o de outra zona' \
  test "$(cloud '[.snapshots[].name]')" = "[\"vx-$slug-2-snap-1\",\"vx-$slug-snap-zona\"]"
check 'destroy: o IP do NAT do cliente liberado, o do outro não' test "$(cloud '.addresses')" = "[\"vx-$slug-2-nat-ip\"]"
check 'destroy: o cofre credentials-key e o bucket de backups ficam (Exclusão 2)' \
  test "$(cloud '[(.secrets | length), (.buckets | length)] | map(tostring) | join(",")')" = '2,2'
check 'destroy: toda chamada à API com o token só no cabeçalho' \
  test "$(jq -r 'select(.query != null) | .authorization' "$state/requests.jsonl" | sort -u)" = "Bearer $token"
check 'destroy: nenhum token, e-mail ou nome do cliente na saída' no_secrets_in_output

# Repetir a Exclusão 1 depois de terminada (estado vazio, tudo já apagado): sem erro, sem tirar nada do estado.
reset
tenant_world
destroy_plan '["delete"]'
run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
cp "$state/cloud.json" "$root/cloud-after.json"
rm -f "$state/requests.jsonl" "$fake/calls"
: >"$fake/state"
jq -n '{format_version: "1.2", resource_changes: []}' >"$fake/plan.json"
run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
check 'destroy de novo: sai com 0, sem state rm e sem tirar a proteção de VM nenhuma' \
  bash -c "test $status -eq 0 && ! grep -q '^state rm' '$fake/calls' && ! grep -q setDeletionProtection '$state/requests.jsonl'"
check 'destroy de novo: as chamadas que apagam acham 404 e seguem' \
  bash -c "diff -q '$root/cloud-after.json' '$state/cloud.json' >/dev/null"

# O plano da exclusão só apaga, e nunca o que saiu do estado.
for case in 'module.node.google_compute_instance.node|["create"]' 'module.node.google_compute_instance.node|["update"]' \
  'module.node.google_compute_instance.node|["delete","create"]' 'module.node.google_compute_disk.node|["delete"]' \
  'module.node.google_storage_bucket.backups|["delete"]'; do
  IFS='|' read -r address actions <<<"$case"
  reset
  tenant_world
  destroy_plan "$actions" "$address"
  run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
  check "destroy com $address $actions: recusado sem apply" \
    bash -c "test $status -eq 3 && ! grep -q '^apply ' '$fake/calls'"
  check "destroy com $address $actions: result.json refused/destroy_plan_unexpected" result_is refused destroy_plan_unexpected
  check "destroy com $address $actions: o disco e os snapshots não foram tocados" \
    test "$(cloud '[(.disks | length), (.snapshots | length)] | join(",")')" = '2,5'
done

# A API recusa apagar o disco (ainda preso à VM): falha comum (o cp-worker repete uma vez).
reset
tenant_world
jq '.diskInUse = true' "$state/cloud.json" >"$state/cloud.tmp" && mv "$state/cloud.tmp" "$state/cloud.json"
destroy_plan '["delete"]'
run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
check 'disco preso: sai com 4' test "$status" -eq 4
check 'disco preso: result.json failed/cleanup_failed' result_is failed cleanup_failed
check 'disco preso: nenhum snapshot apagado' test "$(cloud '.snapshots | length')" -eq 5
reset
tenant_world
printf '{"method": "POST", "contains": "setDeletionProtection", "status": 403}' >"$state/fail-api"
destroy_plan '["delete"]'
run_entrypoint RUN_KIND=delete EXECUTOR_ACTION=destroy
check 'sem permissão para tirar a proteção: sai com 4 antes de tirar algo do estado' \
  bash -c "test $status -eq 4 && ! grep -q '^state rm' '$fake/calls'"
check 'sem permissão para tirar a proteção: result.json failed/deletion_protection_failed' \
  result_is failed deletion_protection_failed

# --- 2c. Exclusão 2 (purge, RUN_KIND=crypto_destroy) -----------------------------------------------------------------
# Só o endereço e as variáveis fixas do Job: nenhuma do cliente.
purge_env=(
  "PATH=/usr/bin:/bin"
  "HOME=/home/executor"
  "TFSTATE_BUCKET=projeto-exemplo-nos-tfstate"
  "NODES_PROJECT_ID=$project"
  "NODES_REGION=southamerica-east1"
  "NODES_ZONE=southamerica-east1-b"
  "CP_WORKER_SA=cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
  "CLOUD_RUN_EXECUTION=$execution"
  "EXECUTOR_ACTION=purge"
  "RUN_KIND=crypto_destroy"
  "RUN_ID=$run_id"
  "TENANT_SLUG=$slug"
  "FAKE_TERRAFORM_DIR=$fake"
)
run_purge() {
  status=0
  output=$(env -i "${purge_env[@]}" "$@" "$root/entrypoint.sh" 2>&1) || status=$?
}
reset
tenant_world
: >"$fake/state"
run_purge
check 'purge: sai com 0' test "$status" -eq 0
check 'purge: result.json succeeded/purge_done' result_is succeeded purge_done
check 'purge: só init e state list (nenhum plan nem apply)' \
  test "$(cut -d' ' -f1,2 "$fake/calls" | tr '\n' '|')" = 'init -no-color|state list|'
check 'purge: nenhuma TF_VAR_* chega ao Terraform' bash -c "! grep -q '^TF_VAR_' '$fake/env-init'"
check 'purge: o cofre, o bucket e o estado do cliente apagados; os do outro cliente ficam' \
  test "$(cloud '[.secrets, (.buckets | keys), .objects] | flatten | join(",")')" = \
  "vx-$slug-2-credentials-key,$project-vx-$slug-2-backups,tenants/$slug-2/default.tfstate"
check 'purge: nada de Compute (a VM e o disco são da Exclusão 1)' \
  bash -c "! grep -q '/compute/' '$state/requests.jsonl'"
check 'purge: nenhuma listagem de bucket' bash -c "! jq -e 'select(.method == \"GET\" and (.path | contains(\"/storage/\")))' '$state/requests.jsonl' >/dev/null"
reset
tenant_world
: >"$fake/state"
jq ".buckets[\"$project-vx-$slug-backups\"].objects = 2" "$state/cloud.json" >"$state/cloud.tmp" &&
  mv "$state/cloud.tmp" "$state/cloud.json"
run_purge
check 'purge com o bucket de backups ainda com objetos: sai com 4' test "$status" -eq 4
check 'purge com o bucket de backups ainda com objetos: failed/backups_bucket_not_empty' \
  result_is failed backups_bucket_not_empty
check 'purge com o bucket ainda com objetos: o estado do cliente fica para a próxima tentativa' \
  test "$(cloud '.objects | length')" -eq 2
reset
tenant_world
printf '%s\n' 'module.node.google_compute_instance.node' >"$fake/state"
run_purge
check 'purge com o estado ainda com recursos (a Exclusão 1 não terminou): recusado, nada apagado' \
  bash -c "test $status -eq 3 && ! grep -q DELETE '$state/requests.jsonl'"
check 'purge com o estado ainda com recursos: result.json refused/state_not_empty' result_is refused state_not_empty
reset
run_purge TENANT_SLUG=cl--iente
check 'purge com o slug fora do formato: sai com 2 sem gravar nada' \
  bash -c "test $status -eq 2 && test ! -e '$state/requests.jsonl'"
reset
run_purge NODES_PROJECT_ID=Projeto_Errado
check 'purge com o projeto fora do formato: recusado (2) antes de qualquer chamada' \
  bash -c "test $status -eq 2 && ! grep -q DELETE '$state/requests.jsonl' 2>/dev/null"

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
long_name=$(printf 'a%.0s' $(seq 1 121))
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
run_entrypoint "BOOTSTRAP_TENANT_NAME=$(printf 'ã%.0s' $(seq 1 120))"
check 'nome com 120 caracteres acentuados (240 bytes, o limite do checkout e do nó): aceito' test "$status" -eq 0
reset
run_entrypoint "BOOTSTRAP_TENANT_NAME=$(printf 'ã%.0s' $(seq 1 121))"
check 'nome com 121 caracteres acentuados: recusado' test "$status" -eq 2
reset
run_entrypoint IMAGES_REPOSITORY=us-east1-docker.pkg.dev/projeto-exemplo-imagens/verax-control
check 'Artifact Registry do projeto da Verax: aceito' test "$status" -eq 0

# O e-mail do nó: as três juntas chegam ao Terraform byte a byte; uma sem as outras é recusada pelo nome da que falta.
smtp_ok=(SMTP_HOST=smtp.caixa-exemplo.example SMTP_PORT=65535 SMTP_USER=avisos+nos_1@verax.example)
reset
run_entrypoint "${smtp_ok[@]}"
check 'e-mail do nó: aplicado' test "$status" -eq 0
missing=0
for var in TF_VAR_smtp_host=smtp.caixa-exemplo.example TF_VAR_smtp_port=65535 TF_VAR_smtp_user=avisos+nos_1@verax.example; do
  grep -qxF "$var" "$fake/env-plan" || missing=1
done
check 'e-mail do nó: o servidor, a porta e o usuário chegam como TF_VAR_smtp_*, byte a byte' test "$missing" -eq 0
# Cada valor fora do formato, com os outros dois válidos: recusado pelo nome, sem o valor na saída.
smtp_bad=(
  "SMTP_HOST=SMTP.Caixa-Exemplo.example"
  "SMTP_HOST=smtp.caixa-exemplo.example:465"
  "SMTP_HOST=smtp.caixa-exemplo.example\$(touch /tmp/invadido)"
  "SMTP_HOST=localhost"
  "SMTP_HOST=smtp.caixa-exemplo.example
smtp.outro.example"
  "SMTP_PORT=0"
  "SMTP_PORT=65536"
  "SMTP_PORT=0465"
  "SMTP_PORT=465 "
  "SMTP_USER=o'neil@verax.example"
  "SMTP_USER=-avisos"
  "SMTP_USER=avisos verax"
)
for assignment in "${smtp_bad[@]}"; do
  name=${assignment%%=*}
  value=${assignment#*=}
  reset
  run_entrypoint "${smtp_ok[@]}" "$assignment"
  label="$name fora do formato ($(printf '%q' "$value" | cut -c1-40))"
  check "$label: sai com 2, sem terraform" bash -c "test $status -eq 2 && test ! -e '$fake/calls'"
  check "$label: result.json invalid/input_invalid" result_is invalid input_invalid
  check "$label: a saída cita a variável e não o valor" names_not_value "$output" "$name" "$value"
done
for case in "SMTP_USER|SMTP_HOST=smtp.caixa-exemplo.example SMTP_PORT=465" \
  "SMTP_HOST|SMTP_PORT=465 SMTP_USER=avisos@verax.example" \
  "SMTP_PORT|SMTP_HOST=smtp.caixa-exemplo.example SMTP_USER=avisos@verax.example"; do
  IFS='|' read -r missing_name assignments <<<"$case"
  read -r -a assignments <<<"$assignments"
  reset
  run_entrypoint "${assignments[@]}"
  check "e-mail do nó sem $missing_name: recusado (2) sem terraform" bash -c "test $status -eq 2 && test ! -e '$fake/calls'"
  check "e-mail do nó sem $missing_name: a saída cita $missing_name" grep -q "variável fora do formato: $missing_name" <<<"$output"
done

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

# --- 6. Cliente da célula (CE-07: envs/cell-tenant) ------------------------------------------------------------------
# As variáveis de uma execução da célula, como o cp-worker as manda (cellTenantExecutorEnv em executor-env.ts) mais as
# fixas do Job: nenhuma do nó dedicado (plano, versão, e-mails).
cell_project=projeto-exemplo-celula
uuid_a=0190a8c0-0000-7000-8000-00000000000a
uuid_b=0190a8c0-0000-7000-8000-00000000000b
writer_a=serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com
writer_b=serviceAccount:service-310987654321@gcp-sa-logging.iam.gserviceaccount.com
# Fora de ordem e com espaços: o executor reescreve em forma canônica (chaves ordenadas, compacto).
sources="{ \"$uuid_b\": {\"writer_identity\": \"$writer_b\", \"project_id\": \"projeto-do-cliente-a2\"}, \"$uuid_a\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"$writer_a\"} }"
canonical="{\"$uuid_a\":{\"project_id\":\"projeto-do-cliente-a1\",\"writer_identity\":\"$writer_a\"},\"$uuid_b\":{\"project_id\":\"projeto-do-cliente-a2\",\"writer_identity\":\"$writer_b\"}}"
cell_env=(
  "PATH=/usr/bin:/bin"
  "HOME=/home/executor"
  "TFSTATE_BUCKET=projeto-exemplo-nos-tfstate"
  "NODES_PROJECT_ID=projeto-exemplo-nos"
  "NODES_REGION=southamerica-east1"
  "NODES_ZONE=southamerica-east1-b"
  "CP_WORKER_SA=cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com"
  "CLOUD_RUN_EXECUTION=$execution"
  "EXECUTOR_ACTION=apply"
  "RUN_KIND=cell_provision"
  "RUN_ID=$run_id"
  "TENANT_SLUG=$slug"
  "CELL_ID=sp1"
  "CELL_PROJECT_ID=$cell_project"
  "CELL_REGION=southamerica-east1"
  "CELL_NODE_SA=verax-celula@$cell_project.iam.gserviceaccount.com"
  "GCP_SOURCES=$sources"
  "FAKE_TERRAFORM_DIR=$fake"
)
run_cell() { # <variáveis a mais ou trocadas...>
  status=0
  output=$(env -i "${cell_env[@]}" "$@" "$root/entrypoint.sh" 2>&1) || status=$?
}
cell_plan_with() { # <ações da conta do cliente em JSON> [endereço]
  jq -n --arg address "${2:-google_service_account.tenant}" --argjson actions "$1" '{
    format_version: "1.2",
    resource_changes: [
      {address: $address, change: {actions: $actions}},
      {address: "google_pubsub_topic.gcp_source[\"0190a8c0-0000-7000-8000-00000000000a\"]", change: {actions: ["create"]}}
    ]
  }' >"$fake/plan.json"
}
cell_reset() {
  reset
  rm -f "$fake/chdirs"
  cell_plan_with '["create"]'
  jq -n '{
    tenant_service_account_email: {sensitive: false, type: "string", value: "vxt-cliente-demo-a@projeto-exemplo-celula.iam.gserviceaccount.com"},
    tenant_service_account_unique_id: {sensitive: false, type: "string", value: "109876543210987654321"},
    admin_bootstrap_secret: {sensitive: false, type: "string", value: "vxt-cliente-demo-a-admin-bootstrap"},
    gcp_sources: {sensitive: false, type: ["map", ["object", {topic: "string", subscription: "string"}]], value: {}},
    uma_saida_nova: {sensitive: false, type: "string", value: "nao-deveria-sair"}
  }' >"$fake/outputs.json"
}

cell_reset
run_cell
check 'célula: apply sai com 0' test "$status" -eq 0
check 'célula: o Terraform roda no envs/cell-tenant, e só nele' \
  test "$(sort -u "$fake/chdirs")" = "$root/cell-tenant"
check 'célula: init com o prefixo cells/<célula>/tenants/<slug>' \
  grep -qxF "init -no-color -input=false -lockfile=readonly -backend-config=bucket=projeto-exemplo-nos-tfstate -backend-config=prefix=cells/sp1/tenants/$slug" "$fake/calls"
cell_vars=(
  "TF_VAR_project_id=projeto-exemplo-nos" "TF_VAR_cell_project_id=$cell_project" "TF_VAR_region=southamerica-east1" "TF_VAR_cell_id=sp1" "TF_VAR_slug=$slug"
  "TF_VAR_cell_node_service_account=verax-celula@$cell_project.iam.gserviceaccount.com"
  "TF_VAR_control_plane_sa=cp-worker@projeto-exemplo-cp.iam.gserviceaccount.com" "TF_VAR_gcp_sources=$canonical"
)
missing=0
for var in "${cell_vars[@]}"; do grep -qxF "$var" "$fake/env-plan" || missing=1; done
check 'célula: as variáveis da célula chegam como TF_VAR_*, as contas GCP em JSON canônico' test "$missing" -eq 0
check 'célula: nenhuma variável do nó dedicado' \
  test "$(grep -cE '^TF_VAR_(plan|node_version|bootstrap_|web_origin|zone|subnet_cidr|images_repository|smtp_)' "$fake/env-plan")" -eq 0
check 'célula: result.json succeeded/apply_done' result_is succeeded apply_done
check 'célula: outputs.json só com as saídas da lista da célula' \
  test "$(uploaded outputs.json | jq -c 'keys')" = '["admin_bootstrap_secret","gcp_sources","tenant_service_account_email","tenant_service_account_unique_id"]'
check 'célula: nenhum token na saída' test "${output/$token/}" = "$output"

run_cell RUN_KIND=cell_sources
check 'célula: cell_sources também aplica' bash -c "test $status -eq 0 && grep -q '^apply ' '$fake/calls'"

# A conta de serviço do cliente: recriada ou apagada fora do expurgo, recusado.
for actions in '["delete","create"]' '["create","delete"]' '["delete"]' '["forget"]'; do
  for kind in cell_provision cell_sources; do
    cell_reset
    cell_plan_with "$actions"
    run_cell "RUN_KIND=$kind"
    check "célula $kind: conta do cliente $actions recusada sem apply" \
      bash -c "test $status -eq 3 && ! grep -q '^apply ' '$fake/calls'"
    check "célula $kind: conta do cliente $actions: refused/tenant_sa_replacement" result_is refused tenant_sa_replacement
  done
done
cell_reset
cell_plan_with '["update"]'
run_cell
check 'célula: a conta do cliente mudada no lugar: aplicado' test "$status" -eq 0

# O expurgo do cliente da célula: só apaga.
cell_reset
cell_plan_with '["delete"]'
jq '.resource_changes[1].change.actions = ["delete"]' "$fake/plan.json" >"$fake/plan.tmp" && mv "$fake/plan.tmp" "$fake/plan.json"
run_cell EXECUTOR_ACTION=destroy RUN_KIND=cell_delete
check 'célula cell_delete: sai com 0' test "$status" -eq 0
check 'célula cell_delete: result.json succeeded/destroy_done' result_is succeeded destroy_done
check 'célula cell_delete: plan -destroy, show e apply, sem state rm, sem output' \
  test "$(cut -d' ' -f1,2 "$fake/calls" | tr '\n' '|')" = 'init -no-color|plan -no-color|show -json|apply -no-color|'
check 'célula cell_delete: plan com -destroy' grep -q -- '^plan .*-destroy' "$fake/calls"
check 'célula cell_delete: nenhuma chamada às APIs do Compute nem do Secret Manager, e nada apagado pela API' \
  bash -c "! jq -e 'select(.method == \"DELETE\" or (.path | test(\"compute|secretmanager\")))' '$state/requests.jsonl' >/dev/null"
for case in 'google_service_account.tenant|["create"]' 'google_pubsub_topic.gcp_source["x"]|["update"]'; do
  IFS='|' read -r address actions <<<"$case"
  cell_reset
  cell_plan_with '["delete"]'
  jq --arg address "$address" --argjson actions "$actions" '.resource_changes[1] = {address: $address, change: {actions: $actions}}' \
    "$fake/plan.json" >"$fake/plan.tmp" && mv "$fake/plan.tmp" "$fake/plan.json"
  run_cell EXECUTOR_ACTION=destroy RUN_KIND=cell_delete
  check "célula cell_delete com $address $actions: recusado sem apply" \
    bash -c "test $status -eq 3 && ! grep -q '^apply ' '$fake/calls'"
  check "célula cell_delete com $address $actions: refused/destroy_plan_unexpected" result_is refused destroy_plan_unexpected
done

# A ação amarrada ao tipo.
for pair in apply:cell_delete destroy:cell_provision destroy:cell_sources purge:cell_delete purge:cell_provision; do
  cell_reset
  run_cell "EXECUTOR_ACTION=${pair%%:*}" "RUN_KIND=${pair#*:}"
  check "célula $pair: recusado (action_refused) antes de qualquer terraform" \
    bash -c "test $status -eq 3 && test ! -e '$fake/calls'"
done

# Variáveis da célula fora do formato: recusadas antes do init, só com o nome na saída.
bad_sources=(
  'nao-e-json'
  '[]'
  "{\"${uuid_a^^}\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"$writer_a\"}}"
  "{\"$uuid_a\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"$writer_a\", \"extra\": \"x\"}}"
  "{\"$uuid_a\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"serviceAccount:alguem@projeto.iam.gserviceaccount.com\"}}"
  "{\"$uuid_a\": {\"project_id\": \"\${file(\\\"/etc/passwd\\\")}\", \"writer_identity\": \"$writer_a\"}}"
  "{\"$uuid_a\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"$writer_a\"}, \"$uuid_b\": {\"project_id\": \"projeto-do-cliente-a2\", \"writer_identity\": \"$writer_a\"}}"
  "{\"$uuid_a\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"$writer_a\"}, \"$uuid_b\": {\"project_id\": \"projeto-do-cliente-a1\", \"writer_identity\": \"$writer_b\"}}"
)
for value in "${bad_sources[@]}"; do
  cell_reset
  run_cell "GCP_SOURCES=$value"
  check "célula: GCP_SOURCES fora do formato (${value:0:40}...): invalid sem terraform" \
    bash -c "test $status -eq 2 && test ! -e '$fake/calls'"
  check "célula: GCP_SOURCES fora do formato (${value:0:40}...): só o nome na saída" names_not_value "$output" GCP_SOURCES "$value"
done
for case in 'CELL_ID=SP-1' 'CELL_ID=' 'CELL_PROJECT_ID=Projeto' "CELL_NODE_SA=verax-celula@outro-projeto-123.iam.gserviceaccount.com" \
  'CELL_REGION=sao paulo' 'GCP_SOURCES=' 'CP_WORKER_SA=cp-terraform@projeto-exemplo-cp.iam.gserviceaccount.com'; do
  cell_reset
  run_cell "$case"
  check "célula: ${case%%=*} fora do formato: invalid sem terraform" \
    bash -c "test $status -eq 2 && test ! -e '$fake/calls'"
  check "célula: ${case%%=*} fora do formato: result.json invalid/input_invalid" result_is invalid input_invalid
done
# Sem as contas GCP do cliente, o JSON vazio.
cell_reset
run_cell 'GCP_SOURCES={}'
check 'célula: sem conta GCP ({}), aplicado com o mapa vazio' \
  bash -c "test $status -eq 0 && grep -qxF 'TF_VAR_gcp_sources={}' '$fake/env-plan'"

printf '\n%d ok, %d falhas\n' "$passes" "$fails"
((fails == 0))
