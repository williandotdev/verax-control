#!/bin/bash
# Instala ou atualiza o nó do Verax Control numa VM Debian 12. Roda como root, de dentro da pasta do pacote
# (infra/node copiada para a VM pelo deploy.sh). Pode rodar de novo: o que já existe (dados, certificados, senhas)
# fica como está.
#   install.sh --version <commit> --api-digest <sha256:...> --migrate-digest <sha256:...> [--config <node.conf>]
#              [--release node-vX.Y.Z]
# Os digests chegam já conferidos pelo deploy.sh (atestação de origem do workflow Imagens do nó, na main) ou pela
# instalação sem operador (boot-install.sh: o manifesto assinado da versão): a VM não confia em tag do registro, só no
# conteúdo exato (o digest é o hash da imagem).
# --config   configuração do nó (só na primeira vez; depois fica em /etc/verax/node.conf)
# --release  a versão do release do GitHub de onde o pacote veio (a instalação sem operador). Vai para o images.env como
#            NODE_RELEASE, ao lado do commit (NODE_VERSION). O deploy.sh não passa: sem ela, o images.env é o de sempre.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")/.." && pwd)
version=''
api_digest=''
migrate_digest=''
config=''
release=''
while (($#)); do
  case $1 in
    --version) version=$2; shift 2 ;;
    --api-digest) api_digest=$2; shift 2 ;;
    --migrate-digest) migrate_digest=$2; shift 2 ;;
    --config) config=$2; shift 2 ;;
    --release) release=$2; shift 2 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ $version =~ ^[0-9a-f]{40}$ ]] || { echo 'Informe --version com o commit (40 caracteres hexadecimais).' >&2; exit 2; }
[[ $api_digest =~ ^sha256:[0-9a-f]{64}$ && $migrate_digest =~ ^sha256:[0-9a-f]{64}$ ]] ||
  { echo 'Informe --api-digest e --migrate-digest (sha256:...), conferidos pelo deploy.sh.' >&2; exit 2; }
# O formato das tags do workflow Versão do nó (scripts/node-release.sh).
if [[ -n $release && ! $release =~ ^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$ ]]; then
  echo 'Informe --release no formato node-vX.Y.Z.' >&2
  exit 2
fi
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
# IP de saída do nó (o IP fixo do Cloud NAT), que o papel de leitura da AWS do cliente libera: um ou mais IPv4 com /32,
# separados por vírgula. Opcional (o nó da Verax não tem); quando presente, o formato é conferido aqui.
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
egress_ip="$octet(\\.$octet){3}/32"
if [[ -n ${NODE_EGRESS_IPS:-} && ! $NODE_EGRESS_IPS =~ ^$egress_ip(,$egress_ip)*$ ]]; then
  echo 'NODE_EGRESS_IPS inválido em /etc/verax/node.conf: use IPv4 com /32, separados por vírgula.' >&2
  exit 2
fi
# Papel de leitura sem chave da AWS (opcionais): o ID único da conta de serviço do nó (21 dígitos) e o audience do token
# (https, host em minúsculas, caminho sem curinga), as mesmas regras do template (`NodeServiceAccountId` e `Audience`) e
# da API.
if [[ -n ${NODE_SA_UNIQUE_ID:-} && ! $NODE_SA_UNIQUE_ID =~ ^[0-9]{21}$ ]]; then
  echo 'NODE_SA_UNIQUE_ID inválido em /etc/verax/node.conf: use o ID único da conta de serviço do nó (21 dígitos).' >&2
  exit 2
