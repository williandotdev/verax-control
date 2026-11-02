#!/usr/bin/env bash
# Restaura índices do Wazuh a partir de um snapshot (T4.9). Roteiro completo no README ("Restaurar o backup").
#
# Uso: restore-snapshot.sh [--from-s3] [--rename] <snapshot|latest> [índices]
#   --from-s3  antes, traz o repositório do bucket de backup para o disco (só no EC2; lê /etc/verax-wazuh/backup.env)
#   --rename   restaura como restaurado-<índice>, sem tocar nos índices atuais (fora da política de retenção)
#   índices    padrão: wazuh-alerts-*
# Sem --rename, nenhum índice de mesmo nome pode estar aberto: o script não apaga nem fecha nada.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/lib-indexer.sh
source scripts/lib-indexer.sh

from_s3=false rename=false
while [[ ${1:-} == --* ]]; do
  case $1 in
    --from-s3) from_s3=true ;;
    --rename) rename=true ;;
    *)
      echo "ERRO: opção desconhecida $1" >&2
      exit 2
      ;;
  esac
  shift
done
snapshot=${1:?informe o snapshot (ou latest)}
indices=${2:-wazuh-alerts-*}
if [[ ! $snapshot =~ ^[a-z0-9._-]+$ || ! $indices =~ ^[a-z0-9*,._-]+$ ]]; then
  echo "ERRO: nome de snapshot ou padrão de índices inválido." >&2
  exit 2
fi

if $from_s3; then
  # shellcheck source=/dev/null
  source /etc/verax-wazuh/backup.env
  repository=/data/docker/volumes/verax-wazuh_indexer-snapshots/_data
  echo "Trazendo o repositório de s3://$BACKUP_BUCKET/indexer-snapshots/"
  aws s3 sync --only-show-errors --region "$AWS_REGION" "s3://$BACKUP_BUCKET/indexer-snapshots/" "$repository/"
  chown -R 1000:1000 "$repository"
fi

if [[ $snapshot == latest ]]; then
  indexer_admin GET '/_cat/snapshots/verax-snapshots?h=id&s=end_epoch' </dev/null
  require_ok "lista de snapshots"
  snapshot=$(grep -E '^[a-z0-9._-]+$' <<<"$response_body" | tail -n 1 || true)
  if [[ -z $snapshot ]]; then
    echo "ERRO: nenhum snapshot no repositório." >&2
    exit 1
  fi
fi

body="{\"indices\":\"$indices\",\"include_global_state\":false,\"include_aliases\":false"
if $rename; then
  # shellcheck disable=SC2016 # o $1 é do OpenSearch (grupo da expressão), não do shell
  body+=',"rename_pattern":"(.+)","rename_replacement":"restaurado-$1"'
fi
body+='}'

echo "Restaurando $indices do snapshot $snapshot$($rename && echo ' com o prefixo restaurado-')"
indexer_admin POST "/_snapshot/verax-snapshots/$snapshot/_restore?wait_for_completion=true" <<<"$body"
require_ok "restauração"
shards=$(grep -oE '"shards":\{[^}]*\}' <<<"$response_body" || true)
if [[ $shards != *'"failed":0'* ]]; then
  echo "ERRO: restauração com falhas: $shards" >&2
  exit 1
fi
echo "Restauração concluída: $shards"
