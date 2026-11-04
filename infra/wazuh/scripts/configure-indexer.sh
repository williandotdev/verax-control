#!/usr/bin/env bash
# Retenção, shards e snapshots do indexer (T4.9 e fase 2, PR-W1), aplicados a cada deploy, de forma idempotente:
# - repositório de snapshots em disco (verax-snapshots); só no EC2 o host o copia para o S3;
# - template dos índices diários de alertas com 1 shard e nenhuma réplica (nó único);
# - política ISM que apaga os índices diários do Wazuh depois de ALERT_RETENTION_DAYS (padrão 30, decisão D-6 da
#   fase 2: os achados ficam no Postgres pelo prazo do plano, e só o evento bruto do detalhe expira), ligada aos
#   índices novos (ism_template) e aos que já existem;
# - política de Snapshot Management: snapshot diário às 02:00 (Brasília), mantido 7 dias no repositório local.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/lib-indexer.sh
source scripts/lib-indexer.sh

retention=${ALERT_RETENTION_DAYS:-30}
if [[ ! $retention =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "ERRO: ALERT_RETENTION_DAYS deve ser um número de dias (1 a 9999)." >&2
  exit 1
fi

indexer_admin PUT /_snapshot/verax-snapshots <<<'{"type":"fs","settings":{"location":"/mnt/snapshots","compress":true}}'
require_ok "repositório de snapshots"

# O template do Wazuh (legado, order 0, instalado pelo filebeat do manager) cria cada índice diário com 3 shards. Este,
# de order 1, vale por cima dele só nos alertas: 1 shard por dia, 30 no total, longe da regra prática de até 25 shards
# por GiB de heap. Legado de propósito: um template composto que casasse com o índice faria o do Wazuh (os mapeamentos
# dos campos) ser ignorado.
template='{"order":1,"index_patterns":["wazuh-alerts-4.x-*"],'
template+='"settings":{"index.number_of_shards":1,"index.number_of_replicas":0}}'
indexer_admin PUT /_template/verax-alertas <<<"$template"
require_ok "template dos alertas (1 shard)"

# upsert <descrição> <caminho> <método de criação> <corpo>: cria, ou atualiza com controle de concorrência.
# Devolve 0 se criou e 1 se atualizou.
upsert() {
  local label=$1 path=$2 create_method=$3 body=$4 seq term
  indexer_admin GET "$path" </dev/null
  if [[ $response_code == 404 ]]; then
    indexer_admin "$create_method" "$path" <<<"$body"
    require_ok "$label (criação)"
    return 0
  fi
  require_ok "$label (leitura)"
  seq=$(grep -oE '"_seq_no":[0-9]+' <<<"$response_body" | head -n 1 | cut -d: -f2)
  term=$(grep -oE '"_primary_term":[0-9]+' <<<"$response_body" | head -n 1 | cut -d: -f2)
  indexer_admin PUT "$path?if_seq_no=$seq&if_primary_term=$term" <<<"$body"
  require_ok "$label (atualização)"
  return 1
}

patterns='wazuh-alerts-*,wazuh-monitoring-*,wazuh-statistics-*'
if upsert "política de retenção" /_plugins/_ism/policies/verax-retencao PUT \
  "$(sed "s/__RETENTION_DAYS__/$retention/" config/indexer/ism-retention.json)"; then
  # Política nova: os índices que já existiam também passam a segui-la (os novos entram pelo ism_template).
  indexer_admin POST "/_plugins/_ism/add/$patterns" <<<'{"policy_id":"verax-retencao"}'
else
  # Política atualizada: os índices que já a seguem passam para a versão nova.
  indexer_admin POST "/_plugins/_ism/change_policy/$patterns" <<<'{"policy_id":"verax-retencao"}'
fi
require_ok "retenção nos índices existentes"

upsert "snapshot diário" /_plugins/_sm/policies/verax-diario POST "$(cat config/indexer/sm-daily.json)" || true
echo "Retenção de $retention dias, 1 shard por índice de alertas e snapshot diário configurados."
