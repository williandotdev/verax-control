#!/bin/bash -p
# Executor Terraform do plano de controle (fase 3, CP-07 e CP-11): o que o Job `cp-terraform` do Cloud Run roda a cada
# execução que o cp-worker dispara (`jobs.run` com `overrides.containerOverrides.env`). Aplica, destrói ou apaga o resto
# do `infra/gcp/envs/tenant` de UM cliente, com o estado em `tenants/<slug>/` no bucket do estado do projeto dos nós, e
# grava o resultado em `runs/<slug>/<runId>/<execução do Job>/` no mesmo bucket, a única pasta que o cp-worker lê.
#
# A ação é amarrada ao tipo da execução (`EXECUTOR_ACTION` × `RUN_KIND`); qualquer outra combinação é recusada:
# - `apply` em `provision` e `resume` (CP-07);
# - `destroy` em `delete`, a Exclusão 1 (CP-11): tira a proteção da VM pela API, tira do estado o que fica até a
#   Exclusão 2 ou tem `prevent_destroy` (o disco, o IP do NAT, o bucket de backups, o cofre `credentials-key` e a
#   permissão do cp-worker nele), destrói o resto (a conta de serviço do nó inclusive: só aqui) e apaga pela API o
#   disco, os snapshots dele (`KEEP_AUTO_SNAPSHOTS` os deixaria para sempre) e o IP do NAT;
# - `purge` em `crypto_destroy`, a Exclusão 2 (CP-11): com o estado já vazio (senão recusa), apaga pela API o cofre
#   `credentials-key` (as versões o cp-worker já destruiu), o bucket de backups (só vazio: o executor não apaga objeto
#   de backup; com objetos, `backups_bucket_not_empty`, e o cp-worker tenta no dia seguinte) e o estado do cliente.
# Todo nome apagado pela API sai do slug e do projeto conferidos (`vx-<slug>...`): nada fora do cliente é alcançado.
#
# Regras (plano §2.1 e §5; docs/ARQUITETURA.md, "Exclusão em dois tempos"):
# - nenhum argumento e nenhuma variável que mude o Terraform, o Go, o shell, o curl ou as credenciais (`TF_*`, `GO*`,
#   `GCE_*`, `LD_*`, proxy...): quem dispara com `overrides` só escolhe as variáveis do cliente, conferidas aqui uma a
#   uma pela mesma regra do cp-worker (`apps/control-plane/src/provisioning/executor-env.ts`) e do `envs/tenant`, antes
#   do `terraform init`. Os valores chegam ao Terraform só por `TF_VAR_*` (atribuição, nunca interpretados pelo shell);
# - os providers vêm do espelho da imagem (`terraform providers mirror` no build, conferido contra o lock do tenant):
#   nada é baixado em execução;
# - o plano é conferido antes do `apply`: um plano que apaga, recria ou esquece a conta de serviço do nó
#   (`module.node.google_service_account.node`) é recusado, a menos que a execução seja a Exclusão 1 (`destroy` em
#   `RUN_KIND=delete`). A conta recriada ganha outro ID único, e o papel de leitura na AWS do cliente deixaria de aceitar
#   o nó. O plano da Exclusão 1 só pode apagar (nada criado nem mudado) e nunca o que saiu do estado;
# - a saída do Terraform (que mostra os metadados da VM, com o e-mail do admin e o nome do cliente) fica num arquivo da
#   pasta de trabalho, apagada no fim, nunca no log do Job; o log leva só o resumo do plano (quantos recursos por ação)
#   e, numa falha, as linhas `Error:` cortadas;
# - `outputs.json` leva só as saídas da lista fixa abaixo (nenhuma com dado pessoal), e o token da conta do Job (para
#   gravar no bucket) fica num arquivo 0600 da pasta de trabalho, nunca num argumento nem na saída.
#
# Saída: 0 aplicado; 2 entrada inválida (`invalid`); 3 recusado (`refused`); 4 o Terraform falhou (`failed`); 5 o
# resultado não chegou ao bucket. O `result.json` diz o mesmo ao cp-worker, que só repete o 4 (uma vez).
set -euo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

