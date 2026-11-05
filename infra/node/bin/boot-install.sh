#!/bin/bash
# Instalação sem operador do nó de cliente (PR-N7). Roda como root a cada boot da VM, chamada pelo script de boot do
# módulo do Terraform com `unattended_install` (infra/gcp/modules/node/unattended.sh.tftpl, ligado no envs/tenant). O
# script de boot entrega este arquivo pronto, na memória, junto com o que ele usa para conferir o release: o
# verificador do manifesto (bin/verify-release.sh) e as chaves públicas de release (keys/release-*.pem), todos vindos do
# Terraform, nunca da internet. Uso:
#   boot-install.sh --boot-dir <pasta> --profile lean|standard
# A pasta traz prepare.sh (o script de boot de todo nó do módulo: swap cifrado e ajustes do kernel),
# trust/bin/verify-release.sh e trust/keys/release-*.pem.
#
# Na primeira vez (o nó nunca terminou uma instalação):
#  1. lê dos metadados da VM a versão (`verax-node-version`, node-vX.Y.Z), o SHA-256 do pacote e os campos do node.conf
#     (as chaves `verax-*` do CP-06) e confere cada valor (formato, tamanho e caracteres) antes de qualquer uso;
#  2. baixa do release do GitHub o manifesto e a assinatura, confere a assinatura com o verificador e as chaves que
#     vieram do Terraform e só então lê o manifesto: a versão, o commit, os digests da API e das migrations e o SHA-256
#     do pacote, que tem de ser o mesmo dos metadados;
#  3. baixa o pacote, confere o SHA-256, confere que as imagens de terceiros dos compose são as do manifesto (todas pelo
#     digest), descobre o IP de saída do nó e escreve o node.conf do modo cliente (CUSTOMER_MODE=true);
#  4. com o e-mail do nó nos metadados (`verax-smtp-*`), espera a senha da caixa de envio chegar ao cofre do nó (o plano
#     de controle a grava logo depois do `apply`; o start.sh não sobe sem ela);
#  5. roda o install.sh do pacote conferido, com os digests do manifesto e a versão (--release).
# Em todo boot, depois: espera o nó, o Wazuh e o primeiro acesso do cliente (CP-10) ficarem no ar e o túnel subir (relê
# o cofre do token a cada 60 s por até 60 min) e grava o guest attribute `verax/ready=<versão>`. Uma falha grava
# `verax/error=<código>` (só o código: nenhum valor dos metadados) e sai com erro; o boot seguinte tenta de novo.
#
# Um nó que já terminou a instalação não instala de novo: uma versão diferente nos metadados não é aplicada (a
# atualização continua com o deploy.sh, pelo operador; um atualizador com backup e volta é o SH-06). Nada que vem dos
# metadados ou do manifesto é interpretado pelo shell: cada valor passa por uma expressão regular antes de ir para o
# node.conf, que o install.sh e o start.sh leem com `source`, e nenhum vai para argumento de comando sem aspas.
set -euo pipefail
umask 077
export LC_ALL=C
PATH=${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Onde a instalação lê e escreve (o teste troca estas linhas pelos falsos dele).
metadata_url=http://metadata.google.internal/computeMetadata/v1
release_base=https://github.com/williandotdev/verax-control/releases/download
download_proto='=https'
# O IP de saída, visto pela AWS: é com ele que a AWS confere o `aws:SourceIp` da pilha do papel de leitura.
egress_ip_url=https://checkip.amazonaws.com
etc_dir=/etc/verax
state_dir=/var/lib/verax/boot
node_run=/run/verax
opt_bin=/opt/verax/bin
# Esperas, em segundos: entre tentativas, entre consultas ao systemd, entre leituras do cofre do túnel e do cofre da
# senha do e-mail (60 vezes: 60 min, a exigência do plano de controle) e entre gravações de guest attributes (até 3 por
# segundo e 10 por minuto por VM, somadas às do worker). Os prazos de cada serviço ficam acima do TimeoutStartSec dele.
retry_pause=5
poll_pause=10
tunnel_pause=60
tunnel_tries=60
mail_pause=60
mail_tries=60
attribute_pause=1
node_timeout=1500
wazuh_timeout=2700
customer_timeout=1500

# Formatos (os mesmos do envs/tenant, do install.sh e do node-release.sh).
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
re_project='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
re_prefix='^[a-z][a-z0-9-]{3,18}$'
re_release='^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
re_sha='^[0-9a-f]{64}$'
re_commit='^[0-9a-f]{40}$'
re_label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
re_origin="^https://$re_label(\\.$re_label)+\$"
# O e-mail do remetente sem o apóstrofo que o envs/tenant aceita: o arquivo de ambiente do start.sh (write_env) recusa
# aspa simples, e o nó não subiria com ele.
re_mail='^[A-Za-z0-9_+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$'
# O servidor, a porta e o usuário do e-mail do nó (os do envs/tenant e do plano de controle, `SMTP_*_NODES`): cada um
# vira uma linha do node.conf.
re_smtp_host="^$re_label(\\.$re_label)+\$"
re_smtp_port='^[1-9][0-9]{0,4}$'
re_smtp_user='^[A-Za-z0-9][A-Za-z0-9@._+-]{0,253}$'
re_artifact_registry='^[a-z0-9-]+-docker\.pkg\.dev/[a-z][a-z0-9-]{4,28}[a-z0-9]/[a-z0-9-]{1,63}$'
re_ghcr='^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}$'
re_bucket='^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
re_limit='^[1-9][0-9]{0,5}$'
re_sa_id='^[0-9]{21}$'
# Uma referência de imagem de terceiro: nome (com registro opcional), tag opcional e o digest obrigatório.
re_third_party='^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$'
# O que pode ir para uma linha do node.conf: a última barreira antes do `source` do install.sh e do start.sh.
re_conf_line='^[A-Z][A-Z0-9_]*=[A-Za-z0-9@._+:/,-]*$'

work=''
boot_dir=''
profile=''
manifest_file=''
# A configuração lida dos metadados (read_config) e o que o manifesto conferido diz (fetch_release).
cfg_project='' cfg_prefix='' cfg_release='' cfg_sha='' cfg_images='' cfg_web='' cfg_api='' cfg_mail='' cfg_plan=''
cfg_max_accounts='' cfg_max_users='' cfg_monthly_gib='' cfg_history_days='' cfg_vault='' cfg_bucket='' cfg_sa_id=''
cfg_egress='' cfg_sources='' cfg_smtp_host='' cfg_smtp_port='' cfg_smtp_user=''
rel_commit='' rel_api_digest='' rel_migrate_digest=''

log() { echo "verax-boot: $*"; }

# Guest attribute no espaço `verax/` (o plano de controle lê com getGuestAttributes). Só a versão ou o código de erro,
# nunca um valor dos metadados. 404 num DELETE é um atributo que já não existia.
attribute() { # put <chave> <valor> | delete <chave>
  local method=PUT code args=(-sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Metadata-Flavor: Google')
  if [[ $1 == put ]]; then
    args+=(-X PUT --data-binary "$3")
  else
    method=DELETE
    args+=(-X DELETE)
  fi
  code=$(curl "${args[@]}" "$metadata_url/instance/guest-attributes/verax/$2" 2>/dev/null) || code=000
  sleep "$attribute_pause"
  if [[ $code == 200 || $code == 204 || ($method == DELETE && $code == 404) ]]; then return 0; fi
  log "AVISO: o guest attribute verax/$2 não foi gravado ($method, HTTP $code)." >&2
  return 1
}

# Para tudo com o código no `verax/error` (o plano de controle marca o provisionamento como falho com ele).
fail() { # <código> <mensagem>
  log "ERRO ($1): $2" >&2
  attribute put error "$1" || true
  exit 1
}

# Um valor dos metadados (o caminho depois de computeMetadata/v1/) gravado num arquivo da pasta de trabalho, nunca
# numa linha de comando. Sai com 3 quando a chave não existe (404) e com 1 em qualquer outro erro.
metadata_get() { # <caminho> <arquivo>
  local code attempt
  for attempt in 1 2 3; do
    code=$(curl -sS --max-time 5 --max-filesize 65536 -o "$2" -w '%{http_code}' -H 'Metadata-Flavor: Google' \
      "$metadata_url/$1" 2>/dev/null) || code=000
    case $code in
      200) return 0 ;;
      404) return 3 ;;
    esac
    if ((attempt < 3)); then sleep "$retry_pause"; fi
  done
  return 1
}

