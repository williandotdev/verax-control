#!/bin/bash
# Instala ou atualiza o nó do Verax Control numa VM Debian 12. Roda como root, de dentro da pasta do pacote
# (infra/node copiada para a VM pelo deploy.sh). Pode rodar de novo: o que já existe (dados, certificados, senhas)
# fica como está.
#   install.sh --version <commit> --api-digest <sha256:...> --migrate-digest <sha256:...> [--config <node.conf>]
# Os digests chegam já conferidos pelo deploy.sh (atestação de origem do workflow Imagens do nó, na main): a VM não
# confia em tag do registro, só no conteúdo exato (o digest é o hash da imagem).
# --config  configuração do nó (só na primeira vez; depois fica em /etc/verax/node.conf)
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")/.." && pwd)
version=''
api_digest=''
migrate_digest=''
config=''
while (($#)); do
  case $1 in
    --version) version=$2; shift 2 ;;
    --api-digest) api_digest=$2; shift 2 ;;
    --migrate-digest) migrate_digest=$2; shift 2 ;;
    --config) config=$2; shift 2 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ $version =~ ^[0-9a-f]{40}$ ]] || { echo 'Informe --version com o commit (40 caracteres hexadecimais).' >&2; exit 2; }
[[ $api_digest =~ ^sha256:[0-9a-f]{64}$ && $migrate_digest =~ ^sha256:[0-9a-f]{64}$ ]] ||
  { echo 'Informe --api-digest e --migrate-digest (sha256:...), conferidos pelo deploy.sh.' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Rode como root.' >&2; exit 2; }

echo '== Docker Engine (repositório oficial, chave conferida)'
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  # Impressão digital publicada pela Docker para a chave de assinatura do repositório apt.
  docker_key=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.asc
  got=$(gpg --show-keys --with-colons /tmp/docker.asc | awk -F: '/^fpr:/ { print $10; exit }')
  [[ $got == "$docker_key" ]] || { echo "Chave do repositório da Docker inesperada: $got" >&2; exit 1; }
  gpg --dearmor </tmp/docker.asc >/etc/apt/keyrings/docker.gpg
  chmod 0644 /etc/apt/keyrings/docker.gpg
  rm -f /tmp/docker.asc
  # shellcheck source=/dev/null
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $codename stable" \
    >/etc/apt/sources.list.d/docker.list
  chmod 0644 /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null

echo '== Configuração e arquivos do pacote'
install -d -m 0750 /etc/verax /opt/verax /opt/verax/bin
if [[ -n $config ]]; then
  install -m 0640 "$config" /etc/verax/node.conf
fi
[[ -f /etc/verax/node.conf ]] || { echo 'Falta a configuração: rode com --config <node.conf>.' >&2; exit 2; }
# Um node.conf salvo no Windows chega com CRLF; o \r grudaria em cada valor.
sed -i 's/\r$//' /etc/verax/node.conf
# shellcheck source=/dev/null
source /etc/verax/node.conf
required=(VERAX_GCP_PROJECT VERAX_SECRET_PREFIX IMAGES_REPOSITORY WEB_ORIGIN API_ORIGIN MAIL_FROM SYNC_SOURCES BACKUP_BUCKET
  PLAN)
# E-mail opcional (MAIL_TRANSPORT=none por padrão): com smtp, os dados da caixa de envio passam a ser obrigatórios.
if [[ ${MAIL_TRANSPORT:-none} == smtp ]]; then required+=(SMTP_HOST SMTP_PORT SMTP_USER); fi
# Plano enterprise: os quatro ajustes são obrigatórios (não há padrão).
if [[ ${PLAN:-} == enterprise ]]; then
  required+=(PLAN_MAX_CLOUD_ACCOUNTS PLAN_MAX_USERS PLAN_MONTHLY_GIB PLAN_HISTORY_DAYS)
fi
for key in "${required[@]}"; do
  [[ -n ${!key:-} ]] || { echo "Falta $key em /etc/verax/node.conf." >&2; exit 2; }
done
# Plano do nó (o da Verax é `interno`). A API e o worker conferem tudo de novo na partida, inclusive a faixa de cada
# ajuste; aqui, só o nome do plano, para o erro mais comum aparecer antes de reiniciar o serviço.
[[ $PLAN =~ ^(essencial|profissional|enterprise|interno)$ ]] ||
  { echo 'PLAN inválido em /etc/verax/node.conf: use essencial, profissional, enterprise ou interno.' >&2; exit 2; }
# Perfil do nó: lean (o da Verax) ou standard (nó de cliente). Sem a linha, vale lean: o nó da Verax, instalado antes do
# perfil, sobe com a mesma memória de antes sem mudar o node.conf. O start.sh escreve os limites de cada perfil.
[[ ${NODE_PROFILE:-lean} =~ ^(lean|standard)$ ]] ||
  { echo 'NODE_PROFILE inválido em /etc/verax/node.conf: use lean ou standard.' >&2; exit 2; }
# Projeto do nó e prefixo dos cofres: o start.sh monta com eles o tópico do sink de projeto de cliente que o painel
# mostra (GCP_SINK_TOPIC_PREFIX), e a API só o aceita no formato do Terraform do nó. As regras são as do módulo
# (project_id e name_prefix em infra/gcp/modules/node/variables.tf) e a do deploy.sh; um teste da API confere as três.
[[ $VERAX_GCP_PROJECT =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] ||
  { echo 'VERAX_GCP_PROJECT inválido em /etc/verax/node.conf: use o ID do projeto (6 a 30 caracteres, minúsculas, números e hífen).' >&2; exit 2; }
[[ $VERAX_SECRET_PREFIX =~ ^[a-z][a-z0-9-]{3,18}$ ]] ||
  { echo 'VERAX_SECRET_PREFIX inválido em /etc/verax/node.conf: use o name_prefix do Terraform do nó (4 a 19 caracteres: minúsculas, números e hífen, começando com letra).' >&2; exit 2; }
# IP de saída do nó (o IP fixo do Cloud NAT), que a política IAM da AWS do cliente libera: um ou mais IPv4 com /32,
# separados por vírgula. Opcional até a chave da AWS chegar ao painel; quando presente, o formato é conferido aqui.
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
egress_ip="$octet(\\.$octet){3}/32"
if [[ -n ${NODE_EGRESS_IPS:-} && ! $NODE_EGRESS_IPS =~ ^$egress_ip(,$egress_ip)*$ ]]; then
  echo 'NODE_EGRESS_IPS inválido em /etc/verax/node.conf: use IPv4 com /32, separados por vírgula.' >&2
  exit 2
fi
# Cofre de credenciais (a chave da AWS e o token do Cloudflare colados no painel): true só no nó com o segredo
# `credentials-key` (`credentials_vault` no Terraform). Sem a linha, vale false: o nó da Verax não muda.
[[ ${CREDENTIALS_VAULT:-false} =~ ^(true|false)$ ]] ||
  { echo 'CREDENTIALS_VAULT inválido em /etc/verax/node.conf: use true ou false.' >&2; exit 2; }
install -m 0640 "$here/compose.yaml" /opt/verax/compose.yaml
# O complemento do cofre de credenciais fica instalado sempre; o start.sh só o usa com CREDENTIALS_VAULT=true.
install -m 0640 "$here/compose.vault.yaml" /opt/verax/compose.vault.yaml
install -m 0644 "$here/pg_hba.conf" /opt/verax/pg_hba.conf
install -m 0750 "$here/bin/start.sh" "$here/bin/backup.sh" /opt/verax/bin/
install -m 0644 "$here"/systemd/*.service "$here"/systemd/*.timer /etc/systemd/system/

echo '== Pastas de dados'
install -d -m 0750 /var/lib/verax
install -d -m 0700 /var/lib/verax/secrets /var/lib/verax/backups /var/lib/verax/tls
# Dono do PostgreSQL na imagem Alpine (uid 70).
install -d -m 0700 -o 70 -g 70 /var/lib/verax/postgres

echo '== CA e certificado do banco (só na primeira vez)'
tls=/var/lib/verax/tls
if [[ ! -f $tls/server.crt ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=Verax Control - CA do no' \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey rsa:3072 -nodes -subj '/CN=postgres' -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\n' >"$tls/san.ext"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 3650 \
    -extfile "$tls/san.ext" -out "$tls/server.crt" 2>/dev/null
  # A chave da CA não fica no nó: com ela, quem tivesse o disco poderia emitir outro certificado para o banco.
  rm -f "$tls/ca.key" "$tls/server.csr" "$tls/san.ext" "$tls/ca.srl"
fi
chown 70:70 "$tls/server.key" "$tls/server.crt"
chmod 0600 "$tls/server.key"
chmod 0644 "$tls/server.crt" "$tls/ca.crt"
chmod 0755 "$tls"

echo '== Senhas e chaves internas (só na primeira vez)'
generate() { # <arquivo> <tamanho>
  local file=/var/lib/verax/secrets/$1
  [[ -s $file ]] || head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$2" >"$file"
  chmod 0600 "$file"
}
generate postgres-master 40
generate postgres-migrator 40
generate postgres-app 40
generate better-auth-secret 48
generate csrf-secret 48

# A chave do cofre de credenciais nasce aqui, na VM, só com CREDENTIALS_VAULT=true. O par RSA-3072 vai por pipe direto
# do openssl para o Secret Manager: a chave privada não passa pelo disco nem por variável, e nunca sai da GCP. A VM só
# acrescenta versões nesse segredo (secretVersionAdder) e lê as dele (secretAccessor). A versão 1 decide: sem ela
# (NOT_FOUND), o cofre nunca teve chave e uma nasce agora; com ela (ativa, desativada ou destruída), nada muda, porque
# trocar a chave é uma versão nova feita de propósito.
if [[ ${CREDENTIALS_VAULT:-false} == true ]]; then
  echo '== Chave do cofre de credenciais (só na primeira vez)'
  vault_secret=$VERAX_SECRET_PREFIX-credentials-key
  vault_errors=$(mktemp)
  vault_status=0
  gcloud secrets versions access 1 --project "$VERAX_GCP_PROJECT" --secret "$vault_secret" --format='value(name)' \
    >/dev/null 2>"$vault_errors" || vault_status=$?
  if ((vault_status == 0)) || grep -q 'FAILED_PRECONDITION' "$vault_errors"; then
    echo "O cofre $vault_secret já tem chave."
  elif grep -q 'NOT_FOUND' "$vault_errors"; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 2>/dev/null |
      gcloud secrets versions add "$vault_secret" --project "$VERAX_GCP_PROJECT" --data-file=- >/dev/null
    echo "Chave nova (RSA-3072) gravada no cofre $vault_secret."
  else
    echo "Falha ao ler o cofre $vault_secret no Secret Manager (ele existe? confira credentials_vault no Terraform):" >&2
    sed 's/^/  /' "$vault_errors" >&2
    rm -f "$vault_errors"
    exit 1
  fi
  rm -f "$vault_errors"
fi

echo '== Imagens (pelo digest conferido)'
# O Docker baixa do registro com a identidade da VM (só leitura).
gcloud auth configure-docker "${IMAGES_REPOSITORY%%/*}" --quiet >/dev/null 2>&1
{
  echo "API_IMAGE=$IMAGES_REPOSITORY/api@$api_digest"
  echo "MIGRATE_IMAGE=$IMAGES_REPOSITORY/migrate@$migrate_digest"
  echo "NODE_VERSION=$version"
} >/etc/verax/images.env
chmod 0640 /etc/verax/images.env

echo '== Serviço e backup diário'
systemctl daemon-reload
systemctl enable verax-node.service verax-backup.timer >/dev/null
systemctl restart verax-node.service
systemctl start verax-backup.timer
systemctl --no-pager --lines=0 status verax-node.service || true
if [[ ! -s /run/verax/cloudflared.env ]]; then
  echo 'AVISO: o nó subiu sem o túnel do Cloudflare (o cofre do token ainda não tem valor). Grave o token e rode:' \
    'sudo systemctl restart verax-node'
fi
echo "Nó na versão $version."