# Valores de produção. O teste (tests/entrypoint-test.sh) troca estes, e só estes, e confere que aqui são estes.
readonly terraform_bin=/bin/terraform
readonly tenant_root=/opt/verax/infra/gcp/envs/tenant
readonly cli_config=/opt/verax/terraform.rc
readonly metadata_token_url=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
readonly storage_upload_url=https://storage.googleapis.com/upload/storage/v1/b
readonly storage_api_url=https://storage.googleapis.com/storage/v1/b
readonly compute_url=https://compute.googleapis.com/compute/v1
readonly secretmanager_url=https://secretmanager.googleapis.com/v1
readonly work_parent=/tmp

# As saídas do envs/tenant que podem ir para o outputs.json (outputs.tf de lá: nenhuma com dado pessoal).
readonly allowed_outputs='["name_prefix","instance_name","zone","nat_ip","service_account_email","service_account_unique_id","secrets","backups_bucket"]'
readonly node_sa_address=module.node.google_service_account.node
# O que sai do estado antes do `destroy` da Exclusão 1 (docs/ARQUITETURA.md, "Exclusão em dois tempos"): o disco e o IP
# do NAT (`prevent_destroy`; apagados pela API logo depois), o bucket de backups (`force_destroy = false`; fica até a
# Exclusão 2, esvaziado pela retenção dele), o cofre `credentials-key` e a permissão do cp-worker de destruir as versões
# dele (ficam até a Exclusão 2: sem tirar a permissão do estado, o `destroy` a apagaria).
readonly -a kept_addresses=(
  'module.node.google_compute_disk.node'
  'module.node.google_compute_address.nat[0]'
  'module.node.google_storage_bucket.backups'
  'module.node.google_secret_manager_secret.node_written["credentials-key"]'
  'google_secret_manager_secret_iam_member.worker_credentials_key'
)

work=''
addressed=false

say() { printf 'verax-executor: %s\n' "$*"; }

# --- Formatos (os mesmos de executor-env.ts, do envs/tenant e do boot-install.sh) ------------------------------------
re_ulid='^[0-9A-HJKMNP-TV-Z]{26}$'
re_slug='^[a-z][a-z0-9-]{1,14}[a-z0-9]$'
re_project='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
re_region='^[a-z]+-[a-z]+[0-9]$'
re_zone='^[a-z]+-[a-z]+[0-9]-[a-z]$'
re_bucket='^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$'
re_execution='^[a-z0-9][a-z0-9-]{0,62}$'
re_release='^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
re_sha='^[0-9a-f]{64}$'
re_label='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
re_subnet='^10\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.0/24$'
re_limit='^[1-9][0-9]{0,5}$'
re_mail_local="^[A-Za-z0-9_+.'-]*[A-Za-z0-9_+-]\$"
re_mail_label='^[A-Za-z0-9][A-Za-z0-9-]*$'
re_mail_top='^[A-Za-z]{2,}$'
re_worker_sa='^cp-worker@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'
re_ghcr='^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'
re_artifact_registry='^[a-z0-9-]+-docker\.pkg\.dev/[a-z][a-z0-9-]{4,28}[a-z0-9]/[a-z0-9-]{1,63}$'
re_token='^[A-Za-z0-9._~+/=-]{16,4096}$'

# O token da conta do Job (servidor de metadados do Cloud Run) num arquivo de cabeçalho 0600; nunca em argumento.
auth_header() {
  local token
  token=$(curl -fsS --proto '=http' --max-time 10 -H 'Metadata-Flavor: Google' "$metadata_token_url" |
    jq -er '.access_token') || return 1
  [[ $token =~ $re_token ]] || return 1
  printf 'Authorization: Bearer %s\n' "$token" >"$work/auth.header"
}

