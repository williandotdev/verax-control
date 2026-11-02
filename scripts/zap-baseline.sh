#!/usr/bin/env bash
# Varredura passiva do OWASP ZAP (baseline) com bloqueio por risco alto (T8.7). Roda contra a stack local no CI
# (scripts/test-api-image.sh) e contra o staging publicado (deploy.yml).
#
# Uso: scripts/zap-baseline.sh <url> [rede Docker]
# Achados de risco médio e baixo aparecem no relatório, mas só os de risco alto reprovam. O relatório JSON fica em
# $ZAP_REPORT_DIR (padrão: um diretório temporário), para o CI guardar como artefato.
set -euo pipefail

target=${1:?informe a URL}
network=${2:-}
zap_image=zaproxy/zap-stable@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238

report_dir=${ZAP_REPORT_DIR:-$(mktemp -d)}
mkdir -p "$report_dir"
# O ZAP roda como o usuário zap (uid 1000) e grava o relatório no diretório montado.
chmod 0777 "$report_dir"

args=(--rm -v "$report_dir:/zap/wrk:rw")
if [[ -n $network ]]; then args+=(--network "$network"); fi

# -I: avisos não interrompem o ZAP; o critério de bloqueio é o risco, conferido abaixo. Código 3 é erro do ZAP.
code=0
docker run "${args[@]}" "$zap_image" zap-baseline.py -t "$target" -J report.json -I >/dev/null 2>&1 || code=$?
if [[ $code == 3 || ! -s $report_dir/report.json ]]; then
  echo "ERRO: o ZAP não conseguiu varrer $target (código $code)." >&2
  exit 1
fi

# python3 no Linux (CI); no Windows, o "python3" pode ser só o atalho da loja, então cai para "python".
python=python3
if ! python3 -c '' 2>/dev/null; then python=python; fi
report=$report_dir/report.json
if command -v cygpath >/dev/null; then report=$(cygpath -w "$report"); fi
"$python" - "$report" "$target" <<'PY'
import json
import sys

report, target = sys.argv[1], sys.argv[2]
alerts = [alert for site in json.load(open(report, encoding="utf-8")).get("site", []) for alert in site.get("alerts", [])]
by_risk = {}
for alert in alerts:
    by_risk.setdefault(alert.get("riskcode"), []).append(alert)
names = {"3": "alto", "2": "médio", "1": "baixo", "0": "informativo"}
summary = ", ".join(f"{len(by_risk.get(code, []))} {names[code]}" for code in ("3", "2", "1", "0"))
print(f"ZAP em {target}: {summary}")
for code in ("3", "2"):
    for alert in by_risk.get(code, []):
        print(f"  [{names[code]}] {alert.get('pluginid')} {alert.get('alert')}")
sys.exit(1 if by_risk.get("3") else 0)
PY
