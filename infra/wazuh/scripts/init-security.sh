#!/usr/bin/env bash
# Gera o internal_users.yml do indexer (T4.2). Roda no serviço `security-init` da compose, com a imagem do
# indexer e sem rede, a cada `deploy.sh`.
#
# Ficam só `admin` e `kibanaserver`, com hash bcrypt das senhas recebidas por variável de ambiente. Os usuários
# de demonstração da imagem (kibanaro, logstash, readall, snapshotrestore), de senha pública, deixam de existir.
set -euo pipefail
umask 077

security_dir=/usr/share/wazuh-indexer/config/opensearch-security
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

sed -e "s|__ADMIN_HASH__|$admin_hash|" -e "s|__DASHBOARD_HASH__|$dashboard_hash|" \
  /verax/internal_users.yml.tmpl >"$security_dir/internal_users.yml.new"
mv "$security_dir/internal_users.yml.new" "$security_dir/internal_users.yml"
echo "internal_users.yml gerado (admin e kibanaserver)."