# Uma chamada às APIs do Google com o token da conta do Job, só por HTTPS (a única linha com o protocolo https): o
# corpo da resposta vai para `response.json` da pasta de trabalho e o status HTTP para a saída (000 sem resposta). A
# rede, o 429 e o 5xx repetem até 3 vezes; quem chama decide o que cada status quer dizer.
gcp() { # <método> <url> [arquivo do corpo, na pasta de trabalho]
  local code
  local -a body=()
  [[ -s $work/auth.header ]] || auth_header || return 1
  if [[ -n ${3-} ]]; then body=(-H 'Content-Type: application/json' --data-binary @"$work/$3"); fi
  code=$(curl -sS --proto '=https' --max-time 30 --retry 3 --retry-all-errors -o "$work/response.json" -w '%{http_code}' \
    -X "$1" -H @"$work/auth.header" "${body[@]}" "$2") || code=000
  printf '%s' "$code"
}

upload() { # <arquivo da pasta de trabalho>
  local object="runs%2F$TENANT_SLUG%2F$RUN_ID%2F$CLOUD_RUN_EXECUTION%2F$1" status
  status=$(gcp POST "$storage_upload_url/$TFSTATE_BUCKET/o?uploadType=media&name=$object" "$1") || return 1
  [[ $status == 2?? ]]
}

# Escreve o result.json em runs/<slug>/<runId>/<execução>/ e sai com o código dado. Só depois de o endereço (bucket,
# slug, runId, execução) estar conferido; antes disso, sai sem resultado (o cp-worker trata como falha comum).
finish() { # <saída> <status> <código>
  say "resultado: $2 ($3)"
  if [[ $addressed == true ]]; then
    jq -n --arg status "$2" --arg code "$3" --arg run "$RUN_ID" --arg execution "$CLOUD_RUN_EXECUTION" \
      '{schema: 1, status: $status, code: $code, runId: $run, execution: $execution}' >"$work/result.json"
    if ! upload result.json; then
      say 'o resultado não chegou ao bucket do estado.'
      exit 5
    fi
  fi
  exit "$1"
}

invalid() { # <variável>: o valor nunca vai para a saída
  say "variável fora do formato: $1"
  finish 2 invalid input_invalid
}