# Lê um metadado e confere: até <máximo> bytes, só ASCII visível (nenhuma quebra de linha, controle ou byte fora do
# ASCII) e casando com a expressão; vazio só quando a chave é opcional. O valor vai para a variável pedida (printf -v),
# nunca para um eval. A mensagem diz a chave, nunca o valor.
read_key() { # <variável> <caminho> <expressão> <máximo> [optional]
  local file status=0 value
  file=$work/metadata/${2##*/}
  metadata_get "$2" "$file" || status=$?
  if ((status == 3)); then fail metadata_missing "falta o metadado ${2##*/} na VM (o Terraform do nó o grava)."; fi
  if ((status != 0)); then fail metadata_unavailable "o servidor de metadados não respondeu ao ler ${2##*/}."; fi
  # Contados em bytes: um `$(...)` cortaria a quebra de linha do fim, justamente o que se procura.
  if (($(tr -d '\040-\176' <"$file" | wc -c) > 0 || $(wc -c <"$file") > $4)); then
    fail metadata_invalid "o metadado ${2##*/} tem caractere fora do ASCII visível ou mais de $4 bytes."
  fi
  value=$(<"$file")
  if [[ -z $value && ${5:-} == optional ]]; then
    printf -v "$1" '%s' ''
    return 0
  fi
  [[ $value =~ $3 ]] || fail metadata_invalid "o metadado ${2##*/} está fora do formato."
  printf -v "$1" '%s' "$value"
}

# As entradas do primeiro acesso do cliente (CP-10): o start.sh as lê e confere quando o verax-customer-bootstrap roda.
# Aqui, só que existem e não estão vazias, para a falta aparecer antes da instalação; o conteúdo (nome e e-mails, dado
# pessoal) não é lido para variável nenhuma nem vai para a tela.
require_key() { # <chave>
  local file=$work/metadata/$1 status=0
  metadata_get "instance/attributes/$1" "$file" || status=$?
  if ((status == 3)) || { ((status == 0)) && [[ ! -s $file ]]; }; then
    fail metadata_missing "falta o metadado $1 na VM (o Terraform do nó o grava)."
  fi
  if ((status != 0)); then fail metadata_unavailable "o servidor de metadados não respondeu ao ler $1."; fi
  rm -f "$file"
}

# Baixa um arquivo do release (ou o IP de saída) só por HTTPS, inclusive nos redirecionamentos, com teto de tamanho.
download() { # <url> <arquivo> <máximo em bytes>
  curl -fsSL --proto "$download_proto" --proto-redir "$download_proto" --connect-timeout 20 --max-time 600 \
    --retry 5 --retry-delay "$retry_pause" --retry-all-errors --max-filesize "$3" -o "$2" "$1" 2>"$work/curl.err"
}

# A configuração do nó, dos metadados da VM. Preenche as variáveis cfg_* (conferidas) usadas pelo resto da instalação.
read_config() {
  local contract meta_profile
  install -d -m 0700 "$work/metadata"
  # A versão do contrato dos metadados (modules/node/node.tf): esta instalação conhece só a 1.
  read_key contract instance/attributes/verax-config-version '^1$' 8
  log "Metadados no contrato $contract."
  read_key meta_profile instance/attributes/verax-node-profile '^(lean|standard)$' 16
  [[ $meta_profile == "$profile" ]] ||
    fail metadata_invalid "o perfil dos metadados (verax-node-profile) não é o do script de boot."
  read_key cfg_project project/project-id "$re_project" 30
  read_key cfg_prefix instance/attributes/verax-secret-prefix "$re_prefix" 19
  read_key cfg_release instance/attributes/verax-node-version "$re_release" 24
  read_key cfg_sha instance/attributes/verax-node-package-sha256 "$re_sha" 64
  read_key cfg_images instance/attributes/verax-images-repository "$re_artifact_registry|$re_ghcr" 200
  read_key cfg_web instance/attributes/verax-web-origin "$re_origin" 261
  read_key cfg_api instance/attributes/verax-api-origin "$re_origin" 261
  [[ $cfg_web != "$cfg_api" ]] || fail metadata_invalid "verax-web-origin e verax-api-origin são iguais."
  read_key cfg_mail instance/attributes/verax-mail-from "$re_mail" 254
  if [[ $cfg_mail == .* || $cfg_mail == *..* ]]; then fail metadata_invalid "o metadado verax-mail-from está fora do formato."; fi
  # O e-mail do nó: o servidor, a porta e o usuário, os três ou nenhum (vazios: MAIL_TRANSPORT=none). A senha nunca vem
  # dos metadados: o start.sh a lê do cofre `<prefixo>-smtp-password` na partida.
  read_key cfg_smtp_host instance/attributes/verax-smtp-host "$re_smtp_host" 253 optional
  read_key cfg_smtp_port instance/attributes/verax-smtp-port "$re_smtp_port" 5 optional
  read_key cfg_smtp_user instance/attributes/verax-smtp-user "$re_smtp_user" 254 optional
  if [[ -n $cfg_smtp_host || -n $cfg_smtp_port || -n $cfg_smtp_user ]]; then
    [[ -n $cfg_smtp_host && -n $cfg_smtp_port && -n $cfg_smtp_user ]] ||
      fail metadata_invalid "verax-smtp-host, verax-smtp-port e verax-smtp-user vão juntos (os três ou nenhum)."
    ((10#$cfg_smtp_port <= 65535)) || fail metadata_invalid "o metadado verax-smtp-port está fora do formato."
  fi
  read_key cfg_plan instance/attributes/verax-plan '^(essencial|profissional|enterprise)$' 16
  read_key cfg_max_accounts instance/attributes/verax-plan-max-cloud-accounts "$re_limit" 6 optional
  read_key cfg_max_users instance/attributes/verax-plan-max-users "$re_limit" 6 optional
  read_key cfg_monthly_gib instance/attributes/verax-plan-monthly-gib "$re_limit" 6 optional
  read_key cfg_history_days instance/attributes/verax-plan-history-days "$re_limit" 6 optional
  if [[ $cfg_plan == enterprise ]] &&
    [[ -z $cfg_max_accounts || -z $cfg_max_users || -z $cfg_monthly_gib || -z $cfg_history_days ]]; then
    fail metadata_invalid "o plano enterprise precisa dos quatro limites nos metadados."
  fi
  read_key cfg_vault instance/attributes/verax-credentials-vault '^(true|false)$' 5
  read_key cfg_bucket instance/attributes/verax-backup-bucket "$re_bucket" 63
  read_key cfg_sa_id instance/attributes/verax-node-sa-unique-id "$re_sa_id" 21
  require_key verax-tenant-name
  require_key verax-admin-email
  require_key verax-support-email
}

# O jq lê o manifesto. Não vem na imagem do Debian: entra pelo apt (pacote do Debian, assinado), como o cryptsetup do
# script de boot, com espera pela trava do apt e 5 tentativas.
ensure_jq() {
  local attempt
  command -v jq >/dev/null && return 0
  for attempt in 1 2 3 4 5; do
    if apt-get -o DPkg::Lock::Timeout=300 update -qq &&
      DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq jq >/dev/null; then
      return 0
    fi
    if ((attempt < 5)); then sleep $((retry_pause * 4)); fi
  done
  return 1
}

# As imagens de terceiros que os compose do pacote usam (as do Verax vêm por variável, com o digest do manifesto). Mesma
# leitura do node-release.sh, que monta a lista do manifesto a partir dos mesmos arquivos.
compose_third_party() { # <pasta do pacote>
  local ref
  # shellcheck disable=SC2016 # os padrões são o texto literal do compose
  sed -nE 's/^[[:space:]]*image:[[:space:]]*//p' "$1"/compose*.yaml |
    sed -E 's/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']?[[:space:]]*$//' |
    while IFS= read -r ref; do
      case $ref in
        '${API_IMAGE:?}' | '${MIGRATE_IMAGE:?}') ;;
        *) printf '%s\n' "$ref" ;;
      esac
    done | sort -u
}

