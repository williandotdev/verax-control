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
# shellcheck source=/dev/null
source /etc/verax/node.conf
for key in VERAX_GCP_PROJECT VERAX_SECRET_PREFIX IMAGES_REPOSITORY WEB_ORIGIN API_ORIGIN MAIL_FROM SMTP_HOST SMTP_PORT \
  SMTP_USER SYNC_SOURCES BACKUP_BUCKET; do
  [[ -n ${!key:-} ]] || { echo "Falta $key em /etc/verax/node.conf." >&2; exit 2; }
done
install -m 0640 "$here/compose.yaml" /opt/verax/compose.yaml
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
echo "Nó na versão $version."