is_mail() { # <valor> <aceita apóstrofo: true|false>
  local value=$1 local_part domain top label
  local -a labels
  ((${#value} <= 254)) || return 1
  [[ $value != .* && $value != *..* && $value == *@* && ${value#*@} != *@* ]] || return 1
  [[ $2 == true || $value != *"'"* ]] || return 1
  local_part=${value%@*}
  domain=${value#*@}
  [[ $local_part =~ $re_mail_local ]] || return 1
  [[ $domain != *. ]] || return 1
  IFS=. read -r -a labels <<<"$domain"
  ((${#labels[@]} >= 2)) || return 1
  top=${labels[-1]}
  [[ $top =~ $re_mail_top ]] || return 1
  for label in "${labels[@]:0:${#labels[@]}-1}"; do
    [[ $label =~ $re_mail_label ]] || return 1
  done
}

is_origin() { # <valor>
  local value=$1 host label
  local -a labels
  ((${#value} <= 261)) || return 1
  [[ $value == https://* ]] || return 1
  host=${value#https://}
  [[ $host != *. && $host != .* ]] || return 1
  IFS=. read -r -a labels <<<"$host"
  ((${#labels[@]} >= 2)) || return 1
  for label in "${labels[@]}"; do
    [[ $label =~ $re_label ]] || return 1
  done
}

limit_in() { # <valor> <mín> <máx>
  [[ $1 =~ $re_limit ]] || return 1
  (($1 >= $2 && $1 <= $3))
}

# Nome do cliente: de 2 a 120 caracteres (pontos de código, contados pelo jq em UTF-8; 120 é o limite do checkout e do
# nó, `Tenant.name`), sem caractere de controle e sem espaço nas pontas (os do `trimspace` do Terraform, o
# `unicode.IsSpace` do Go, mais o U+FEFF do `trim` do JS).
is_tenant_name() { # <valor>
  jq -en --arg v "$1" '
    [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232,
      8233, 8239, 8287, 12288, 65279] as $spaces
    | ($v | explode) as $c
    | ($c | length) >= 2 and ($c | length) <= 120 and ($c | all(. >= 32 and . != 127))
      and ($spaces | index($c[0]) | not) and ($spaces | index($c[-1]) | not)' >/dev/null 2>&1
}

# --- 1. Nada que mude o executor por fora -----------------------------------------------------------------------------
if (($# > 0)); then
  say 'o executor não aceita argumentos.'
  exit 2
fi
while IFS= read -r name; do
  shopt -s nocasematch
  case $name in
    TF_* | GO* | GCE_* | CLOUDSDK_* | LD_* | BASH_ENV | ENV | SHELLOPTS | BASHOPTS | CDPATH | GLOBIGNORE | PS4 | \
      *_PROXY | SSL_CERT_* | CURL_* | JQ_*)
      shopt -u nocasematch
      say "variável não aceita no executor: $name"
      exit 2
      ;;
  esac
  shopt -u nocasematch
done < <(compgen -e)

# --- 2. O endereço do resultado ---------------------------------------------------------------------------------------
for name in TFSTATE_BUCKET TENANT_SLUG RUN_ID CLOUD_RUN_EXECUTION; do
  if [[ -z ${!name-} ]]; then
    say "variável ausente: $name"
    exit 2
  fi
done
address_ok=true
[[ $TFSTATE_BUCKET =~ $re_bucket ]] || address_ok=false
[[ $TENANT_SLUG =~ $re_slug && ${TENANT_SLUG:2:2} != '--' ]] || address_ok=false
[[ $RUN_ID =~ $re_ulid ]] || address_ok=false
[[ $CLOUD_RUN_EXECUTION =~ $re_execution ]] || address_ok=false
if [[ $address_ok != true ]]; then
  say 'variável do endereço do resultado fora do formato (TFSTATE_BUCKET, TENANT_SLUG, RUN_ID ou CLOUD_RUN_EXECUTION).'
  exit 2
fi
work=$(mktemp -d "$work_parent/verax-executor.XXXXXX")
# O plano, o estado lido e o token ficam aqui: apagados na saída, em qualquer caso.
trap 'rm -rf -- "$work"' EXIT
addressed=true

# --- 3. A ação, o tipo da execução e as variáveis do cliente ---------------------------------------------------------
# A ação é amarrada ao tipo antes de tudo (o cabeçalho explica): `destroy` só na Exclusão 1, `purge` só na 2.
for name in EXECUTOR_ACTION RUN_KIND NODES_PROJECT_ID; do
  [[ -n ${!name-} && ${!name} =~ ^[[:graph:]]+$ ]] || invalid "$name"
done
case $EXECUTOR_ACTION in apply | destroy | purge) ;; *) invalid EXECUTOR_ACTION ;; esac
case $RUN_KIND in provision | resume | delete | crypto_destroy) ;; *) invalid RUN_KIND ;; esac
[[ $NODES_PROJECT_ID =~ $re_project ]] || invalid NODES_PROJECT_ID
case $EXECUTOR_ACTION:$RUN_KIND in
  apply:provision | apply:resume | destroy:delete | purge:crypto_destroy) ;;
  *)
    say "a ação $EXECUTOR_ACTION não é do tipo de execução $RUN_KIND."
    finish 3 refused action_refused
    ;;
esac

# As variáveis do cliente, para o `apply` e o `destroy` (o `purge` não lê nenhuma: só o endereço). Todas presentes;
# todas, menos o nome do cliente, só ASCII visível (nada de espaço nem quebra de linha, que o `read` das conferências
# abaixo cortaria).
check_tenant_variables() {
  local name spec low high value
  for name in NODES_REGION NODES_ZONE CP_WORKER_SA PLAN NODE_VERSION NODE_PACKAGE_SHA256 WEB_ORIGIN API_ORIGIN MAIL_FROM \
    SUBNET_CIDR BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_TENANT_NAME BOOTSTRAP_SUPPORT_EMAIL IMAGES_REPOSITORY; do
    [[ -n ${!name-} ]] || invalid "$name"
    [[ $name == BOOTSTRAP_TENANT_NAME || ${!name} =~ ^[[:graph:]]+$ ]] || invalid "$name"
  done
  for name in PLAN_MAX_CLOUD_ACCOUNTS PLAN_MAX_USERS PLAN_MONTHLY_GIB PLAN_HISTORY_DAYS; do
    [[ -z ${!name-} || ${!name} =~ ^[[:graph:]]+$ ]] || invalid "$name"
  done
  [[ $NODES_REGION =~ $re_region ]] || invalid NODES_REGION
  [[ $NODES_ZONE =~ $re_zone && $NODES_ZONE == "$NODES_REGION"-* ]] || invalid NODES_ZONE
  [[ $CP_WORKER_SA =~ $re_worker_sa ]] || invalid CP_WORKER_SA
  case $PLAN in essencial | profissional | enterprise) ;; *) invalid PLAN ;; esac
  for spec in PLAN_MAX_CLOUD_ACCOUNTS:1:1000 PLAN_MAX_USERS:1:1000 PLAN_MONTHLY_GIB:1:100000 PLAN_HISTORY_DAYS:30:3650; do
    IFS=: read -r name low high <<<"$spec"
    value=${!name-}
    if [[ -z $value ]]; then
      [[ $PLAN != enterprise ]] || invalid "$name"
    else
      limit_in "$value" "$low" "$high" || invalid "$name"
    fi
  done
  [[ $NODE_VERSION =~ $re_release ]] || invalid NODE_VERSION
  [[ $NODE_PACKAGE_SHA256 =~ $re_sha ]] || invalid NODE_PACKAGE_SHA256
  is_origin "$WEB_ORIGIN" || invalid WEB_ORIGIN
  if ! is_origin "$API_ORIGIN" || [[ $API_ORIGIN == "$WEB_ORIGIN" ]]; then invalid API_ORIGIN; fi
  is_mail "$MAIL_FROM" false || invalid MAIL_FROM
  [[ $SUBNET_CIDR =~ $re_subnet ]] || invalid SUBNET_CIDR
  ((BASH_REMATCH[1] <= 255 && BASH_REMATCH[2] <= 255)) || invalid SUBNET_CIDR
  is_mail "$BOOTSTRAP_ADMIN_EMAIL" true || invalid BOOTSTRAP_ADMIN_EMAIL
  if ! is_mail "$BOOTSTRAP_SUPPORT_EMAIL" true || [[ ${BOOTSTRAP_SUPPORT_EMAIL,,} == "${BOOTSTRAP_ADMIN_EMAIL,,}" ]]; then
    invalid BOOTSTRAP_SUPPORT_EMAIL
  fi
  is_tenant_name "$BOOTSTRAP_TENANT_NAME" || invalid BOOTSTRAP_TENANT_NAME
  [[ $IMAGES_REPOSITORY =~ $re_ghcr || $IMAGES_REPOSITORY =~ $re_artifact_registry ]] || invalid IMAGES_REPOSITORY
}
if [[ $EXECUTOR_ACTION != purge ]]; then check_tenant_variables; fi

# --- 4. O Terraform, só com o espelho de providers e as variáveis conferidas --------------------------------------
export TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1
export TF_CLI_CONFIG_FILE=$cli_config
export TF_DATA_DIR=$work/terraform-data
export HOME=$work
if [[ $EXECUTOR_ACTION != purge ]]; then
  export TF_VAR_project_id=$NODES_PROJECT_ID TF_VAR_region=$NODES_REGION TF_VAR_zone=$NODES_ZONE
  export TF_VAR_slug=$TENANT_SLUG TF_VAR_plan=$PLAN
  export TF_VAR_plan_max_cloud_accounts=${PLAN_MAX_CLOUD_ACCOUNTS-} TF_VAR_plan_max_users=${PLAN_MAX_USERS-}
  export TF_VAR_plan_monthly_gib=${PLAN_MONTHLY_GIB-} TF_VAR_plan_history_days=${PLAN_HISTORY_DAYS-}
  export TF_VAR_node_version=$NODE_VERSION TF_VAR_node_package_sha256=$NODE_PACKAGE_SHA256
  export TF_VAR_web_origin=$WEB_ORIGIN TF_VAR_api_origin=$API_ORIGIN TF_VAR_mail_from=$MAIL_FROM
  export TF_VAR_subnet_cidr=$SUBNET_CIDR TF_VAR_bootstrap_admin_email=$BOOTSTRAP_ADMIN_EMAIL
  export TF_VAR_bootstrap_tenant_name=$BOOTSTRAP_TENANT_NAME TF_VAR_bootstrap_support_email=$BOOTSTRAP_SUPPORT_EMAIL
  export TF_VAR_control_plane_sa=$CP_WORKER_SA TF_VAR_images_repository=$IMAGES_REPOSITORY
fi

# A saída do Terraform vai para o arquivo; numa falha, só as linhas de erro, cortadas.
tf_failed() { # <etapa>
  say "terraform $1 falhou:"
  grep -E '^(│ )?Error: ' "$work/terraform.log" | cut -c1-300 | head -n 10 || true
  finish 4 failed "terraform_${1}_failed"
}
tf() { # <etapa> <subcomando> <argumentos...>
  local stage=$1 subcommand=$2
  shift 2
  "$terraform_bin" -chdir="$tenant_root" "$subcommand" -no-color "$@" >>"$work/terraform.log" 2>&1 || tf_failed "$stage"
}
# Os endereços no estado do cliente, um por linha, em state.txt.
state_list() {
  "$terraform_bin" -chdir="$tenant_root" state list >"$work/state.txt" 2>>"$work/terraform.log" || tf_failed state
}

# O plano salvo em JSON, legível (senão a execução é recusada).
show_plan() {
  if ! "$terraform_bin" -chdir="$tenant_root" show -json "$work/tfplan" >"$work/plan.json" 2>>"$work/terraform.log"; then
    finish 3 refused plan_unreadable
  fi
  if ! jq -e 'has("format_version") and (.resource_changes | type == "array")' "$work/plan.json" >/dev/null 2>&1; then
    finish 3 refused plan_unreadable
  fi
}
plan_summary() {
  local summary
  summary=$(jq -r '[.resource_changes[].change.actions | join("+")] | group_by(.)
    | map("\(.[0])=\(length)") | join(" ")' "$work/plan.json")
  say "plano: ${summary:-nada}"
}

# Uma resposta das APIs que apagam: 2xx feito, 404 já não existia; o resto para a execução com o código.
deleted_or_absent() { # <status> <o que> <código>
  case $1 in
    2?? | 404) ;;
    *)
      say "$2: HTTP $1"
      finish 4 failed "$3"
      ;;
  esac
}

# --- 5a. Exclusão 2 (`purge`): o cofre da chave, o bucket de backups e o estado ----------------------------------------
purge_tenant() {
  local status
  state_list
  if [[ -s $work/state.txt ]]; then
    say "o estado ainda tem $(wc -l <"$work/state.txt") recurso(s): a Exclusão 1 não terminou."
    finish 3 refused state_not_empty
  fi
  status=$(gcp DELETE "$secretmanager_url/projects/$NODES_PROJECT_ID/secrets/vx-$TENANT_SLUG-credentials-key") ||
    finish 4 failed secret_delete_failed
  deleted_or_absent "$status" 'cofre credentials-key' secret_delete_failed
  status=$(gcp DELETE "$storage_api_url/$NODES_PROJECT_ID-vx-$TENANT_SLUG-backups") || finish 4 failed bucket_delete_failed
  if [[ $status == 409 ]]; then
    say 'o bucket de backups ainda tem objetos (a retenção dele ainda não os apagou).'
    finish 4 failed backups_bucket_not_empty
  fi
  deleted_or_absent "$status" 'bucket de backups' bucket_delete_failed
  status=$(gcp DELETE "$storage_api_url/$TFSTATE_BUCKET/o/tenants%2F$TENANT_SLUG%2Fdefault.tfstate") ||
    finish 4 failed state_delete_failed
  deleted_or_absent "$status" 'estado do cliente' state_delete_failed
  finish 0 succeeded purge_done
}

# --- 5b. Exclusão 1 (`destroy`) --------------------------------------------------------------------------------------
# Tira a proteção da VM pela API (sem `apply`: um `apply` com o estado pela metade criaria de novo o que já saiu) e
# espera a operação valer.
unprotect_instance() {
  local url="$compute_url/projects/$NODES_PROJECT_ID/zones/$NODES_ZONE/instances/vx-$TENANT_SLUG" status
  status=$(gcp POST "$url/setDeletionProtection?deletionProtection=false") || finish 4 failed deletion_protection_failed
  [[ $status != 404 ]] || return 0
  deleted_or_absent "$status" 'proteção da VM' deletion_protection_failed
  for _ in $(seq 1 30); do
    status=$(gcp GET "$url") || finish 4 failed deletion_protection_failed
    [[ $status != 404 ]] || return 0
    if [[ $status == 200 ]] && jq -e '.deletionProtection != true' "$work/response.json" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  say 'a proteção da VM não saiu em 1 min.'
  finish 4 failed deletion_protection_failed
}

# O disco (fora do estado: `prevent_destroy`), os snapshots dele (o `KEEP_AUTO_SNAPSHOTS` os manteria para sempre: só
# os de `sourceDisk` igual ao deste disco, conferidos um a um, de todas as páginas) e o IP do NAT (`prevent_destroy`).
cleanup_compute() {
  local project_url="$compute_url/projects/$NODES_PROJECT_ID" status token='' url name count=0
  local disk_url="$project_url/zones/$NODES_ZONE/disks/vx-$TENANT_SLUG"
  local disk_path="/projects/$NODES_PROJECT_ID/zones/$NODES_ZONE/disks/vx-$TENANT_SLUG"
  status=$(gcp DELETE "$disk_url") || finish 4 failed cleanup_failed
  deleted_or_absent "$status" disco cleanup_failed
  for _ in $(seq 1 60); do
    status=$(gcp GET "$disk_url") || finish 4 failed cleanup_failed
    [[ $status == 200 ]] || break
    sleep 5
  done
  if [[ $status != 404 ]]; then
    say "o disco não saiu (HTTP $status)."
    finish 4 failed cleanup_failed
  fi
  : >"$work/snapshots.txt"
  for _ in $(seq 1 50); do
    url="$project_url/global/snapshots?maxResults=500"
    [[ -z $token ]] || url+="&pageToken=$token"
    status=$(gcp GET "$url") || finish 4 failed cleanup_failed
    if [[ $status != 200 ]]; then
      say "snapshots: HTTP $status"
      finish 4 failed cleanup_failed
    fi
    jq -r --arg disk "$disk_path" \
      '.items[]? | select((.sourceDisk // "") | endswith($disk)) | .name' "$work/response.json" \
      >>"$work/snapshots.txt" || finish 4 failed cleanup_failed
    token=$(jq -r '.nextPageToken // ""' "$work/response.json") || finish 4 failed cleanup_failed
    [[ -n $token ]] || break
    [[ $token =~ ^[A-Za-z0-9_=-]{1,2000}$ ]] || finish 4 failed cleanup_failed
  done
  while IFS= read -r name; do
    [[ $name =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || finish 4 failed cleanup_failed
    status=$(gcp DELETE "$project_url/global/snapshots/$name") || finish 4 failed cleanup_failed
    deleted_or_absent "$status" snapshot cleanup_failed
    count=$((count + 1))
  done <"$work/snapshots.txt"
  status=$(gcp DELETE "$project_url/regions/$NODES_REGION/addresses/vx-$TENANT_SLUG-nat-ip") ||
    finish 4 failed cleanup_failed
  deleted_or_absent "$status" 'IP do NAT' cleanup_failed
  say "disco, $count snapshot(s) e IP do NAT apagados"
}

destroy_tenant() {
  local address kept odd
  state_list
  if grep -qxF 'module.node.google_compute_instance.node' "$work/state.txt"; then unprotect_instance; fi
  for address in "${kept_addresses[@]}"; do
    if grep -qxF "$address" "$work/state.txt"; then
      "$terraform_bin" -chdir="$tenant_root" state rm -lock-timeout=5m "$address" >>"$work/terraform.log" 2>&1 ||
        tf_failed state_rm
    fi
  done
  tf plan plan -input=false -lock-timeout=5m -destroy "-out=$work/tfplan"
  show_plan
  # O plano da exclusão só apaga (nada criado nem mudado) e nunca o que acabou de sair do estado.
  kept=$(printf '%s\n' "${kept_addresses[@]}" | jq -R . | jq -s -c .)
  if ! odd=$(jq -r --argjson kept "$kept" '[.resource_changes[]
    | select((.change.actions - ["delete", "no-op", "read"]) != [] or (.address as $a | $kept | index($a)))]
    | length' "$work/plan.json"); then
    finish 3 refused plan_unreadable
  fi
  if ((odd > 0)); then
    say 'o plano da exclusão cria, muda ou apaga o que saiu do estado: recusado.'
    finish 3 refused destroy_plan_unexpected
  fi
  plan_summary
  tf apply apply -input=false -lock-timeout=5m "$work/tfplan"
  cleanup_compute
  finish 0 succeeded destroy_done
}

say "cliente $TENANT_SLUG, execução $RUN_ID ($RUN_KIND, $EXECUTOR_ACTION)"
tf init init -input=false -lockfile=readonly "-backend-config=bucket=$TFSTATE_BUCKET" \
  "-backend-config=prefix=tenants/$TENANT_SLUG"
case $EXECUTOR_ACTION in
  purge) purge_tenant ;;
  destroy) destroy_tenant ;;
esac

# --- 5c. Provisionamento (`apply`): a conta de serviço do nó não é apagada nem recriada -------------------------------
tf plan plan -input=false -lock-timeout=5m "-out=$work/tfplan"
show_plan
if ! sa_changes=$(jq -r --arg address "$node_sa_address" '
  [.resource_changes[] | select(.address == $address or (.address | startswith($address + "[")))
    | .change.actions[] | select(. == "delete" or . == "forget")] | length' "$work/plan.json"); then
  finish 3 refused plan_unreadable
fi
if ((sa_changes > 0)); then
  say "o plano apaga ou recria $node_sa_address: recusado (só a exclusão do cliente pode)."
  finish 3 refused node_sa_replacement
fi
plan_summary

# --- 6. Aplicar e gravar as saídas ----------------------------------------------------------------------------------
tf apply apply -input=false -lock-timeout=5m "$work/tfplan"
if ! "$terraform_bin" -chdir="$tenant_root" output -no-color -json >"$work/outputs.raw.json" 2>>"$work/terraform.log"; then
  finish 4 failed terraform_output_failed
fi
if ! jq -e --argjson allowed "$allowed_outputs" '
  if ([.[] | select(.sensitive == true)] | length) > 0 then error("saída sensível") else . end
  | with_entries(select(.key as $k | $allowed | index($k))) | map_values(.value)' \
  "$work/outputs.raw.json" >"$work/outputs.json" 2>/dev/null; then
  finish 4 failed terraform_output_failed
fi
if ! upload outputs.json; then
  say 'as saídas não chegaram ao bucket do estado.'
  exit 5
fi
finish 0 succeeded apply_done