# Texto não vazio só de ASCII visível, pelos códigos dos caracteres: no `test()` do jq (Oniguruma), o `$` casa antes
# de uma quebra de linha no fim, e o `$(...)` do shell a cortaria depois.
jq_visible='(type == "string" and length > 0 and all(explode[]; . >= 32 and . < 127))'

# Um campo de texto do manifesto já conferido (vazio se faltar, se não for texto ou se tiver caractere fora do ASCII
# visível).
manifest_field() { # <caminho do jq>
  jq -er "$1 | select($jq_visible)" "$manifest_file" 2>/dev/null || echo ''
}

# Baixa o release da versão dos metadados, confere tudo e deixa o pacote pronto em $work/package/verax-node.
# Preenche rel_commit, rel_api_digest e rel_migrate_digest.
fetch_release() {
  local dir=$work/release base=$release_base/$cfg_release status=0 api_ref migrate_ref package
  install -d -m 0700 "$dir" "$work/package"
  log "Baixando o manifesto de $cfg_release."
  if ! download "$base/manifest.json" "$dir/manifest.json" 65536 ||
    ! download "$base/manifest.json.sig" "$dir/manifest.json.sig" 1024; then
    fail release_download_failed "o manifesto ou a assinatura de $cfg_release não baixaram: $(head -c 300 "$work/curl.err")"
  fi

  # A assinatura antes de qualquer leitura do manifesto, com o verificador e as chaves que vieram do Terraform.
  bash "$boot_dir/trust/bin/verify-release.sh" "$dir/manifest.json" "$dir/manifest.json.sig" "$boot_dir/trust/keys" \
    >"$work/verify.out" 2>&1 || status=$?
  case $status in
    0) log "Assinatura do manifesto conferida ($(head -c 200 "$work/verify.out"))." ;;
    1) fail release_signature_invalid "a assinatura do manifesto de $cfg_release não fecha com as chaves de release." ;;
    *) fail release_verifier_failed "o verificador do manifesto falhou: $(head -c 300 "$work/verify.out")" ;;
  esac

  # Só a cópia conferida, numa pasta só da instalação. Cada campo com o tipo e o formato esperados.
  manifest_file=$dir/manifest.json
  jq -e ".schema == 1 and .kind == \"verax-node-release\"
    and (.thirdPartyImages | type == \"array\" and length > 0 and all(.[]; $jq_visible))" \
    "$manifest_file" >/dev/null 2>&1 || fail release_manifest_invalid "o manifesto de $cfg_release está fora do formato."
  [[ $(manifest_field .release) == "$cfg_release" ]] ||
    fail release_manifest_invalid "o manifesto baixado não é o de $cfg_release."
  rel_commit=$(manifest_field .version)
  [[ $rel_commit =~ $re_commit ]] || fail release_manifest_invalid "o manifesto de $cfg_release não traz o commit."
  [[ $(manifest_field .package.url) == "$base/verax-node.tar.gz" ]] ||
    fail release_manifest_invalid "o pacote do manifesto não é o do release $cfg_release."
  [[ $(manifest_field .package.sha256) == "$cfg_sha" ]] ||
    fail package_sha256_mismatch "o SHA-256 do pacote nos metadados não é o do manifesto assinado de $cfg_release."
  api_ref=$(manifest_field .images.api)
  migrate_ref=$(manifest_field .images.migrate)
  [[ $api_ref =~ ^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}/api@(sha256:[0-9a-f]{64})$ ]] ||
    fail release_manifest_invalid "a imagem da API no manifesto não está fixada pelo digest."
  rel_api_digest=${BASH_REMATCH[1]}
  [[ $migrate_ref =~ ^ghcr\.io/[a-z0-9-]{1,39}/[a-z0-9._-]{1,100}/migrate@(sha256:[0-9a-f]{64})$ ]] ||
    fail release_manifest_invalid "a imagem das migrations no manifesto não está fixada pelo digest."
  rel_migrate_digest=${BASH_REMATCH[1]}
  # Do GHCR, só o repositório do próprio manifesto.
  if [[ $cfg_images == ghcr.io/* && $api_ref != "$cfg_images/api@"* ]]; then
    fail metadata_invalid "verax-images-repository aponta para outro repositório do GHCR que não o do manifesto."
  fi

  log "Baixando o pacote de $cfg_release."
  package=$dir/verax-node.tar.gz
  download "$base/verax-node.tar.gz" "$package" 67108864 ||
    fail release_download_failed "o pacote de $cfg_release não baixou: $(head -c 300 "$work/curl.err")"
  [[ $(sha256sum "$package" | cut -d' ' -f1) == "$cfg_sha" ]] ||
    fail package_sha256_mismatch "o pacote baixado não tem o SHA-256 do manifesto assinado de $cfg_release."

  # Conferido o hash, o conteúdo é o do release. Ainda assim, só nomes dentro de verax-node/.
  tar -tzf "$package" >"$work/package.list" 2>/dev/null || fail package_invalid "o pacote de $cfg_release não abre."
  if grep -qvE '^verax-node(/[A-Za-z0-9._-]+)*/?$' "$work/package.list" ||
    grep -qE '(^|/)\.\.?(/|$)' "$work/package.list"; then
    fail package_invalid "o pacote de $cfg_release tem caminho fora de verax-node/."
  fi
  tar -xzf "$package" -C "$work/package" --no-same-owner || fail package_invalid "o pacote de $cfg_release não abre."
  [[ -f $work/package/verax-node/bin/install.sh ]] || fail package_invalid "o pacote de $cfg_release não tem o install.sh."

  # Toda imagem de terceiro dos compose é uma do manifesto, pelo digest, e vice-versa.
  compose_third_party "$work/package/verax-node" >"$work/compose-images" ||
    fail package_invalid "os compose do pacote não abrem."
  jq -r '.thirdPartyImages[]' "$manifest_file" | sort -u >"$work/manifest-images"
  if grep -qvE "$re_third_party" "$work/compose-images" ||
    ! cmp -s "$work/compose-images" "$work/manifest-images"; then
    fail package_invalid "as imagens de terceiros dos compose não são as do manifesto, todas pelo digest."
  fi
}

# O IP de saída do nó (o IP fixo do Cloud NAT, no standard), como a AWS o vê: é o que a pilha do papel de leitura do
# cliente libera (NodeEgressIps) e o que as regras do Wazuh comparam. O CP-06 o deixou fora dos metadados.
discover_egress_ip() {
  local file=$work/egress-ip ip
  download "$egress_ip_url" "$file" 64 || return 1
  ip=$(tr -d '\r\n' <"$file")
  [[ $ip =~ ^$octet(\.$octet){3}$ ]] || return 1
  cfg_egress="$ip/32"
}

# O node.conf do nó de cliente: só valores conferidos acima, e cada linha passa de novo pelo formato antes de ir para
# o arquivo (que o install.sh e o start.sh leem com `source`).
write_node_conf() { # <arquivo>
  local line lines=(
    "VERAX_GCP_PROJECT=$cfg_project"
    "VERAX_SECRET_PREFIX=$cfg_prefix"
    "IMAGES_REPOSITORY=$cfg_images"
    "WEB_ORIGIN=$cfg_web"
    "API_ORIGIN=$cfg_api"
  )
  # O e-mail do nó: com o servidor nos metadados, SMTP (o plano de controle grava a senha no cofre smtp-password do nó,
  # e o start.sh a lê de lá); sem ele, nenhum (contas com senha temporária, avisos por e-mail pulados), como antes.
  if [[ -n $cfg_smtp_host ]]; then
    lines+=("MAIL_TRANSPORT=smtp" "MAIL_FROM=$cfg_mail" "SMTP_HOST=$cfg_smtp_host" "SMTP_PORT=$cfg_smtp_port"
      "SMTP_USER=$cfg_smtp_user")
  else
    lines+=("MAIL_TRANSPORT=none" "MAIL_FROM=$cfg_mail")
  fi
  lines+=(
    "SYNC_SOURCES=$cfg_sources"
    "BACKUP_BUCKET=$cfg_bucket"
    "PLAN=$cfg_plan"
  )
  if [[ -n $cfg_max_accounts ]]; then lines+=("PLAN_MAX_CLOUD_ACCOUNTS=$cfg_max_accounts"); fi
  if [[ -n $cfg_max_users ]]; then lines+=("PLAN_MAX_USERS=$cfg_max_users"); fi
  if [[ -n $cfg_monthly_gib ]]; then lines+=("PLAN_MONTHLY_GIB=$cfg_monthly_gib"); fi
  if [[ -n $cfg_history_days ]]; then lines+=("PLAN_HISTORY_DAYS=$cfg_history_days"); fi
  lines+=(
    "NODE_PROFILE=$profile"
    "NODE_EGRESS_IPS=$cfg_egress"
    "NODE_SA_UNIQUE_ID=$cfg_sa_id"
    "CREDENTIALS_VAULT=$cfg_vault"
    "WAZUH_AGENTS=false"
    "CUSTOMER_MODE=true"
  )
  {
    echo "# Escrito pela instalação sem operador (boot-install.sh) a partir dos metadados da VM, no release $cfg_release."
    echo '# A atualização é pelo deploy.sh, com este mesmo arquivo.'
  } >"$1"
  for line in "${lines[@]}"; do
    [[ $line =~ $re_conf_line ]] || fail metadata_invalid "uma linha do node.conf saiu fora do formato (${line%%=*})."
    printf '%s\n' "$line" >>"$1"
  done
}

# A senha da caixa de envio, com o e-mail do nó ligado: o start.sh a lê do cofre `<prefixo>-smtp-password` em toda
# partida e não sobe sem ela. O plano de controle a grava logo depois do `apply` (o passo `secrets.smtp_password`),
# minutos depois de a VM nascer: a instalação espera a primeira versão (a cada 60 s, por até 60 min) antes de subir o
# nó. Só confere que a versão `latest` abre, com a identidade da VM e o gcloud do Debian, como o start.sh; o gcloud
# imprime só o nome da versão (`--format`), que vai para /dev/null: a senha não passa pela saída daqui.
wait_mail_password() {
  local try status
  for ((try = 1; try <= mail_tries; try++)); do
    status=0
    gcloud secrets versions access latest --project "$cfg_project" --secret "$cfg_prefix-smtp-password" \
      --format='value(name)' >/dev/null 2>"$work/mail.err" || status=$?
    if ((status == 0)); then
      log 'Senha da caixa de envio no cofre.'
      return 0
    fi
    if ((try == 1)); then log 'Esperando a senha da caixa de envio chegar ao cofre (a cada minuto).'; fi
    if ! grep -q 'NOT_FOUND' "$work/mail.err"; then
      log "AVISO: a leitura do cofre da senha da caixa de envio falhou (saída $status); tentando de novo." >&2
      head -c 2000 "$work/mail.err" | sed 's/^/  /' >&2
    fi
    if ((try < mail_tries)); then sleep "$mail_pause"; fi
  done
  return 1
}

# A primeira instalação (ou a que parou no meio: o marcador `installing` fica até o install.sh terminar).
install_release() {
  local conf=$work/node.conf
  read_config
  ensure_jq || fail dependencies_failed "o jq não instalou pelo apt (rede ou trava do apt)."
  printf '%s\n' "$cfg_release" >"$state_dir/installing"
  fetch_release
  cfg_egress=''
  if [[ $profile == standard ]]; then
    discover_egress_ip || fail egress_ip_unknown "o IP de saída do nó não foi descoberto."
  fi
  # Fontes do worker: a GCP sempre; no standard, as contas AWS pelo Wazuh do nó; com o cofre, o Cloudflare.
  cfg_sources=gcp
  if [[ $profile == standard ]]; then cfg_sources+=,wazuh; fi
  if [[ $cfg_vault == true ]]; then cfg_sources+=,cloudflare; fi
  write_node_conf "$conf"
  if [[ -n $cfg_smtp_host ]]; then
    wait_mail_password ||
      fail smtp_password_missing "a senha da caixa de envio não chegou ao cofre $cfg_prefix-smtp-password em 60 minutos."
  fi

  log "Instalando $cfg_release (commit $rel_commit)."
  # O apt do install.sh espera a trava (o apt-daily do primeiro boot) em vez de falhar; só nesta execução.
  printf 'DPkg::Lock::Timeout "600";\n' >"$work/apt.conf"
  if ! APT_CONFIG=$work/apt.conf DEBIAN_FRONTEND=noninteractive bash "$work/package/verax-node/bin/install.sh" \
    --version "$rel_commit" --api-digest "$rel_api_digest" --migrate-digest "$rel_migrate_digest" \
    --release "$cfg_release" --config "$conf"; then
    # O install.sh para no primeiro erro; o serviço que falhou diz mais que "a instalação falhou".
    if [[ $(unit_state verax-node.service) == failed ]]; then fail node_start_failed "o verax-node não subiu."; fi
    if [[ $(unit_state verax-wazuh.service) == failed ]]; then fail wazuh_start_failed "o verax-wazuh não subiu."; fi
    fail install_failed "o install.sh de $cfg_release falhou (o motivo está logo acima)."
  fi
  printf '%s\n' "$cfg_release" >"$state_dir/installed.tmp"
  mv -f "$state_dir/installed.tmp" "$state_dir/installed"
  rm -f "$state_dir/installing"
}

# A versão instalada, do /etc/verax/images.env que o install.sh grava: a do release (NODE_RELEASE) quando o pacote veio
# de um release; o commit (NODE_VERSION) depois de uma atualização pelo deploy.sh, que não tem release.
installed_version() {
  local file=$etc_dir/images.env commit release
  [[ -f $file ]] || return 1
  commit=$(sed -n 's/^NODE_VERSION=//p' "$file" | tail -n 1)
  release=$(sed -n 's/^NODE_RELEASE=//p' "$file" | tail -n 1)
  [[ $commit =~ $re_commit ]] || return 1
  if [[ $release =~ $re_release ]]; then printf '%s' "$release"; else printf '%s' "$commit"; fi
}

unit_state() { systemctl show -p ActiveState --value "$1" 2>/dev/null || echo unknown; }

# Espera um serviço do nó ficar ativo. O boot (ou o install.sh, na primeira vez) já o pôs para subir: aqui ninguém o
# liga de novo. `failed` é o fim (no primeiro acesso do cliente, depois das dez partidas do Restart=on-failure).
wait_unit() { # <unidade> <prazo em segundos>
  local deadline=$((SECONDS + $2)) state
  while :; do
    state=$(unit_state "$1")
    case $state in
      active) return 0 ;;
      failed) return 1 ;;
    esac
    if ((SECONDS >= deadline)); then return 1; fi
    sleep "$poll_pause"
  done
}

