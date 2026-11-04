#!/bin/bash
# Apaga os alertas antigos do manager do Wazuh no nó de cliente (verax-wazuh-alerts.timer, perfil standard): os arquivos
# diários compactados de /var/ossec/logs/alerts (`*.gz`) com mais de 7 dias. O Wazuh guarda esses arquivos sem prazo; o
# filebeat lê só o alerts.json do dia, e o que serve para consulta fica no indexer (30 dias) e nos achados do Postgres.
# Roda dentro do contêiner do manager (sem caminho de volume no host). Com o manager parado, não faz nada.
set -euo pipefail

# O projeto do Compose é o do nó; o ci-test troca pelo dele.
project=${COMPOSE_PROJECT_NAME:-verax}
manager=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.service=wazuh.manager)
if [[ -z $manager ]]; then
  echo 'Manager do Wazuh parado: nada a apagar.'
  exit 0
fi
# 7 dias em minutos: -mtime arredonda para dias inteiros.
removed=$(docker exec "$manager" find /var/ossec/logs/alerts -type f -name '*.gz' -mmin +10080 -print -delete | wc -l)
echo "Alertas antigos do Wazuh apagados: $removed arquivo(s)."
