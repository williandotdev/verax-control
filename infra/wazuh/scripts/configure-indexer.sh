#!/usr/bin/env bash
# Retenção e snapshots do indexer (T4.9), aplicados a cada deploy, de forma idempotente:
# - repositório de snapshots em disco (verax-snapshots), que o host copia para o S3;
# - política ISM que apaga os índices diários do Wazuh depois de ALERT_RETENTION_DAYS (padrão 90, pendência 6),
#   ligada aos índices novos (ism_template) e aos que já existem;
# - política de Snapshot Management: snapshot diário às 02:00 (Brasília), mantido 14 dias no repositório local.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/lib-indexer.sh
source scripts/lib-indexer.sh

retention=${ALERT_RETENTION_DAYS:-90}
if [[ ! $retention =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "ERRO: ALERT_RETENTION_DAYS deve ser um número de dias (1 a 9999)." >&2
  exit 1
fi

indexer_admin PUT /_snapshot/verax-snapshots <<<'{"type":"fs","settings":{"location":"/mnt/snapshots","compress":true}}'
require_ok "repositório de snapshots"

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
echo "Retenção de $retention dias e snapshot diário configurados."
