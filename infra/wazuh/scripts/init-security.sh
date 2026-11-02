#!/usr/bin/env bash
# Gera a configuração de segurança do indexer (T4.2 e T4.8). Roda no serviço `security-init` da compose, com a
# imagem do indexer, sem rede, a cada deploy.
#
# Parte sempre dos arquivos originais da imagem (nunca do que já está no volume), para o resultado depender só da
# imagem, do bundle e das senhas:
# - internal_users.yml: só `admin`, `kibanaserver` e `verax_api_read`, com hash bcrypt das senhas recebidas por
#   variável de ambiente. Os usuários de demonstração da imagem, de senha pública, deixam de existir;
# - roles.yml: os papéis da imagem mais o `verax_api_read` (só leitura em wazuh-alerts-*);
# - roles_mapping.yml: o mapeamento mínimo do bundle, sem os mapeamentos de demonstração.
set -euo pipefail
umask 077

image_dir=/usr/share/wazuh-indexer/config/opensearch-security
out=/out/security
hash_tool=/usr/share/wazuh-indexer/plugins/opensearch-security/tools/hash.sh
export JAVA_HOME=/usr/share/wazuh-indexer/jdk

# O hash.sh lê a senha da variável cujo NOME recebe (-env), então ela não aparece na lista de processos.
# Sem rede, o Java avisa (com stack trace) que não resolve o próprio hostname; o hash sai correto mesmo assim.
# O stderr só é mostrado se o resultado não for um bcrypt válido.
bcrypt() {
  local hash errors
  errors=$(mktemp)
  hash=$(bash "$hash_tool" -env "$1" 2>"$errors" | tail -n 1)
  if [[ ! $hash =~ ^\$2[aby]\$12\$[./A-Za-z0-9]{53}$ ]]; then
    echo "ERRO: hash inesperado para $1" >&2
    cat "$errors" >&2
    exit 1
  fi
  rm -f "$errors"
  printf '%s' "$hash"
}

admin_hash=$(bcrypt INDEXER_ADMIN_PASSWORD)
dashboard_hash=$(bcrypt INDEXER_DASHBOARD_PASSWORD)
api_read_hash=$(bcrypt INDEXER_API_READ_PASSWORD)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$image_dir"/*.yml "$work/"
sed -e "s|__ADMIN_HASH__|$admin_hash|" -e "s|__DASHBOARD_HASH__|$dashboard_hash|" \
  -e "s|__API_READ_HASH__|$api_read_hash|" /verax/internal_users.yml.tmpl >"$work/internal_users.yml"
# Quebra de linha antes: o arquivo da imagem pode não terminar com uma.
{
  echo
  cat /verax/roles-verax.yml
} >>"$work/roles.yml"
cp /verax/roles_mapping.yml "$work/roles_mapping.yml"

# O indexer roda como uid 1000: só ele lê a configuração.
install -d -m 0700 -o 1000 -g 1000 "$out"
install -m 0600 -o 1000 -g 1000 "$work"/*.yml "$out/"
# Repositório de snapshots (T4.9): também só do indexer.
install -d -m 0700 -o 1000 -g 1000 /out/snapshots
echo "Configuração de segurança do indexer gerada (admin, kibanaserver e verax_api_read)."