# O túnel: com o token no cofre, o `start.sh up` já subiu o cloudflared. Sem ele (o plano de controle grava o token
# minutos depois de a VM nascer), relê o cofre a cada 60 s por até 60 min com o `start.sh tunnel`, que sai com 3
# enquanto o cofre não tem valor.
wait_tunnel() {
  local try status
  if [[ -s $node_run/cloudflared.env ]]; then return 0; fi
  log 'O nó subiu sem o token do túnel: relendo o cofre a cada minuto.'
  for ((try = 1; try <= tunnel_tries; try++)); do
    status=0
    "$opt_bin/start.sh" tunnel >"$work/tunnel.out" 2>&1 || status=$?
    case $status in
      0)
        log 'Túnel no ar.'
        return 0
        ;;
      3) ;;
      *)
        log "AVISO: a leitura do cofre do túnel falhou (saída $status); tentando de novo." >&2
        head -c 2000 "$work/tunnel.out" | sed 's/^/  /' >&2
        ;;
    esac
    if ((try < tunnel_tries)); then sleep "$tunnel_pause"; fi
  done
  return 1
}

main() {
  while (($#)); do
    case $1 in
      --boot-dir) boot_dir=${2:-}; shift 2 ;;
      --profile) profile=${2:-}; shift 2 ;;
      *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
    esac
  done
  [[ -d $boot_dir && -f $boot_dir/prepare.sh && -f $boot_dir/trust/bin/verify-release.sh ]] ||
    { echo 'Uso: boot-install.sh --boot-dir <pasta do script de boot> --profile lean|standard' >&2; exit 2; }
  [[ $profile =~ ^(lean|standard)$ ]] || { echo "Perfil inválido: $profile" >&2; exit 2; }
  work=$(mktemp -d "$boot_dir/work.XXXXXX")
  trap 'rm -rf "$work"' EXIT

  # O estado de antes não vale para este boot: o plano de controle só vê `ready` de novo quando o nó estiver no ar.
  attribute delete ready || true
  attribute delete error || true

  log 'Preparando a VM (swap cifrado e ajustes do kernel).'
  bash "$boot_dir/prepare.sh" || fail prepare_failed "a preparação da VM falhou (o motivo está logo acima)."

  install -d -m 0700 "$state_dir"
  local version desired=''
  if [[ -f $state_dir/installed ]]; then
    # Instalado. Uma versão nova nos metadados não é aplicada sozinha: a atualização é pelo deploy.sh.
    version=$(installed_version) || fail install_state_invalid "o $etc_dir/images.env da instalação sumiu ou mudou de formato."
    if metadata_get instance/attributes/verax-node-version "$work/desired"; then desired=$(head -c 64 "$work/desired"); fi
    if [[ $desired =~ $re_release && $desired != "$version" ]]; then
      log "Os metadados pedem $desired e o nó está em $version: a atualização não é automática (deploy.sh)."
    fi
  elif [[ ! -f $state_dir/installing && -f $etc_dir/images.env ]]; then
    log 'Nó instalado pelo deploy.sh: a instalação sem operador não mexe nele.'
  else
    install_release
  fi
  version=$(installed_version) || fail install_state_invalid "o $etc_dir/images.env da instalação sumiu ou mudou de formato."

  log 'Esperando o nó subir.'
  wait_unit verax-node.service "$node_timeout" || fail node_start_failed "o verax-node não subiu."
  if [[ $profile == standard ]]; then
    wait_unit verax-wazuh.service "$wazuh_timeout" || fail wazuh_start_failed "o verax-wazuh não subiu."
  fi
  if grep -qx 'CUSTOMER_MODE=true' "$etc_dir/node.conf" 2>/dev/null; then
    wait_unit verax-customer-bootstrap.service "$customer_timeout" ||
      fail customer_bootstrap_failed "o primeiro acesso do cliente (verax-customer-bootstrap) falhou."
  fi
  wait_tunnel || fail tunnel_token_missing "o token do túnel não chegou ao cofre em 60 minutos."

  attribute put ready "$version" || exit 1
  log "Nó pronto na versão $version."
}

main "$@"