fi
audience_pattern='^https://[a-z0-9.-]+(/[A-Za-z0-9._-]+)*$'
if [[ -n ${AWS_WEB_IDENTITY_AUDIENCE:-} ]] &&
  { ((${#AWS_WEB_IDENTITY_AUDIENCE} > 256)) || [[ ! $AWS_WEB_IDENTITY_AUDIENCE =~ $audience_pattern ]]; }; then
  echo 'AWS_WEB_IDENTITY_AUDIENCE inválido em /etc/verax/node.conf: use https://<host>[/<caminho>], sem curinga.' >&2
  exit 2
fi
# Chave do site do Cloudflare Turnstile (opcional; liga o desafio no login do painel). Um dígito, `x` e de 20 a 40
# caracteres, como a API confere (`TURNSTILE_SITE_KEY_PATTERN`). A chave secreta fica no cofre, lida pelo start.sh.
if [[ -n ${TURNSTILE_SITE_KEY:-} && ! $TURNSTILE_SITE_KEY =~ ^[0-9]x[0-9A-Za-z_-]{20,40}$ ]]; then
  echo 'TURNSTILE_SITE_KEY inválida em /etc/verax/node.conf: use a chave do site do widget (ex.: 0x4AAAAAAA...).' >&2
  exit 2
fi
# Cofre de credenciais (o token do Cloudflare colado no painel): true só no nó com o segredo
# `credentials-key` (`credentials_vault` no Terraform). Sem a linha, vale false: o nó da Verax não muda.
[[ ${CREDENTIALS_VAULT:-false} =~ ^(true|false)$ ]] ||
  { echo 'CREDENTIALS_VAULT inválido em /etc/verax/node.conf: use true ou false.' >&2; exit 2; }
# Agentes do Wazuh nas instâncias do cliente (WAZUH_AGENTS=true; sem a linha, false): só no standard, com o IP fixo de
# entrada dos agentes (`terraform output wazuh_agents`, sem máscara) e o cliente do nó (o id dele no painel, em
# Clientes): os agentes registrados são dele. As faixas de IP liberadas no firewall (as mesmas do Terraform, para o
# painel dizer se a liberação está pronta) e o limite de agentes (padrão 50) são opcionais. O start.sh confere de novo.
[[ ${WAZUH_AGENTS:-false} =~ ^(true|false)$ ]] ||
  { echo 'WAZUH_AGENTS inválido em /etc/verax/node.conf: use true ou false.' >&2; exit 2; }
agents=false
if [[ ${WAZUH_AGENTS:-false} == true ]]; then
  agents=true
  [[ ${NODE_PROFILE:-lean} == standard ]] ||
    { echo 'WAZUH_AGENTS=true só no perfil standard: o Wazuh só existe nele.' >&2; exit 2; }
  ipv4="$octet(\\.$octet){3}"
  [[ ${WAZUH_AGENTS_ADDRESS:-} =~ ^$ipv4$ ]] ||
    { echo 'WAZUH_AGENTS_ADDRESS inválido em /etc/verax/node.conf: use o IP fixo dos agentes (terraform output wazuh_agents), sem máscara.' >&2; exit 2; }
  [[ ${WAZUH_AGENTS_TENANT:-} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    { echo 'WAZUH_AGENTS_TENANT inválido em /etc/verax/node.conf: use o id do cliente do nó (Clientes, no painel).' >&2; exit 2; }
  # Faixas de /16 a /32, como o Terraform aceita em wazuh_agents_sources.
  cidr="$ipv4/(1[6-9]|2[0-9]|3[0-2])"
  if [[ -n ${WAZUH_AGENTS_SOURCES:-} && ! $WAZUH_AGENTS_SOURCES =~ ^$cidr(,$cidr)*$ ]]; then
    echo 'WAZUH_AGENTS_SOURCES inválido em /etc/verax/node.conf: use as faixas de wazuh_agents_sources do Terraform (IPv4 de /16 a /32), separadas por vírgula.' >&2
    exit 2
  fi
  if [[ -n ${WAZUH_AGENTS_MAX:-} ]] && { [[ ! $WAZUH_AGENTS_MAX =~ ^[1-9][0-9]{0,2}$ ]] || ((WAZUH_AGENTS_MAX > 500)); }; then
    echo 'WAZUH_AGENTS_MAX inválido em /etc/verax/node.conf: use um inteiro de 1 a 500.' >&2
    exit 2
  fi
fi
# Modo cliente (CUSTOMER_MODE=true; sem a linha, false): o nó de cliente criado pelo plano de controle, com o primeiro
# acesso pelos metadados da VM (verax-customer-bootstrap.service) e o estado do nó nos guest attributes. O nó da Verax
# não liga, e nada muda nele.
[[ ${CUSTOMER_MODE:-false} =~ ^(true|false)$ ]] ||
  { echo 'CUSTOMER_MODE inválido em /etc/verax/node.conf: use true ou false.' >&2; exit 2; }
customer=false
if [[ ${CUSTOMER_MODE:-false} == true ]]; then customer=true; fi
install -m 0640 "$here/compose.yaml" /opt/verax/compose.yaml
# O complemento do cofre de credenciais fica instalado sempre; o start.sh só o usa com CREDENTIALS_VAULT=true.
install -m 0640 "$here/compose.vault.yaml" /opt/verax/compose.vault.yaml
install -m 0644 "$here/pg_hba.conf" /opt/verax/pg_hba.conf
install -m 0750 "$here/bin/start.sh" "$here/bin/backup.sh" "$here/bin/metadata-guard.sh" /opt/verax/bin/
install -m 0644 "$here"/systemd/*.service "$here"/systemd/*.timer /etc/systemd/system/
# Perfil standard: o Wazuh (o compose.wazuh.yaml, a cópia de infra/wazuh que o deploy.sh põe no pacote, a aplicação da
# configuração do manager com as contas AWS, a renovação do token do Google para a AWS e a limpeza diária dos alertas
# antigos). O nó da Verax (lean) não recebe nada disso.
standard=false
if [[ ${NODE_PROFILE:-lean} == standard ]]; then standard=true; fi
if $standard; then
  [[ -f $here/wazuh/scripts/lib-passwords.sh ]] ||
    { echo 'Falta o Wazuh no pacote (pasta wazuh/): no perfil standard, instale pelo deploy.sh.' >&2; exit 2; }
  install -m 0640 "$here/compose.wazuh.yaml" /opt/verax/compose.wazuh.yaml
  # Os arquivos são montados nos contêineres, e o usuário do indexer (uid 1000) lê alguns: leitura para todos. Nenhum
  # é segredo (estão no repositório).
  rm -rf /opt/verax/wazuh
  cp -R "$here/wazuh" /opt/verax/wazuh
  chown -R root:root /opt/verax/wazuh
  find /opt/verax/wazuh -type d -exec chmod 0755 {} +
  find /opt/verax/wazuh -type f -exec chmod 0644 {} +
  install -m 0750 "$here/bin/wazuh-apply.sh" "$here/bin/wazuh-alerts-cleanup.sh" "$here/bin/aws-token.sh" /opt/verax/bin/
  install -m 0644 "$here"/systemd/wazuh/*.service "$here"/systemd/wazuh/*.timer "$here"/systemd/wazuh/*.path \
    /etc/systemd/system/
  # O verax-node passa a querer (Wants) o verax-wazuh: o restart do nó o sobe de novo mesmo quando ele tinha falhado.
  install -d -m 0755 /etc/systemd/system/verax-node.service.d
  install -m 0644 "$here/systemd/wazuh/verax-node.service.d/wazuh.conf" /etc/systemd/system/verax-node.service.d/wazuh.conf
  # Agentes (WAZUH_AGENTS=true): o terceiro arquivo do Compose (portas 1514 e 1515 do manager), o certificado do
  # registro e a lista dos agentes para o painel, a cada minuto. Sem o interruptor, nada disso é instalado.
  if $agents; then
    install -m 0640 "$here/compose.wazuh-agents.yaml" /opt/verax/compose.wazuh-agents.yaml
    install -m 0750 "$here/bin/wazuh-agents-certs.sh" "$here/bin/wazuh-agents-export.sh" /opt/verax/bin/
    install -m 0644 "$here"/systemd/wazuh-agents/*.service "$here"/systemd/wazuh-agents/*.timer /etc/systemd/system/
  fi
fi
# Modo cliente: o serviço do primeiro acesso e o complemento que o verax-node usa para subi-lo junto (Wants). Sem o
# interruptor, nada disso é instalado; o complemento de uma instalação anterior sai, e o serviço é desativado abaixo.
if $customer; then
  install -m 0644 "$here/systemd/customer/verax-customer-bootstrap.service" /etc/systemd/system/
  install -d -m 0755 /etc/systemd/system/verax-node.service.d
  install -m 0644 "$here/systemd/customer/verax-node.service.d/customer.conf" \
    /etc/systemd/system/verax-node.service.d/customer.conf
elif [[ -f /etc/systemd/system/verax-node.service.d/customer.conf ]]; then
  rm -f /etc/systemd/system/verax-node.service.d/customer.conf
fi

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
# Senhas do Wazuh (standard): admin do indexer, wazuh_filebeat (o filebeat do manager, só escrita dos alertas),
# wazuh-wui da API do manager e o usuário só leitura da API e do worker. O generate() acima só emite letras e dígitos,
# e os componentes do Wazuh exigem também `.` ou `-` (scripts/lib-passwords.sh do pacote do Wazuh, o mesmo formato que
# o start.sh confere a cada partida).
if $standard; then
  # shellcheck source=SCRIPTDIR/../../wazuh/scripts/lib-passwords.sh
  source "$here/wazuh/scripts/lib-passwords.sh"
  generate_wazuh() { # <arquivo>
    local file=/var/lib/verax/secrets/$1 value
    if [[ ! -s $file ]]; then
      value=$(new_wazuh_password)
      printf '%s' "$value" >"$file"
    fi
    chmod 0600 "$file"
  }
  generate_wazuh wazuh-indexer-admin
  generate_wazuh wazuh-indexer-filebeat
  generate_wazuh wazuh-api
  generate_wazuh wazuh-indexer-read
fi
# Agentes: a senha de registro do nó (o authd confere; o painel a mostra só aos administradores), só letras e dígitos
# para caber sem escape no comando de instalação do Linux e do Windows; e o certificado do registro, com o IP fixo dos
# agentes (uma CA só dos agentes, refeita se o IP mudar). Os dois ficam no disco do nó, como as outras senhas internas.
if $agents; then
  generate wazuh-agents-enrollment 32
  echo '== Certificado do registro dos agentes'
  /opt/verax/bin/wazuh-agents-certs.sh /var/lib/verax/wazuh-agents "$WAZUH_AGENTS_ADDRESS"
fi

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
# O Docker baixa do registro com a identidade da VM (só leitura). O GHCR (as mesmas imagens, com o mesmo digest,
# públicas desde o SH-02) é anônimo: o ajudante do gcloud mandaria a credencial do Google para lá, e o pull falharia.
if [[ $IMAGES_REPOSITORY != ghcr.io/* ]]; then
  gcloud auth configure-docker "${IMAGES_REPOSITORY%%/*}" --quiet >/dev/null 2>&1
fi
{
  echo "API_IMAGE=$IMAGES_REPOSITORY/api@$api_digest"
  echo "MIGRATE_IMAGE=$IMAGES_REPOSITORY/migrate@$migrate_digest"
  echo "NODE_VERSION=$version"
  if [[ -n $release ]]; then echo "NODE_RELEASE=$release"; fi
} >/etc/verax/images.env
chmod 0640 /etc/verax/images.env

echo '== Serviços e backup diário'
systemctl daemon-reload
# A guarda do metadata passa a ser exigida pelo Docker (RequiredBy) e roda antes dele a cada boot; agora, com o Docker
# já no ar, ela só entra em vigor (o restart do verax-node a exige).
systemctl enable verax-metadata-guard.service verax-node.service verax-backup.timer >/dev/null
if $standard; then systemctl enable verax-wazuh.service >/dev/null; fi
# Modo cliente: o primeiro acesso sobe com o nó (o restart abaixo o dispara pelo complemento) e a cada boot.
if $customer; then
  systemctl enable verax-customer-bootstrap.service >/dev/null
elif [[ -f /etc/systemd/system/verax-customer-bootstrap.service ]]; then
  systemctl disable verax-customer-bootstrap.service >/dev/null 2>&1 || true
fi
systemctl restart verax-node.service
systemctl start verax-backup.timer
# Standard: o restart do verax-node sobe o verax-wazuh junto (o Wants do drop-in, mesmo se ele tinha falhado); o
# `start` espera o Wazuh ficar saudável (nada acontece a mais se já estiver subindo).
# O token do Google renovado a cada 10 min e a configuração do manager refeita quando o worker grava uma geração nova
# das contas AWS (e a cada 15 min): os dois não fazem nada enquanto o Wazuh não estiver no ar.
if $standard; then
  systemctl start verax-wazuh.service
  systemctl enable --now verax-wazuh-alerts.timer verax-aws-token.timer verax-wazuh-apply.timer \
    verax-wazuh-apply.path >/dev/null
fi
# A lista dos agentes, depois do Wazuh no ar. Desligado o interruptor num nó que já o teve, o timer para (o script, se
# rodar, só apaga a lista da memória).
if $agents; then
  systemctl enable --now verax-wazuh-agents.timer >/dev/null
elif [[ -f /etc/systemd/system/verax-wazuh-agents.timer ]]; then
  systemctl disable --now verax-wazuh-agents.timer >/dev/null 2>&1 || true
fi
systemctl --no-pager --lines=0 status verax-node.service || true
if $standard; then systemctl --no-pager --lines=0 status verax-wazuh.service || true; fi
if $customer; then systemctl --no-pager --lines=0 status verax-customer-bootstrap.service || true; fi
if [[ ! -s /run/verax/cloudflared.env ]]; then
  echo 'AVISO: o nó subiu sem o túnel do Cloudflare (o cofre do token ainda não tem valor). Grave o token e rode:' \
    'sudo systemctl restart verax-node'
fi
echo "Nó na versão $version${release:+ ($release)}."
