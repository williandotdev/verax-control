#!/usr/bin/env bash
# Aplica no Firestore do projeto os índices compostos (firestore.indexes.json) e as políticas de TTL
# (firestore.ttl.json) do plano de controle, de forma idempotente: índice que já existe (pronto ou em criação) é
# pulado; política de TTL já ativa é pulada; o resto é criado em segundo plano (--async), e a implantação não
# espera o índice ficar pronto. Rodado pelo workflow plano-controle.yml depois do login na GCP; serve também na
# máquina do responsável, com o gcloud autenticado.
#
# Uso: scripts/firestore-apply.sh <projeto> [banco]      (padrão do banco: "(default)"; precisa de gcloud e jq)
set -euo pipefail

project=${1:?informe o projeto da GCP}
database=${2:-'(default)'}
dir=$(cd "$(dirname "$0")/.." && pwd)
indexes_file=$dir/firestore.indexes.json
ttl_file=$dir/firestore.ttl.json

# Assinatura de um índice: grupo de coleção e campos na ordem, para comparar o desejado com o existente.
signature='"\(.collectionGroup)|" + ([.fields[] | "\(.fieldPath):\(.order)"] | join(","))'

echo "== Índices compostos (projeto $project, banco $database)"
existing=$(gcloud firestore indexes composite list --project "$project" --database "$database" --format json |
  jq -r "[.[] | select(.state != \"NEEDS_REPAIR\") | {collectionGroup: (.name | split(\"/collectionGroups/\")[1] | split(\"/\")[0]), fields: [.fields[] | select(.fieldPath != \"__name__\")]} | $signature] | .[]")
while IFS= read -r wanted; do
  [ -n "$wanted" ] || continue
  if grep -qxF "$wanted" <<<"$existing"; then
    echo "ok     $wanted (já existe)"
    continue
  fi
  group=${wanted%%|*}
  args=()
  IFS=',' read -ra fields <<<"${wanted#*|}"
  for field in "${fields[@]}"; do
    path=${field%%:*}
    order=$(tr '[:upper:]' '[:lower:]' <<<"${field#*:}")
    args+=(--field-config "field-path=$path,order=$order")
  done
  gcloud firestore indexes composite create --project "$project" --database "$database" \
    --collection-group "$group" --query-scope collection "${args[@]}" --async --quiet >/dev/null
  echo "criado $wanted (em segundo plano)"
done < <(jq -r ".indexes[] | $signature" "$indexes_file")

echo "== Políticas de TTL"
while IFS=$'\t' read -r group field; do
  [ -n "$group" ] || continue
  state=$(gcloud firestore fields ttls list --project "$project" --database "$database" --collection-group "$group" \
    --format json | jq -r --arg field "$field" '.[] | select(.name | endswith("/fields/" + $field)) | .ttlConfig.state // empty')
  if [ "$state" = "ACTIVE" ] || [ "$state" = "CREATING" ]; then
    echo "ok     $group.$field ($state)"
    continue
  fi
  gcloud firestore fields ttls update "$field" --project "$project" --database "$database" \
    --collection-group "$group" --enable-ttl --async --quiet >/dev/null
  echo "ligado $group.$field (em segundo plano)"
done < <(jq -r '.fields[] | "\(.collectionGroup)\t\(.field)"' "$ttl_file")
