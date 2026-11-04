#!/bin/bash
# Testa a guarda do servidor de metadados (bin/metadata-guard.sh) num espaço de nomes de rede próprio, sem tocar nas
# regras da máquina: no CI, `sudo unshare -n bash tests/metadata-guard-test.sh`; localmente, num contêiner com
# NET_ADMIN e o iptables instalado. Cenários: antes do Docker (sem DOCKER-USER), de novo com tudo já no lugar
# (idempotente), a regra antiga só de NODE_SUBNET removida e, com a cadeia já em uso, a troca sem instante vazio: o
# conteúdo da cadeia entra numa transação só, então uma regra estranha posta nela some junto com o resto, e o DROP
# está lá em toda leitura.
set -euo pipefail
cd "$(dirname "$0")/.."

failures=0
expect() { # <descrição> <esperado (regex)> <obtido>
  if [[ $3 =~ ^($2)$ ]]; then
    printf 'ok     %s\n' "$1"
  else
    printf 'FALHA  %s (esperado %s, obtido %s)\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

chain_rules() { iptables -S VERAX-METADATA | grep -c '^-A' || true; }
chain_order() { iptables -S VERAX-METADATA | grep '^-A' | sed 's/^-A VERAX-METADATA //' | tr '\n' ';'; }
user_jumps() { iptables -S DOCKER-USER | grep -c 'VERAX-METADATA' || true; }

expected_order='-s 172.30.53.10/32 -j RETURN;-p udp -m udp --dport 53 -j RETURN;-p tcp -m tcp --dport 53 -j RETURN;-j DROP;'

echo "== Antes do Docker: sem DOCKER-USER"
expect "DOCKER-USER ainda não existe" 1 "$(iptables -S DOCKER-USER >/dev/null 2>&1 && echo 0 || echo 1)"
bash bin/metadata-guard.sh
expect "cadeia com as quatro regras, na ordem (worker, DNS, DROP)" "$expected_order" "$(chain_order)"
expect "um salto no DOCKER-USER, sem filtro de origem" '-A DOCKER-USER -d 169.254.169.254/32 -j VERAX-METADATA' \
  "$(iptables -S DOCKER-USER | grep VERAX-METADATA)"

echo "== O Docker subiu (RETURN no fim do DOCKER-USER) e a partida reaplica a guarda"
iptables -A DOCKER-USER -j RETURN
bash bin/metadata-guard.sh
expect "mesmas quatro regras" "$expected_order" "$(chain_order)"
expect "um salto só" 1 "$(user_jumps)"
expect "salto antes do RETURN do Docker" '-A DOCKER-USER -d 169.254.169.254/32 -j VERAX-METADATA;-A DOCKER-USER -j RETURN;' \
  "$(iptables -S DOCKER-USER | grep '^-A' | tr '\n' ';')"

echo "== Nó atualizado: a regra antiga (só de NODE_SUBNET) sai depois que a nova entra"
iptables -A DOCKER-USER -s 172.30.53.0/24 -d 169.254.169.254 -j VERAX-METADATA
bash bin/metadata-guard.sh
expect "regra antiga removida" 0 "$(iptables -S DOCKER-USER | grep -c -- '-s 172.30.53.0/24' || true)"
expect "um salto só" 1 "$(user_jumps)"

echo "== Troca atômica: a cadeia em uso é esvaziada e preenchida num commit"
# Uma regra a mais na cadeia (como ficaria depois de uma falha no meio de uma edição regra a regra): some com o resto.
iptables -I VERAX-METADATA 1 -s 192.0.2.1 -j RETURN
bash bin/metadata-guard.sh
expect "a regra estranha saiu junto com o resto" "$expected_order" "$(chain_order)"
expect "quatro regras, e não oito" 4 "$(chain_rules)"
# A guarda nunca é vista pela metade: o script só muda a cadeia pelo iptables-restore (uma transação), nunca por
# -F/-A soltos no iptables.
expect "nenhum -F ou -A solto no iptables (só na transação do restore)" 0 \
  "$(grep -cE "^\s*iptables -(F|A|D) \"?[$]chain" bin/metadata-guard.sh || true)"

if ((failures > 0)); then
  echo "$failures verificação(ões) falharam." >&2
  exit 1
fi
echo "Guarda do metadata: todas as verificações passaram."
