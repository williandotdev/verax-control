#!/usr/bin/env bash
# Aplica no indexer a configuração de segurança gerada pelo security-init (usuários, papéis e mapeamentos), pelo
# securityadmin da própria imagem, com o certificado admin, que só o contêiner do indexer tem: nenhuma senha passa por
# aqui. Na primeira subida o índice de segurança já nasce dos arquivos; nas seguintes, é aqui que senhas, papéis e
# mapeamentos novos entram. A configuração inteira é reaplicada: os arquivos são a única fonte.
#
# Usado pelo deploy.sh (EC2), pelo start.sh do nó de cliente e pelo ci-test.sh. Fala com o projeto do Compose que estiver
# em vigor: o da pasta (EC2) ou o das variáveis COMPOSE_* (nó e CI).
set -euo pipefail

# shellcheck disable=SC2016 # expandido pelo bash do contêiner
if ! output=$(docker compose exec -T wazuh.indexer bash -c '
  export JAVA_HOME=/usr/share/wazuh-indexer/jdk
  certs=/usr/share/wazuh-indexer/config/certs
  bash /usr/share/wazuh-indexer/plugins/opensearch-security/tools/securityadmin.sh \
    -cd /usr/share/wazuh-indexer/config/opensearch-security/ \
    -icl -h wazuh.indexer -p 9200 \
    -cacert "$certs/root-ca.pem" -cert "$certs/admin.pem" -key "$certs/admin-key.pem"' 2>&1); then
  echo "$output" >&2
  exit 1
fi
echo "Configuração de segurança aplicada no indexer."
